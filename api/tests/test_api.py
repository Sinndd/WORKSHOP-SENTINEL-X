"""Tests sans base ni broker (validation + authentification).

docker run --rm --mount type=bind,source="$PWD/api",target=/srv,readonly -w /srv \
  -e API_TOKEN=op -e API_DEVICE_TOKEN=dev -e MQTT_PASSWORD=x sentinel/api:2.0.0 \
  sh -c 'pip install -q --target /tmp/t httpx && PYTHONPATH=/tmp/t python -m unittest -v'
"""
import os
import unittest

os.environ.setdefault("API_TOKEN", "op")
os.environ.setdefault("API_DEVICE_TOKEN", "dev")
os.environ.setdefault("MQTT_PASSWORD", "x")

from fastapi.testclient import TestClient  # noqa: E402
from pydantic import TypeAdapter, ValidationError  # noqa: E402

from app.main import app  # noqa: E402
from app.models import AccessScan, AlertIn, Command, resolve_ts  # noqa: E402

COMMAND = TypeAdapter(Command)
ALERT = {"node_id": "SENTINEL-X-CORE", "timestamp": 1728132045, "event_type": "INTRUSION_DETECTED",
         "severity": "CRITICAL", "source_sensor": "PIR_MOTION", "value": 1.0,
         "details": "Mouvement anormal detecte dans le perimetre d'acces restreint"}


class Models(unittest.TestCase):
    def test_doc_examples_are_valid(self):
        AlertIn.model_validate(ALERT)
        AccessScan.model_validate({"node_id": "SENTINEL-X-CORE", "timestamp": 1728132102,
                                   "card_uid": "A3:5F:B2:1C", "card_type": "MIFARE_CLASSIC",
                                   "door_id": "AIRLOCK_MAIN"})
        for cmd in (
            {"action": "OPERATE_MOTOR", "target": "AIRLOCK_MAIN", "command": "OPEN", "duration_ms": 3000},
            {"action": "CONTROL_MOTORS", "commands": [
                {"motor_id": 0, "direction": "CW", "angle_deg": 90, "speed_rpm": 12},
                {"motor_id": 1, "direction": "CCW", "angle_deg": 180, "speed_rpm": 8},
                {"motor_id": 4, "direction": "CW", "angle_deg": 45, "speed_rpm": 15}]},
            {"action": "EMERGENCY_STOP_ALL"},
            {"action": "TRIGGER_ALARM", "state": True, "color": "RED", "sound": "SIREN_ALERT"},
        ):
            with self.subTest(cmd["action"]):
                COMMAND.validate_python(cmd)

    def test_firmware_access_scan_lowercase_without_timestamp(self):
        scan = AccessScan.model_validate({"node_id": "SENTINEL-X-CORE", "card_uid": "a3:5f:b2:1c",
                                          "door_id": "AIRLOCK_MAIN"})
        self.assertEqual(scan.card_uid, "A3:5F:B2:1C")

    def test_invalid(self):
        cases = [
            (AlertIn, {**ALERT, "event_type": "FIRE"}),
            (AlertIn, {**ALERT, "severity": "critical"}),
            (AlertIn, {**ALERT, "timestamp": "1728132045"}),            # strict : pas de transtypage
            (AccessScan, {"node_id": "SENTINEL-X-CORE", "card_uid": "A3-5F-B2-1C"}),
            (AccessScan, {"node_id": "SENTINEL-X-CORE", "card_uid": "A3:5F"}),
        ]
        for model, data in cases:
            with self.subTest(data), self.assertRaises(ValidationError):
                model.model_validate(data)
        bad_commands = [
            {"action": "DESTROY"},
            {"action": "OPERATE_MOTOR", "target": "AIRLOCK_MAIN", "command": "SPIN"},
            {"action": "CONTROL_MOTORS", "commands": [{"motor_id": 6, "direction": "CW", "angle_deg": 90,
                                                       "speed_rpm": 12}]},
            {"action": "CONTROL_MOTORS", "commands": [
                {"motor_id": 0, "direction": "CW", "angle_deg": 90, "speed_rpm": 12},
                {"motor_id": 0, "direction": "CCW", "angle_deg": 90, "speed_rpm": 12}]},
            {"action": "CONTROL_MOTORS", "commands": [{"motor_id": 0, "direction": "CW", "angle_deg": 90,
                                                       "speed_rpm": 40}]},
            {"action": "CONTROL_MOTORS", "commands": []},
            {"action": "TRIGGER_ALARM", "state": 1},
        ]
        for cmd in bad_commands:
            with self.subTest(cmd), self.assertRaises(ValidationError):
                COMMAND.validate_python(cmd)

    def test_resolve_ts(self):
        now = 1_790_000_000
        self.assertEqual(resolve_ts(now - 5, now), now - 5)
        self.assertEqual(resolve_ts((now - 5) * 1000, now), now - 5)
        self.assertEqual(resolve_ts(142580, now), now)     # millis() du firmware
        self.assertEqual(resolve_ts(None, now), now)


