import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from sentinel_x.cybersecurity.hardening import SecurityHardeningAudit
from sentinel_x.cybersecurity.secure_mqtt import MqttSecurityContext as CyberMqttSecurityContext
from sentinel_x.mqtt.secure_mqtt import MqttSecurityContext


class SecurityHardeningTests(unittest.TestCase):
    def _configs(self, root: Path):
        ssh_path = root / "sshd_config"
        firewall_path = root / "ufw.conf"
        mqtt_path = root / "mosquitto.conf"
        ssh_path.write_text(
            "PasswordAuthentication no\nPermitRootLogin no\nPubkeyAuthentication yes\n"
        )
        firewall_path.write_text("ENABLED=yes\nDEFAULT_INPUT_POLICY=DROP\n")
        for filename in ("server.crt", "server.key", "ca.crt"):
            (root / filename).write_text("test-data")
        (root / "passwords").write_text("sentinel-x:$6$hashed-value\n")
        mqtt_path.write_text(
            "listener 8883\n"
            "allow_anonymous false\n"
            "certfile server.crt\n"
            "keyfile server.key\n"
            "cafile ca.crt\n"
            "password_file passwords\n"
        )
        return ssh_path, firewall_path, mqtt_path

    def test_audit_uses_real_config_and_injected_ports(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            ssh_path, firewall_path, mqtt_path = self._configs(Path(tmpdir))
            audit = SecurityHardeningAudit(
                ssh_password_auth_disabled=False,
                firewall_enabled=False,
                mqtt_tls_enabled=False,
                mqtt_auth_enabled=False,
                ssh_config_path=str(ssh_path),
                ufw_status_path=str(firewall_path),
                mqtt_config_path=str(mqtt_path),
                allowed_open_ports={22, 8883},
                required_open_ports={8883},
                port_checker=lambda: {22, 8883},
            )

            report = audit.evaluate()

            self.assertEqual(report["status"], "pass")
            self.assertEqual(
                {check["name"] for check in report["checks"]},
                {"ssh", "firewall", "open_ports", "mqtt_tls", "mqtt_anonymous", "mqtt_auth"},
            )

    def test_ssh_settings_are_read_from_file_not_boolean_expectations(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            ssh_path, firewall_path, mqtt_path = self._configs(root)
            ssh_path.write_text(
                "PasswordAuthentication yes\nPermitRootLogin no\nPubkeyAuthentication yes\n"
            )
            report = SecurityHardeningAudit(
                ssh_config_path=str(ssh_path),
                ufw_status_path=str(firewall_path),
                mqtt_config_path=str(mqtt_path),
                port_checker=lambda: {8883},
            ).audit_ssh()

        self.assertFalse(report["passed"])
        self.assertEqual(report["actual"]["PasswordAuthentication"], "yes")

    def test_firewall_requires_enabled_and_default_deny(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "ufw.conf"
            path.write_text("ENABLED=yes\nDEFAULT_INPUT_POLICY=ACCEPT\n")

            result = SecurityHardeningAudit(ufw_status_path=str(path)).audit_firewall()

        self.assertFalse(result["passed"])

    def test_ports_report_unexpected_and_missing_separately(self):
        audit = SecurityHardeningAudit(
            allowed_open_ports={22, 8883},
            required_open_ports={8883},
            port_checker=lambda: {22, 8883, 8080},
        )

        result = audit.audit_open_ports()

        self.assertEqual(result["actual_open_ports"], [22, 8883, 8080])
        self.assertEqual(result["unexpected_open_ports"], [8080])
        self.assertEqual(result["missing_required_ports"], [])
        self.assertFalse(result["passed"])

    def test_unavailable_ports_are_unknown_and_fail(self):
        with patch("sentinel_x.cybersecurity.hardening.shutil.which", return_value=None):
            result = SecurityHardeningAudit().audit_open_ports()

        self.assertIsNone(result["actual_open_ports"])
        self.assertFalse(result["passed"])

    def test_mqtt_checks_tls_anonymous_access_and_credentials_independently(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            _, _, mqtt_path = self._configs(root)
            mqtt_path.write_text(
                "listener 8883\nallow_anonymous false\ncertfile server.crt\nkeyfile server.key\n"
            )

            result = SecurityHardeningAudit(mqtt_config_path=str(mqtt_path)).audit_mqtt_security()

        self.assertTrue(result["checks"][0]["passed"])
        self.assertTrue(result["checks"][1]["passed"])
        self.assertFalse(result["checks"][2]["passed"])
        self.assertFalse(result["passed"])

    def test_inaccessible_configuration_fails_instead_of_passing(self):
        audit = SecurityHardeningAudit(
            ssh_config_path="/missing/sshd_config",
            ufw_status_path="/missing/ufw.conf",
            mqtt_config_path="/missing/mosquitto.conf",
            port_checker=lambda: {8883},
        )

        self.assertFalse(audit.audit_ssh()["passed"])
        self.assertFalse(audit.audit_firewall()["passed"])
        self.assertFalse(audit.audit_mqtt_security()["passed"])

    def test_build_security_event_requires_valid_ip(self):
        event = SecurityHardeningAudit.build_security_event(
            "ssh_failed_login",
            source_ip="192.168.1.42",
        )

        self.assertEqual(event["type"], "ssh_failed_login")
        self.assertEqual(event["source_ip"], "192.168.1.42")

    def test_mqtt_password_is_required_or_read_from_environment(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(ValueError, "password is required"):
                MqttSecurityContext()

        with patch.dict(os.environ, {"SENTINEL_X_MQTT_PASSWORD": "env-secret"}):
            context = MqttSecurityContext()
        self.assertEqual(context.password, "env-secret")

    def test_cybersecurity_secure_mqtt_wrapper_exports_same_context(self):
        self.assertIs(CyberMqttSecurityContext, MqttSecurityContext)

    def test_mqtt_config_never_exposes_password_and_tls_is_not_mtls(self):
        secret = "never-serialize-this-secret"
        mqtt = MqttSecurityContext(password=secret, tls_enabled=True)

        config = mqtt.as_config()

        self.assertEqual(mqtt.security_mode, "tls-password")
        self.assertTrue(config["password_configured"])
        self.assertNotIn("password", config)
        self.assertNotIn(secret, json.dumps(config))

    def test_mqtt_security_modes_are_distinct(self):
        tls_password = MqttSecurityContext(password="secret", tls_enabled=True)
        basic_auth = MqttSecurityContext(password="secret", tls_enabled=False)
        mtls = MqttSecurityContext(
            password="secret",
            tls_enabled=True,
            client_cert_path="/cert/client.crt",
            client_key_path="/cert/client.key",
        )

        self.assertEqual(tls_password.security_mode, "tls-password")
        self.assertEqual(basic_auth.security_mode, "basic-auth")
        self.assertEqual(mtls.security_mode, "mtls")
        self.assertEqual(mtls.as_config()["security_mode"], "mtls")

    def test_mtls_requires_both_client_certificate_and_key(self):
        with self.assertRaisesRegex(ValueError, "Both client_cert_path and client_key_path"):
            MqttSecurityContext(password="secret", client_cert_path="/cert/client.crt")


if __name__ == "__main__":
    unittest.main()
