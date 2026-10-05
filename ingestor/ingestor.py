"""Ingestion MQTT (TLS) -> PostgreSQL pour SENTINEL-X.

- Thread réseau paho (loop_start) : reçoit, horodate (received_at) et met en file.
- Thread principal : valide puis écrit en base ; en cas de panne PostgreSQL il
  réessaie le même message avec backoff sans bloquer le keepalive MQTT.
- Session persistante (clean_session=False) : les messages QoS 1 (alertes,
  status, vision) sont conservés par le broker pendant un redémarrage de l'ingestor.
- /tmp/healthy est touché tant que MQTT est connecté et que la base répond.
"""
import json
import logging
import os
import pathlib
import queue
import signal
import ssl
import threading
import time
from datetime import datetime, timezone

import paho.mqtt.client as mqtt
import psycopg
from psycopg.types.json import Jsonb

from validation import ValidationError, validate

log = logging.getLogger("ingestor")

MQTT_HOST = os.environ.get("MQTT_HOST", "mosquitto")
MQTT_PORT = int(os.environ.get("MQTT_PORT", "8883"))
MQTT_CAFILE = os.environ.get("MQTT_CAFILE", "/certs/ca.crt")
MQTT_USER = os.environ.get("MQTT_USERNAME", "ingestor")
MQTT_PASS = os.environ["MQTT_PASSWORD"]
QUEUE_MAX = int(os.environ.get("QUEUE_MAX", "1000"))
STATS_EVERY_S = int(os.environ.get("STATS_EVERY_S", "300"))
HEALTH_FILE = pathlib.Path(os.environ.get("HEALTH_FILE", "/tmp/healthy"))

SUBSCRIPTIONS = [
    ("sentinel/+/telemetry", 0),
    ("sentinel/+/alerts", 1),
    ("sentinel/+/status", 1),
    ("sentinel/vision/events", 1),
]

SQL_TOUCH_DEVICE = """
INSERT INTO devices (device_id, last_seen, state) VALUES (%s, %s, 'online')
ON CONFLICT (device_id) DO UPDATE SET last_seen = EXCLUDED.last_seen, state = 'online'"""
SQL_STATUS = """
INSERT INTO devices (device_id, last_seen, state, ip, fw_version) VALUES (%s, %s, %s, %s, %s)
ON CONFLICT (device_id) DO UPDATE SET last_seen = EXCLUDED.last_seen, state = EXCLUDED.state,
    ip = COALESCE(EXCLUDED.ip, devices.ip), fw_version = COALESCE(EXCLUDED.fw_version, devices.fw_version)"""
SQL_ENSURE_DEVICE = "INSERT INTO devices (device_id) VALUES (%s) ON CONFLICT DO NOTHING"
SQL_READING = """
INSERT INTO sensor_readings (device_id, ts, received_at, seq, temperature_c, humidity_pct,
                             gas_raw, motion, rssi_dbm, uptime_s)
VALUES (%s, to_timestamp(%s), %s, %s, %s, %s, %s, %s, %s, %s)"""
SQL_ALERT = """
INSERT INTO alerts (device_id, ts, received_at, type, severity, value, threshold, message, payload)
VALUES (%s, to_timestamp(%s), %s, %s, %s, %s, %s, %s, %s)"""
SQL_VISION = """
INSERT INTO vision_events (ts, received_at, label, confidence, bbox, frame_w, frame_h, snapshot_path)
VALUES (to_timestamp(%s), %s, %s, %s, %s, %s, %s, %s)"""


