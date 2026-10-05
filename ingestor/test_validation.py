"""Tests de la validation du contrat v2 : python -m unittest -v"""
import json
import unittest

from validation import ValidationError, resolve_ts, validate

NOW = 1_790_000_000

# Exemple de 03_SPECIFICATION_API_ET_CONTRAT_DONNEES.md (timestamp ramené à "maintenant").
TELEMETRY = {
    "node_id": "SENTINEL-X-CORE", "timestamp": NOW - 2, "uptime_ms": 142580,
    "metrics": {"temperature_celsius": 23.4, "humidity_percent": 48.0, "gas_raw_ppm": 215,
                "presence_detected": False},
    "actuators_state": {"airlock_open": False, "gas_valve_open": True, "ventilation_active": False,
                        "barrier_open": False, "alarm_active": False},
    "system": {"wifi_rssi_dbm": -58, "free_heap_bytes": 194200},
}
# Trame réellement émise par le firmware 04_FIRMWARE_ESP32_COMPLET.md (timestamp = millis()).
FIRMWARE_TELEMETRY = {
    "node_id": "SENTINEL-X-CORE", "timestamp": 61234,
    "metrics": {"temperature_celsius": 0.0, "humidity_percent": 0.0, "gas_raw_ppm": 4095,
                "presence_detected": True},
    "actuators_state": {"airlock_open": False},
}
ALERT = {"node_id": "SENTINEL-X-CORE", "timestamp": NOW - 1, "event_type": "INTRUSION_DETECTED",
         "severity": "CRITICAL", "source_sensor": "PIR_MOTION", "value": 1.0,
         "details": "Mouvement anormal detecte dans le perimetre d'acces restreint"}
VISION = {"ts": NOW, "label": "person", "confidence": 0.87, "bbox": [120, 40, 200, 380],
          "frame_w": 640, "frame_h": 480, "snapshot_path": "snapshots/1790000000.jpg"}


def run(topic, msg):
    return validate(topic, json.dumps(msg).encode(), now=NOW)


def without(d, key):
    return {k: v for k, v in d.items() if k != key}


class Timestamps(unittest.TestCase):
    def test_epoch_seconds(self):
        self.assertEqual(resolve_ts(NOW - 10, NOW), NOW - 10)

    def test_epoch_milliseconds(self):
        self.assertEqual(resolve_ts((NOW - 10) * 1000, NOW), NOW - 10)

    def test_millis_since_boot_falls_back_to_reception(self):
        self.assertEqual(resolve_ts(61234, NOW), NOW)

    def test_future_falls_back_to_reception(self):
        self.assertEqual(resolve_ts(NOW + 3600, NOW), NOW)


class ValidMessages(unittest.TestCase):
    def test_spec_telemetry(self):
        kind, data, _ = run("sentinel/telemetry", TELEMETRY)
        self.assertEqual((kind, data["gas_raw_ppm"], data["gas_valve_open"], data["ts"]),
                         ("telemetry", 215, True, NOW - 2))

    def test_firmware_telemetry(self):
        _, data, _ = run("sentinel/telemetry", FIRMWARE_TELEMETRY)
        self.assertEqual((data["device_timestamp"], data["ts"], data["wifi_rssi_dbm"], data["barrier_open"]),
                         (61234, NOW, None, None))

    def test_null_dht(self):
        msg = {**TELEMETRY, "metrics": {**TELEMETRY["metrics"], "temperature_celsius": None}}
        self.assertIsNone(run("sentinel/telemetry", msg)[1]["temperature_celsius"])

    def test_extra_fields_tolerated(self):
        run("sentinel/telemetry", {**TELEMETRY, "type": "TELEMETRY", "motors": []})

    def test_alert(self):
        self.assertEqual(run("sentinel/alerts", ALERT)[1]["event_type"], "INTRUSION_DETECTED")

    def test_alert_minimal(self):
        msg = {"node_id": "SENTINEL-X-CORE", "event_type": "GAS_LEAK_WARNING", "severity": "WARNING"}
        self.assertEqual(run("sentinel/alerts", msg)[1]["ts"], NOW)

    def test_vision(self):
        self.assertEqual(run("sentinel/vision/events", VISION)[1]["bbox"], [120, 40, 200, 380])


class InvalidMessages(unittest.TestCase):
    T, A = "sentinel/telemetry", "sentinel/alerts"
    M = TELEMETRY["metrics"]
    CASES = [
        ("bad json", T, b"{not json"),
        ("not object", T, b"[1,2]"),
        ("binary", T, b"\xff\xfe"),
        ("too big", T, b"{" + b" " * 3000 + b"}"),
        ("unknown topic", "sentinel/other", TELEMETRY),
        ("old v1 topic", "sentinel/sentinel-01/telemetry", TELEMETRY),
        ("missing node_id", T, without(TELEMETRY, "node_id")),
        ("bad node_id", T, {**TELEMETRY, "node_id": "bad id!"}),
        ("missing timestamp", T, without(TELEMETRY, "timestamp")),
        ("negative timestamp", T, {**TELEMETRY, "timestamp": -5}),
        ("missing metrics", T, without(TELEMETRY, "metrics")),
        ("metrics not object", T, {**TELEMETRY, "metrics": [1]}),
        ("gas > 4095", T, {**TELEMETRY, "metrics": {**M, "gas_raw_ppm": 4096}}),
        ("gas float", T, {**TELEMETRY, "metrics": {**M, "gas_raw_ppm": 3.5}}),
        ("presence int", T, {**TELEMETRY, "metrics": {**M, "presence_detected": 1}}),
        ("temp str", T, {**TELEMETRY, "metrics": {**M, "temperature_celsius": "22"}}),
        ("humidity 120", T, {**TELEMETRY, "metrics": {**M, "humidity_percent": 120}}),
        ("actuator str", T, {**TELEMETRY, "actuators_state": {"airlock_open": "yes"}}),
        ("rssi positive", T, {**TELEMETRY, "system": {"wifi_rssi_dbm": 5}}),
        ("alert type", A, {**ALERT, "event_type": "FIRE"}),
        ("alert severity lowercase", A, {**ALERT, "severity": "critical"}),
        ("alert details long", A, {**ALERT, "details": "x" * 600}),
        ("vision confidence", "sentinel/vision/events", {**VISION, "confidence": 1.5}),
        ("vision bbox outside", "sentinel/vision/events", {**VISION, "bbox": [600, 0, 200, 10]}),
    ]

    def test_rejected(self):
        for name, topic, msg in self.CASES:
            payload = msg if isinstance(msg, bytes) else json.dumps(msg).encode()
            with self.subTest(name), self.assertRaises(ValidationError):
                validate(topic, payload, now=NOW)


if __name__ == "__main__":
    unittest.main()
