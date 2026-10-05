"""Pont MQTT de l'API (compte « api », MQTTS).

- Décision d'accès RFID : écoute sentinel/access, vérifie le badge en base, journalise,
  répond sur sentinel/access/response (03_SPECIFICATION § 2.C). Un badge inconnu ou
  révoqué crée aussi une alerte UNAUTHORIZED_ACCESS.
- Publication des commandes superviseur sur sentinel/commands.
Le traitement des messages se fait dans un thread dédié pour ne pas bloquer le keepalive MQTT.
"""
import json
import logging
import ssl
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import paho.mqtt.client as mqtt
from psycopg.types.json import Jsonb
from pydantic import ValidationError

from . import config
from .db import SQL_ENSURE_DEVICE, pool
from .models import AccessScan, resolve_ts

log = logging.getLogger("api.mqtt")

SQL_BADGE = """SELECT user_name, clearance_level, auto_unlock_door FROM badges
               WHERE card_uid = %s AND active"""
SQL_ACCESS_EVENT = """
INSERT INTO access_events (node_id, ts, device_timestamp, received_at, card_uid, card_type, door_id,
                           access_granted, user_name, clearance_level)
VALUES (%s, to_timestamp(%s), %s, %s, %s, %s, %s, %s, %s, %s)"""
SQL_DENIED_ALERT = """
INSERT INTO alerts (node_id, ts, device_timestamp, received_at, event_type, severity, source_sensor,
                    details, channel, payload)
VALUES (%s, to_timestamp(%s), %s, %s, 'UNAUTHORIZED_ACCESS', 'WARNING', 'RFID_RC522', %s, 'server', %s)"""
SQL_LOG_COMMAND = "INSERT INTO commands (topic, action, payload) VALUES (%s, %s, %s) RETURNING id"


class MqttBridge:
    def __init__(self):
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="sentinel-api",
                                  clean_session=False, protocol=mqtt.MQTTv311)
        self.client.username_pw_set(config.MQTT_USERNAME, config.MQTT_PASSWORD)
        self.client.reconnect_delay_set(min_delay=1, max_delay=60)
        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect
        self.client.on_message = self._on_message
        self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="access")

    # --- Cycle de vie ---------------------------------------------------------------
    def start(self):
        # Vérifie la chaîne (CA interne) ET le nom d'hôte (SAN "mosquitto").
        self.client.tls_set(ca_certs=config.MQTT_CAFILE, tls_version=ssl.PROTOCOL_TLS_CLIENT)
        self.client.connect_async(config.MQTT_HOST, config.MQTT_PORT, keepalive=60)
        self.client.loop_start()

    def stop(self):
        self.client.disconnect()
        self.client.loop_stop()
        self.worker.shutdown(wait=True, cancel_futures=False)

    @property
    def connected(self) -> bool:
        return self.client.is_connected()

    def _on_connect(self, client, _userdata, _flags, reason_code, _props):
        if reason_code.is_failure:
            log.error("connexion MQTT refusée: %s", reason_code)
            return
        log.info("connecté à mqtts://%s:%d", config.MQTT_HOST, config.MQTT_PORT)
        client.subscribe(config.TOPIC_ACCESS, qos=1)

    def _on_disconnect(self, _client, _userdata, _flags, reason_code, _props):
        log.warning("déconnecté du broker (%s), reconnexion automatique", reason_code)

    def _on_message(self, _client, _userdata, msg):
        received_at = datetime.now(timezone.utc)
        self.worker.submit(self._safe_handle_access, msg.payload, received_at)

    # --- Publication --------------------------------------------------------------------
    def publish(self, topic: str, payload: dict, action: str | None) -> int:
        """Journalise puis publie (QoS 1). Lève RuntimeError si le broker est injoignable."""
        if not self.connected:
            raise RuntimeError("broker MQTT injoignable")
        with pool.connection() as conn:
            command_id = conn.execute(SQL_LOG_COMMAND, (topic, action, Jsonb(payload))).fetchone()["id"]
        info = self.client.publish(topic, json.dumps(payload, separators=(",", ":")), qos=1)
        info.wait_for_publish(timeout=5)
        if not info.is_published():
            raise RuntimeError("publication MQTT non confirmée")
        return command_id

    # --- Décision d'accès RFID --------------------------------------------------------------
    def _safe_handle_access(self, payload: bytes, received_at: datetime):
        try:
            self.handle_access(payload, received_at)
        except Exception:  # un message ne doit jamais tuer le thread
            log.exception("échec du traitement d'un passage de badge")

    def handle_access(self, payload: bytes, received_at: datetime):
        try:
            scan = AccessScan.model_validate_json(payload)
        except ValidationError as exc:
            log.warning("rejeté sentinel/access: %s | %r", exc.errors(include_url=False), payload[:200])
            return
        ts = resolve_ts(scan.timestamp, received_at.timestamp())
        with pool.connection() as conn, conn.transaction():
            conn.execute(SQL_ENSURE_DEVICE, (scan.node_id,))
            badge = conn.execute(SQL_BADGE, (scan.card_uid,)).fetchone()
            granted = badge is not None
            conn.execute(SQL_ACCESS_EVENT, (
                scan.node_id, ts, scan.timestamp, received_at, scan.card_uid, scan.card_type, scan.door_id,
                granted, badge and badge["user_name"], badge and badge["clearance_level"]))
            if not granted:
                conn.execute(SQL_DENIED_ALERT, (
                    scan.node_id, ts, scan.timestamp, received_at,
                    f"Badge inconnu ou révoqué : {scan.card_uid}", Jsonb(scan.model_dump())))
        response = {
            "card_uid": scan.card_uid,
            "access_granted": granted,
            "user_name": badge["user_name"] if granted else None,
            "clearance_level": badge["clearance_level"] if granted else None,
            "auto_unlock_door": bool(granted and badge["auto_unlock_door"]),
        }
        self.publish(config.TOPIC_ACCESS_RESPONSE, response, "ACCESS_RESPONSE")
        log.info("badge %s sur %s : accès %s", scan.card_uid, scan.node_id, "ACCORDÉ" if granted else "REFUSÉ")


bridge = MqttBridge()
