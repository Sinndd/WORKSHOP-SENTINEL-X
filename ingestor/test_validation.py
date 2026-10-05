"""Tests de la validation du contrat MQTT : python -m unittest -v"""
import json
import unittest

from validation import ValidationError, validate

NOW = 1_790_000_000
T = "sentinel/sentinel-01/"

TELEMETRY = {"v": 1, "device_id": "sentinel-01", "ts": NOW - 2, "seq": 42, "temperature_c": 22.4,
             "humidity_pct": 48.1, "gas_raw": 312, "motion": False, "rssi_dbm": -61, "uptime_s": 3600}
ALERT = {"v": 1, "device_id": "sentinel-01", "ts": NOW - 1, "type": "gas_high", "severity": "critical",
         "value": 812, "threshold": 600, "message": "Gaz au-dessus du seuil"}
STATUS = {"v": 1, "state": "online", "ip": "192.168.10.20", "fw": "1.0.0"}
VISION = {"v": 1, "ts": NOW, "label": "person", "confidence": 0.87, "bbox": [120, 40, 200, 380],
          "frame_w": 640, "frame_h": 480, "snapshot_path": "snapshots/1790000000.jpg"}


def run(topic, msg):
    return validate(topic, json.dumps(msg).encode(), now=NOW)


class ValidMessages(unittest.TestCase):
    def test_telemetry(self):
        kind, dev, data, _ = run(T + "telemetry", TELEMETRY)
        self.assertEqual((kind, dev, data["gas_raw"]), ("telemetry", "sentinel-01", 312))

    def test_telemetry_dht_failure_is_null(self):
        _, _, data, _ = run(T + "telemetry", {**TELEMETRY, "temperature_c": None, "humidity_pct": None})
        self.assertIsNone(data["temperature_c"])

    def test_alert(self):
        self.assertEqual(run(T + "alerts", ALERT)[2]["type"], "gas_high")

    def test_status_and_lwt(self):
        self.assertEqual(run(T + "status", STATUS)[2]["ip"], "192.168.10.20")
        self.assertEqual(run(T + "status", {"v": 1, "state": "offline"})[2]["state"], "offline")

    def test_vision(self):
        kind, dev, data, _ = run("sentinel/vision/events", VISION)
        self.assertEqual((kind, dev, data["bbox"]), ("vision", None, [120, 40, 200, 380]))

    def test_unknown_extra_field_tolerated(self):
        run(T + "telemetry", {**TELEMETRY, "battery_v": 3.7})


class InvalidMessages(unittest.TestCase):
    CASES = [
        ("bad json", T + "telemetry", b"{not json"),
        ("not object", T + "telemetry", b"[1,2]"),
        ("binary", T + "telemetry", b"\xff\xfe"),
        ("too big", T + "telemetry", b"{" + b" " * 2000 + b"}"),
        ("unknown topic", "sentinel/sentinel-01/other", TELEMETRY),
        ("bad device in topic", "sentinel/Sentinel_01/telemetry", TELEMETRY),
        ("missing v", T + "telemetry", {k: v for k, v in TELEMETRY.items() if k != "v"}),
        ("v=2", T + "telemetry", {**TELEMETRY, "v": 2}),
        ("v=true", T + "telemetry", {**TELEMETRY, "v": True}),
        ("device mismatch", T + "telemetry", {**TELEMETRY, "device_id": "sentinel-02"}),
        ("gas > 1023", T + "telemetry", {**TELEMETRY, "gas_raw": 1024}),
        ("gas float", T + "telemetry", {**TELEMETRY, "gas_raw": 3.5}),
        ("motion int", T + "telemetry", {**TELEMETRY, "motion": 1}),
        ("temp str", T + "telemetry", {**TELEMETRY, "temperature_c": "22"}),
        ("humidity 120", T + "telemetry", {**TELEMETRY, "humidity_pct": 120}),
        ("rssi positive", T + "telemetry", {**TELEMETRY, "rssi_dbm": 5}),
        ("ts before NTP", T + "telemetry", {**TELEMETRY, "ts": 12}),
        ("ts future", T + "telemetry", {**TELEMETRY, "ts": NOW + 3600}),
        ("alert type", T + "alerts", {**ALERT, "type": "fire"}),
        ("alert severity", T + "alerts", {**ALERT, "severity": "high"}),
        ("alert message long", T + "alerts", {**ALERT, "message": "x" * 300}),
        ("status state", T + "status", {**STATUS, "state": "sleeping"}),
        ("status bad ip", T + "status", {**STATUS, "ip": "999.1.1.1"}),
        ("status online w/o ip", T + "status", {"v": 1, "state": "online", "fw": "1.0.0"}),
        ("vision confidence", "sentinel/vision/events", {**VISION, "confidence": 1.5}),
        ("vision bbox len", "sentinel/vision/events", {**VISION, "bbox": [1, 2, 3]}),
        ("vision bbox outside", "sentinel/vision/events", {**VISION, "bbox": [600, 0, 200, 10]}),
        ("vision empty label", "sentinel/vision/events", {**VISION, "label": ""}),
    ]

    def test_rejected(self):
        for name, topic, msg in self.CASES:
            payload = msg if isinstance(msg, bytes) else json.dumps(msg).encode()
            with self.subTest(name), self.assertRaises(ValidationError):
                validate(topic, payload, now=NOW)


if __name__ == "__main__":
    unittest.main()
