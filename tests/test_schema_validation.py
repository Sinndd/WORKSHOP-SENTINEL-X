import json
import unittest
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

from sentinel_x.ai.vision import MockVisionDetector, VisionConfig, VisionEventGenerator
from sentinel_x.monitoring.security_monitor import SecurityMonitor


class JsonSchemaValidationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parents[1]
        cls.ai_schema = json.loads((root / "schemas" / "ai_event.schema.json").read_text())
        cls.security_schema = json.loads((root / "schemas" / "security_event.schema.json").read_text())
        for schema in (cls.ai_schema, cls.security_schema):
            Draft202012Validator.check_schema(schema)

    def test_ai_event_schema_accepts_produced_vision_event(self):
        event = VisionEventGenerator(
            VisionConfig(zone="entry", confidence_threshold=0.2),
            detector=MockVisionDetector(),
        ).analyze_frame(b"frame", force=True)

        Draft202012Validator(
            self.ai_schema, format_checker=FormatChecker()
        ).validate(event)

    def test_ai_event_schema_rejects_invalid_event(self):
        invalid_event = {
            "event_id": "ai-1",
            "timestamp": "not-a-timestamp",
            "type": "ssh_failed_login",
            "zone": "entry",
            "severity": "extreme",
            "details": {},
        }
        errors = list(
            Draft202012Validator(
                self.ai_schema, format_checker=FormatChecker()
            ).iter_errors(invalid_event)
        )
        self.assertGreaterEqual(len(errors), 2)

    def test_security_event_schema_accepts_monitor_event(self):
        event = SecurityMonitor().inspect_logs(
            ["sshd[1234]: Failed password for user admin from 192.0.2.10 port 22 ssh2"]
        )[0]
        Draft202012Validator(
            self.security_schema, format_checker=FormatChecker()
        ).validate(event)

    def test_security_event_schema_rejects_invalid_event(self):
        invalid_event = {
            "event_id": "sec-1",
            "timestamp": "yesterday",
            "type": "intrusion_detected",
            "zone": "pi_local",
            "severity": "high",
            "details": {},
        }
        errors = list(
            Draft202012Validator(
                self.security_schema, format_checker=FormatChecker()
            ).iter_errors(invalid_event)
        )
        self.assertGreaterEqual(len(errors), 2)

    def test_security_schema_has_its_own_identity_and_security_fields(self):
        self.assertNotEqual(self.ai_schema["$id"], self.security_schema["$id"])
        self.assertEqual(self.security_schema["title"], "SENTINEL-X Security Event")
        self.assertIn("source_ip", self.security_schema["properties"])
        self.assertIn("severity", self.security_schema["properties"])
        self.assertIn("details", self.security_schema["properties"])


if __name__ == "__main__":
    unittest.main()
