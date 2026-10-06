from __future__ import annotations

import ipaddress
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


@dataclass
class SecurityHardeningAudit:
    """Audit SSH, UFW, listening ports, and Mosquitto configuration evidence."""

    ssh_password_auth_disabled: bool = True
    firewall_enabled: bool = True
    mqtt_tls_enabled: bool = True
    mqtt_auth_enabled: bool = True
    ssh_config_path: str = "/etc/ssh/sshd_config"
    ufw_status_path: str | None = None
    mqtt_config_path: str = "/etc/mosquitto/mosquitto.conf"
    allowed_open_ports: set[int] = field(default_factory=lambda: {22, 8883})
    required_open_ports: set[int] = field(default_factory=lambda: {8883})
    zone: str = "pi_local"
    port_checker: Callable[[], set[int]] | None = None

    def audit_ssh(self) -> dict[str, Any]:
        parsed = self._read_config(self.ssh_config_path)
        config_text = parsed["content"]
        expected = {
            "PasswordAuthentication": "no",
            "PermitRootLogin": "no",
            "PubkeyAuthentication": "yes",
        }
        if not config_text:
            return {
                "name": "ssh",
                "passed": False,
                "expected": expected,
                "actual": {},
                "details": parsed["error"] or "SSH configuration is empty.",
            }

        actual = {key: self._match_setting(config_text, key) for key in expected}
        passed = all(actual[key] == value for key, value in expected.items())
        return {
            "name": "ssh",
            "passed": passed,
            "expected": expected,
            "actual": actual,
            "details": "Values are read from sshd_config; expected booleans are not treated as evidence.",
        }

    def audit_firewall(self) -> dict[str, Any]:
        ufw_path = self.ufw_status_path or "/etc/ufw/ufw.conf"
        ufw_config = self._read_config(ufw_path)
        policy_path = ufw_path if self.ufw_status_path else "/etc/default/ufw"
        policy_config = ufw_config if policy_path == ufw_path else self._read_config(policy_path)
        if not ufw_config["content"] or not policy_config["content"]:
            return {
                "name": "firewall",
                "passed": False,
                "expected": {"ENABLED": "yes", "DEFAULT_INPUT_POLICY": "DROP"},
                "actual": {},
                "details": ufw_config["error"] or policy_config["error"] or "UFW configuration is empty.",
            }

        enabled = self._match_setting(ufw_config["content"], "ENABLED")
        input_policy = self._match_setting(policy_config["content"], "DEFAULT_INPUT_POLICY")
        passed = enabled == "yes" and input_policy == "drop"
        return {
            "name": "firewall",
            "passed": passed,
            "expected": {"ENABLED": "yes", "DEFAULT_INPUT_POLICY": "DROP"},
            "actual": {"ENABLED": enabled, "DEFAULT_INPUT_POLICY": input_policy},
            "details": "UFW must be enabled and default incoming traffic must be dropped.",
        }

    def audit_open_ports(self) -> dict[str, Any]:
        actual_open_ports = self._detect_open_ports()
        if actual_open_ports is None:
            return {
                "name": "open_ports",
                "passed": False,
                "actual_open_ports": None,
                "unexpected_open_ports": [],
                "missing_required_ports": sorted(self.required_open_ports),
                "allowed_open_ports": sorted(self.allowed_open_ports),
                "details": "Listening ports could not be inspected; port status is unknown.",
            }

        actual_list = sorted(actual_open_ports, key=lambda port: (0 if port in self.allowed_open_ports else 1, port))
        unexpected = sorted(port for port in actual_list if port not in self.allowed_open_ports)
        missing = sorted(port for port in sorted(self.required_open_ports) if port not in actual_open_ports)
        passed = not unexpected and not missing
        return {
            "name": "open_ports",
            "passed": passed,
            "actual_open_ports": actual_list,
            "unexpected_open_ports": unexpected,
            "missing_required_ports": missing,
            "allowed_open_ports": sorted(self.allowed_open_ports),
            "details": (
                "Allowed ports are the maximum permitted listeners; required ports are "
                "services expected to be listening now."
            ),
        }

    def audit_mqtt_security(self) -> dict[str, Any]:
        parsed = self._read_config(self.mqtt_config_path)
        config_text = parsed["content"]
        if not config_text:
            unavailable = parsed["error"] or "Mosquitto configuration is empty."
            checks = [
                {"name": "mqtt_tls", "passed": False, "actual": None, "details": unavailable},
                {"name": "mqtt_anonymous", "passed": False, "actual": None, "details": unavailable},
                {"name": "mqtt_auth", "passed": False, "actual": None, "details": unavailable},
            ]
            return {"name": "mqtt", "passed": False, "checks": checks, "actual": {}}

        listener_ports = set()
        for listener in self._setting_values(config_text, "listener"):
            try:
                listener_ports.add(int(listener.split()[0]))
            except (ValueError, IndexError):
                continue

        cert_values = self._setting_values(config_text, "certfile")
        key_values = self._setting_values(config_text, "keyfile")
        ca_values = self._setting_values(config_text, "cafile")
        cert_exists = bool(cert_values) and self._configured_file_exists(cert_values[-1])
        key_exists = bool(key_values) and self._configured_file_exists(key_values[-1])
        ca_exists = bool(ca_values) and self._configured_file_exists(ca_values[-1])
        tls_passed = 8883 in listener_ports and cert_exists and key_exists
        anonymous_value = self._match_setting(config_text, "allow_anonymous")
        anonymous_passed = anonymous_value == "false"

        password_values = self._setting_values(config_text, "password_file")
        plugin_values = self._setting_values(config_text, "plugin")
        password_file_exists = bool(password_values) and self._configured_file_exists(password_values[-1], nonempty=True)
        plugin_exists = bool(plugin_values) and self._configured_file_exists(plugin_values[-1])
        credentials_configured = password_file_exists or plugin_exists
        auth_passed = anonymous_passed and credentials_configured
        checks = [
            {
                "name": "mqtt_tls",
                "passed": tls_passed,
                "actual": {
                    "listeners": sorted(listener_ports),
                    "certfile_configured_and_readable": cert_exists,
                    "keyfile_configured_and_readable": key_exists,
                    "cafile_configured_and_readable": ca_exists,
                },
                "details": "TLS requires listener 8883 and readable certificate and private-key files.",
            },
            {
                "name": "mqtt_anonymous",
                "passed": anonymous_passed,
                "actual": anonymous_value,
                "details": "allow_anonymous must be explicitly set to false.",
            },
            {
                "name": "mqtt_auth",
                "passed": auth_passed,
                "actual": {
                    "password_file_configured_and_readable": password_file_exists,
                    "plugin_configured_and_readable": plugin_exists,
                },
                "details": "A readable password_file or authentication plugin must be configured.",
            },
        ]
        return {
            "name": "mqtt",
            "passed": all(check["passed"] for check in checks),
            "checks": checks,
            "actual": {check["name"]: check["actual"] for check in checks},
        }

    def evaluate(self) -> dict[str, Any]:
        mqtt_security = self.audit_mqtt_security()
        checks = [
            self.audit_ssh(),
            self.audit_firewall(),
            self.audit_open_ports(),
            *mqtt_security["checks"],
        ]
        return {
            "status": "pass" if all(item["passed"] for item in checks) else "warning",
            "zone": self.zone,
            "checks": checks,
            "allowed_open_ports": sorted(self.allowed_open_ports),
            "required_open_ports": sorted(self.required_open_ports),
        }

    def _detect_open_ports(self) -> set[int] | None:
        if self.port_checker is not None:
            return set(self.port_checker())

        errors: list[str] = []
        for command in ("ss", "netstat"):
            binary = shutil.which(command)
            if not binary:
                continue
            try:
                output = subprocess.check_output(
                    [binary, "-tuln"],
                    stderr=subprocess.DEVNULL,
                    text=True,
                )
                return self._parse_ports(output)
            except (OSError, subprocess.CalledProcessError) as exc:
                errors.append(f"{command}: {exc}")

        return None

    @staticmethod
    def _parse_ports(output: str) -> set[int]:
        ports: set[int] = set()
        for line in output.splitlines():
            match = re.search(r":(\d{1,5})(?:\s|$)", line)
            if match:
                port = int(match.group(1))
                if 0 <= port <= 65535:
                    ports.add(port)
        return ports

    @staticmethod
    def _read_config(path: str) -> dict[str, str]:
        config_file = Path(path)
        try:
            return {"content": config_file.read_text(encoding="utf-8"), "error": ""}
        except OSError as exc:
            return {"content": "", "error": f"Cannot read {config_file}: {exc}"}

    @staticmethod
    def _setting_values(config_text: str, key: str) -> list[str]:
        values: list[str] = []
        for line in config_text.splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            match = re.match(rf"^{re.escape(key)}(?:\s+|=)(.*?)\s*(?:#.*)?$", stripped, re.IGNORECASE)
            if match:
                values.append(match.group(1).strip())
        return values

    @classmethod
    def _match_setting(cls, config_text: str, key: str) -> str | None:
        values = cls._setting_values(config_text, key)
        return values[0].lower() if values else None

    def _configured_file_exists(self, value: str, *, nonempty: bool = False) -> bool:
        configured_path = Path(value)
        if not configured_path.is_absolute():
            configured_path = Path(self.mqtt_config_path).parent / configured_path
        try:
            return configured_path.is_file() and (not nonempty or configured_path.stat().st_size > 0)
        except OSError:
            return False

    @staticmethod
    def validate_ip_address(value: str) -> bool:
        try:
            ipaddress.ip_address(value)
            return True
        except ValueError:
            return False

    @staticmethod
    def build_security_event(event_type: str, *, source_ip: str, severity: str = "high") -> dict[str, Any]:
        if not SecurityHardeningAudit.validate_ip_address(source_ip):
            raise ValueError(f"Invalid IP address: {source_ip}")

        return {
            "event_id": f"sec-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S%f')}",
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "type": event_type,
            "zone": "pi_local",
            "severity": severity,
            "source_ip": source_ip,
            "details": {
                "status": "blocked",
                "generated_by": "security_hardening_audit",
            },
        }
