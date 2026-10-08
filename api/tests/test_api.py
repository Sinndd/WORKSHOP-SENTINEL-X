"""Tests sans base ni broker (validation + authentification).

docker run --rm --mount type=bind,source="$PWD/api",target=/srv,readonly -w /srv \
  -e API_TOKEN=op -e API_DEVICE_TOKEN=dev -e MQTT_PASSWORD=x sentinel/api:2.0.0 \
  sh -c 'pip install -q --target /tmp/t httpx && PYTHONPATH=/tmp/t python -m unittest -v'
"""
import base64
import os
import time
import unittest

os.environ.setdefault("API_TOKEN", "op")
os.environ.setdefault("API_DEVICE_TOKEN", "dev")
os.environ.setdefault("MQTT_PASSWORD", "x")

from fastapi.testclient import TestClient  # noqa: E402
from pydantic import TypeAdapter, ValidationError  # noqa: E402

from app import auth, auth_routes, config  # noqa: E402
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
            {"action": "OPERATE_MOTOR", "target": "ARM_LEFT", "command": "SET_ANGLE", "angle": 120},
            {"action": "OPERATE_MOTOR", "target": "HEAD", "command": "SET_ANGLE", "angle": -45},
            {"action": "OPERATE_MOTOR", "target": "HEAD", "command": "CENTER"},
            {"action": "OPERATE_MOTOR", "target": "TRAP_REAR", "command": "CLOSE"},
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
            {"action": "OPERATE_MOTOR", "target": "ARM_LEFT", "command": "SET_ANGLE"},                 # angle manquant
            {"action": "OPERATE_MOTOR", "target": "ARM_LEFT", "command": "SET_ANGLE", "angle": 181},
            {"action": "OPERATE_MOTOR", "target": "HEAD", "command": "SET_ANGLE", "angle": 120},      # tête : -90..90
            {"action": "OPERATE_MOTOR", "target": "ARM_RIGHT", "command": "OPEN"},
            {"action": "OPERATE_MOTOR", "target": "TRAP_REAR", "command": "SET_ANGLE", "angle": 10},
            {"action": "OPERATE_MOTOR", "target": "TRAP_REAR", "command": "OPEN", "angle": 10},
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

    def test_roles_and_account_endpoints_require_auth(self):
        # Le jeton de service a le rôle « operator » : jamais d'administration des comptes.
        op = {"Authorization": "Bearer op"}
        self.assertEqual(self.client.get("/api/v1/users").status_code, 401)
        self.assertEqual(self.client.get("/api/v1/users", headers=op).status_code, 403)
        self.assertEqual(self.client.get("/api/v1/security/events", headers=op).status_code, 403)
        self.assertEqual(self.client.post("/api/v1/users", headers=op, json={
            "username": "x" * 5, "full_name": "X", "role": "admin"}).status_code, 403)
        # Le jeton de service n'est pas un compte : pas de changement de mot de passe ni de 2FA.
        self.assertEqual(self.client.post("/api/v1/auth/password", headers=op, json={
            "current_password": "a", "new_password": "b"}).status_code, 403)
        # Sans base joignable, un jeton de session ne peut pas être vérifié : 503 (jamais une réponse positive).
        self.assertEqual(self.client.get("/api/v1/auth/me", headers={"Authorization": "Bearer sx_inconnu"}
                                         ).status_code, 503)
        # L'ancienne astuce « jeton API collé dans le mot de passe » n'existe plus (validation avant la base).
        self.assertEqual(self.client.post("/api/v1/auth/login", json={"username": "a"}).status_code, 422)


class Credentials(unittest.TestCase):
    def test_password_hash(self):
        stored = auth.hash_password("Correct-Horse-9")
        self.assertTrue(stored.startswith("scrypt$"))
        self.assertTrue(auth.verify_password("Correct-Horse-9", stored))
        self.assertFalse(auth.verify_password("correct-horse-9", stored))
        self.assertNotEqual(stored, auth.hash_password("Correct-Horse-9"))   # sel aléatoire
        self.assertFalse(auth.verify_password("x", "corrompu"))

    def test_password_policy(self):
        self.assertEqual(auth.password_policy_errors("Tr0ub4dor&3xyz", "alice"), [])
        for bad in ("court1A!", "alllowercaseletters", "Password1234!", "Motdepasse2026!", "aaaaaaaaaaaaaaaa"):
            with self.subTest(bad):
                self.assertTrue(auth.password_policy_errors(bad, "alice"))
        self.assertTrue(auth.password_policy_errors("xAliceAlice9!!", "alice"))      # contient l'identifiant
        self.assertEqual(auth.password_policy_errors("une longue phrase de passe sans symbole", "bob"), [])

    def test_totp_rfc6238_vectors(self):
        secret = base64.b32encode(b"12345678901234567890").decode()
        # Vecteurs de test RFC 6238 (SHA-1, 8 chiffres tronqués à 6) : t=59 -> 287082, t=1111111109 -> 081804.
        self.assertEqual(auth.verify_totp(secret, "287082", now=59), 1)
        self.assertEqual(auth.verify_totp(secret, "081804", now=1111111109), 37037036)
        self.assertIsNone(auth.verify_totp(secret, "000000", now=59))
        self.assertIsNone(auth.verify_totp(secret, "287082", last_step=1, now=59))   # anti-rejeu
        self.assertIsNone(auth.verify_totp(secret, "abc", now=59))

    def test_generated_password_respects_policy(self):
        for _ in range(20):
            self.assertEqual(auth.password_policy_errors(auth_routes._generate_password(), "user"), [])