class Http(unittest.TestCase):
    """Contrôles faits AVANT tout accès à la base : authentification et validation (422)."""
    client = TestClient(app)

    def test_health_is_public(self):
        self.assertEqual(self.client.get("/health").status_code, 200)

    def test_tokens(self):
        self.assertEqual(self.client.post("/api/v1/alerts", json=ALERT).status_code, 401)
        self.assertEqual(self.client.post("/api/v1/alerts", json=ALERT,
                                          headers={"Authorization": "Bearer wrong"}).status_code, 401)
        # Le jeton d'appareil ne donne accès qu'à POST /alerts.
        dev = {"Authorization": "Bearer dev"}
        self.assertEqual(self.client.get("/api/v1/alerts", headers=dev).status_code, 401)
        self.assertEqual(self.client.post("/api/v1/commands", json={"action": "EMERGENCY_STOP_ALL"},
                                          headers=dev).status_code, 401)

    def test_validation_422(self):
        op = {"Authorization": "Bearer op"}
        self.assertEqual(self.client.post("/api/v1/alerts", json={**ALERT, "severity": "x"},
                                          headers=op).status_code, 422)
        self.assertEqual(self.client.post("/api/v1/commands", json={"action": "DESTROY"},
                                          headers=op).status_code, 422)
        self.assertEqual(self.client.put("/api/v1/badges/not-a-uid", json={"user_name": "a",
                                         "clearance_level": "b"}, headers=op).status_code, 422)

    def test_login(self):
        # Échec mauvais identifiants
        res_fail = self.client.post("/api/v1/auth/login", json={"username": "bad", "password": "wrong"})
        self.assertEqual(res_fail.status_code, 401)

        # Succès avec identifiants par défaut
        res_ok = self.client.post("/api/v1/auth/login", json={"username": "admin", "password": "sentinel2026"})
        self.assertEqual(res_ok.status_code, 200)
        data = res_ok.json()
        self.assertIn("token", data)
        self.assertEqual(data["role"], "operator")

        # Succès avec token direct dans le mot de passe
        res_token = self.client.post("/api/v1/auth/login", json={"username": "any", "password": "op"})
        self.assertEqual(res_token.status_code, 200)

    def test_actuators_and_vision_validation(self):
        # 401 si non authentifié
        self.assertEqual(self.client.post("/api/v1/actuators/airlock", json={"state": True}).status_code, 401)
        self.assertEqual(self.client.get("/api/v1/vision/snapshot").status_code, 401)

        op = {"Authorization": "Bearer op"}
        # Vision snapshot sans photo retourne le SVG de veille
        res_snap = self.client.get("/api/v1/vision/snapshot", headers=op)
        self.assertEqual(res_snap.status_code, 200)
        self.assertIn("image/svg+xml", res_snap.headers["content-type"])

        # Upload de snapshot binaire
        res_upload = self.client.post("/api/v1/vision/snapshot", content=b"\xff\xd8\xff\xe0testjpeg", headers=op)
        self.assertEqual(res_upload.status_code, 200)
        self.assertTrue(res_upload.json()["bytes"] > 0)

        # Après upload, snapshot retourne du jpeg
        res_snap_after = self.client.get("/api/v1/vision/snapshot", headers=op)
        self.assertEqual(res_snap_after.status_code, 200)
        self.assertIn("image/jpeg", res_snap_after.headers["content-type"])


if __name__ == "__main__":
    unittest.main()