class Ingestor:
    def __init__(self):
        self.inbox = queue.Queue(maxsize=QUEUE_MAX)
        self.stop = threading.Event()
        self.mqtt_ok = threading.Event()
        self.db = None
        self.last_db_ok = 0.0
        self.stats = {"received": 0, "stored": 0, "rejected": 0, "dropped": 0}

        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="sentinel-ingestor",
                                  clean_session=False, protocol=mqtt.MQTTv311)
        self.client.username_pw_set(MQTT_USER, MQTT_PASS)
        # Vérifie la chaîne (CA interne) ET le nom d'hôte (SAN "mosquitto").
        self.client.tls_set(ca_certs=MQTT_CAFILE, tls_version=ssl.PROTOCOL_TLS_CLIENT)
        self.client.reconnect_delay_set(min_delay=1, max_delay=60)
        self.client.on_connect = self.on_connect
        self.client.on_disconnect = self.on_disconnect
        self.client.on_message = self.on_message

    # --- Thread réseau MQTT --------------------------------------------------
    def on_connect(self, client, _userdata, _flags, reason_code, _props):
        if reason_code.is_failure:
            log.error("connexion MQTT refusée: %s", reason_code)
            return
        log.info("connecté à mqtts://%s:%d", MQTT_HOST, MQTT_PORT)
        client.subscribe(SUBSCRIPTIONS)
        self.mqtt_ok.set()

    def on_disconnect(self, _client, _userdata, _flags, reason_code, _props):
        self.mqtt_ok.clear()
        if not self.stop.is_set():
            log.warning("déconnecté du broker (%s), reconnexion automatique", reason_code)

    def on_message(self, _client, _userdata, msg):
        self.stats["received"] += 1
        try:
            self.inbox.put_nowait((msg.topic, msg.payload, datetime.now(timezone.utc)))
        except queue.Full:
            self.stats["dropped"] += 1
            log.error("file pleine (%d), message perdu sur %s", QUEUE_MAX, msg.topic)

    # --- Base de données ---------------------------------------------------------
    def db_conn(self):
        if self.db is None or self.db.closed:
            # Paramètres libpq via l'environnement : PGHOST, PGDATABASE, PGUSER, PGPASSWORD.
            self.db = psycopg.connect(autocommit=True, connect_timeout=5, application_name="ingestor")
            log.info("connecté à PostgreSQL %s/%s", os.environ.get("PGHOST"), os.environ.get("PGDATABASE"))
        return self.db

    def store(self, kind, device_id, d, raw, received_at):
        conn = self.db_conn()
        with conn.transaction():
            if kind == "telemetry":
                conn.execute(SQL_TOUCH_DEVICE, (device_id, received_at))
                conn.execute(SQL_READING, (device_id, d["ts"], received_at, d["seq"], d["temperature_c"],
                                           d["humidity_pct"], d["gas_raw"], d["motion"], d["rssi_dbm"],
                                           d["uptime_s"]))
            elif kind == "status":
                conn.execute(SQL_STATUS, (device_id, received_at, d["state"], d["ip"], d["fw"]))
            elif kind == "alerts":
                conn.execute(SQL_ENSURE_DEVICE, (device_id,))
                conn.execute(SQL_ALERT, (device_id, d["ts"], received_at, d["type"], d["severity"],
                                         d["value"], d["threshold"], d["message"], Jsonb(raw)))
            else:
                conn.execute(SQL_VISION, (d["ts"], received_at, d["label"], d["confidence"], Jsonb(d["bbox"]),
                                          d["frame_w"], d["frame_h"], d["snapshot_path"]))
        self.last_db_ok = time.monotonic()

    def handle(self, topic, payload, received_at):
        try:
            kind, device_id, data, raw = validate(topic, payload)
        except ValidationError as exc:
            self.stats["rejected"] += 1
            log.warning("rejeté %s: %s | %r", topic, exc, payload[:200])
            return
        delay = 1
        while not self.stop.is_set():
            try:
                self.store(kind, device_id, data, raw, received_at)
                self.stats["stored"] += 1
                return
            except psycopg.OperationalError as exc:
                log.error("PostgreSQL indisponible (%s), nouvel essai dans %ds", str(exc).strip(), delay)
                if self.db is not None:
                    self.db.close()
                self.stop.wait(delay)
                delay = min(delay * 2, 30)
            except psycopg.Error as exc:
                # Erreur de données (contrainte, FK...) : on ne bloque pas la file pour un message.
                self.stats["rejected"] += 1
                log.warning("rejeté par la base %s: %s | %r", topic, exc.diag.message_primary or exc, payload[:200])
                return

    def heartbeat(self):
        now = time.monotonic()
        if now - self.last_db_ok > 30:
            try:
                self.db_conn().execute("SELECT 1")
                self.last_db_ok = now
            except psycopg.Error as exc:
                log.error("ping PostgreSQL en échec: %s", str(exc).strip())
                if self.db is not None:
                    self.db.close()
                return
        if self.mqtt_ok.is_set():
            HEALTH_FILE.touch()

    def run(self):
        self.client.connect_async(MQTT_HOST, MQTT_PORT, keepalive=60)
        self.client.loop_start()
        next_stats = time.monotonic() + STATS_EVERY_S
        while not self.stop.is_set():
            try:
                self.handle(*self.inbox.get(timeout=5))
            except queue.Empty:
                pass
            self.heartbeat()
            if time.monotonic() >= next_stats:
                log.info("stats %s file=%d", json.dumps(self.stats), self.inbox.qsize())
                next_stats += STATS_EVERY_S
        self.client.disconnect()
        self.client.loop_stop()
        if self.db is not None:
            self.db.close()
        log.info("arrêt propre")


def main():
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    app = Ingestor()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: app.stop.set())
    app.run()


if __name__ == "__main__":
    main()