class IpBlocking(unittest.TestCase):
    def setUp(self):
        self._blocking = config.IP_BLOCKING
        config.IP_BLOCKING = True          # désactivé par défaut : on teste explicitement l'option
        auth._failures.clear(); auth._blocked.clear()
        self._log, self._alert = auth.log_event, auth.raise_intrusion_alert
        self.events = []
        auth.log_event = lambda *a, **k: self.events.append(a[0])
        auth.raise_intrusion_alert = lambda *a, **k: self.events.append("ALERT")

    def tearDown(self):
        config.IP_BLOCKING = self._blocking
        auth.log_event, auth.raise_intrusion_alert = self._log, self._alert

    def test_brute_force_blocks_ip(self):
        for _ in range(config.IP_FAIL_THRESHOLD):
            auth.note_failure("203.0.113.9", "admin")
        self.assertGreater(auth.ip_block_remaining("203.0.113.9"), 0)
        self.assertIn("IP_BLOCKED", self.events)
        self.assertIn("ALERT", self.events)
        self.assertEqual(auth.ip_block_remaining("203.0.113.10"), 0)
        self.assertTrue(auth.unblock_ip("203.0.113.9"))
        self.assertEqual(auth.ip_block_remaining("203.0.113.9"), 0)

    def test_credential_stuffing_blocks_ip(self):
        for i in range(config.IP_USERNAME_THRESHOLD):
            auth.note_failure("203.0.113.20", f"user{i}")
        self.assertGreater(auth.ip_block_remaining("203.0.113.20"), 0)

    def test_loopback_never_blocked(self):
        for _ in range(config.IP_FAIL_THRESHOLD * 2):
            auth.note_failure("127.0.0.1", "admin")
        self.assertEqual(auth.ip_block_remaining("127.0.0.1"), 0)


class LoginRateLimit(unittest.TestCase):
    def test_too_many_logins_get_429_without_ban(self):
        client = TestClient(app)
        auth._hits.clear()
        for _ in range(config.LOGIN_RATE_PER_MIN):
            auth.rate_limited("login:testclient", config.LOGIN_RATE_PER_MIN, 60)
        res = client.post("/api/v1/auth/login", json={"username": "admin", "password": "x"})
        self.assertEqual(res.status_code, 429)
        self.assertEqual(res.headers["retry-after"], "60")
        self.assertEqual(auth.ip_block_remaining("testclient"), 0)        # limite de débit, pas de bannissement
        auth._hits.clear()

    def test_ip_blocking_is_off_by_default(self):
        self.assertFalse(config.IP_BLOCKING)


class Blocked(unittest.TestCase):
    def test_blocked_ip_gets_429(self):
        client = TestClient(app)
        auth._blocked["testclient"] = time.monotonic() + 60
        try:
            self.assertEqual(client.get("/api/v1/devices", headers={"Authorization": "Bearer op"}).status_code, 429)
            self.assertEqual(client.get("/health").status_code, 200)
        finally:
            auth._blocked.clear()


class Actuators(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

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


class Hardening(unittest.TestCase):
    OP = {"Authorization": "Bearer op"}
    JPEG = b"\xff\xd8\xff\xe0"

    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def test_body_size_limits(self):
        big = b"x" * (64 * 1024 + 1)
        self.assertEqual(self.client.post("/api/v1/alerts", content=big, headers={**self.OP, "Content-Type": "application/json"}
                                          ).status_code, 413)
        too_big_jpeg = self.JPEG + b"0" * (2 * 1024 * 1024 + 2048)
        self.assertEqual(self.client.post("/api/v1/vision/snapshot", content=too_big_jpeg, headers=self.OP).status_code, 413)
        self.assertEqual(self.client.post("/api/v1/alerts", content=iter([b"{}"]), headers=self.OP).status_code, 411)

    def test_snapshot_must_be_jpeg(self):
        self.assertEqual(self.client.post("/api/v1/vision/snapshot", content=b"<html>pas une image</html>",
                                          headers=self.OP).status_code, 415)
        self.assertEqual(self.client.post("/api/v1/vision/snapshot", content=self.JPEG + b"ok",
                                          headers=self.OP).status_code, 200)

    def test_node_id_is_validated(self):
        for bad in ('x"; filename="y', "../etc", "a" * 40, "a b"):
            with self.subTest(bad):
                self.assertEqual(self.client.get("/api/v1/telemetry.csv", params={"node_id": bad}, headers=self.OP
                                                 ).status_code, 422)

    def test_security_headers(self):
        res = self.client.get("/api/v1/devices")
        self.assertEqual(res.headers["x-content-type-options"], "nosniff")
        self.assertEqual(res.headers["x-frame-options"], "DENY")
        self.assertEqual(res.headers["cache-control"], "no-store")
        self.assertIn("same-origin", res.headers["cross-origin-resource-policy"])

    def test_rate_limiter(self):
        auth._hits.clear()
        self.assertEqual([auth.rate_limited("k", 3, 60) for _ in range(5)], [False, False, False, True, True])
        self.assertFalse(auth.rate_limited("autre", 3, 60))

    def test_log_forging_is_neutralised(self):
        self.assertEqual(auth.clean("admin\nLOGIN_SUCCESS user=root"), "admin LOGIN_SUCCESS user=root")
        self.assertEqual(auth.clean("a\r\nb\x00c"), "a  b c")


if __name__ == "__main__":
    unittest.main()
