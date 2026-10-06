from __future__ import annotations

import ipaddress
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable


_SSH_FAILURE = re.compile(
    r"\b(?:failed password|invalid user|failed publickey|"
    r"maximum authentication attempts exceeded)\b",
    re.IGNORECASE,
)
_MQTT_FAILURE = re.compile(
    r"\bACL\s+(?:denied|denial)\b|"
    r"\bdenied for client\b|"
    r"\bnot authori[sz]ed\b|"
    r"\b(?:mqtt|mosquitto).{0,80}\b(?:auth(?:entication)?\s+fail(?:ed|ure)|denied)\b|"
    r"\bunauthori[sz]ed.{0,80}\btopic\b",
    re.IGNORECASE,
)


class SecurityMonitor:
    """Lightweight monitoring for explicit SSH and MQTT authentication failures."""

    def __init__(self, zone: str = "pi_local") -> None:
        self.zone = zone
        self._event_counts: dict[str, int] = defaultdict(int)

    def inspect_logs(self, log_lines: Iterable[str]) -> list[dict[str, Any]]:
        findings: list[dict[str, Any]] = []
        for line in log_lines:
            if not line:
                continue
            event_type = self._classify_log(line)
            if event_type is None:
                continue

            event = {
                "event_id": f"sec-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S%f')}",
                "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "type": event_type,
                "zone": self.zone,
                "severity": "high",
                "source_ip": self._extract_ip(line),
                "details": {"log": line.strip()},
            }
            findings.append(event)
        return findings

    @staticmethod
    def _classify_log(line: str) -> str | None:
        lower = line.lower()
        if _MQTT_FAILURE.search(line):
            return "mqtt_auth_failure"
        if _SSH_FAILURE.search(line) or (
            re.search(r"\bauthentication failure\b", line, re.IGNORECASE)
            and ("ssh" in lower or "sshd" in lower)
        ):
            return "ssh_failed_login"
        if re.search(r"\b(?:unauthorized|unauthorised|forbidden|access denied)\b", line, re.IGNORECASE):
            return "unauthorized_access"
        return None

    @staticmethod
    def _extract_ip(value: str) -> str | None:
        candidates = re.findall(r"(?<![\w.])(?:[0-9a-fA-F:.]{3,})(?![\w.])", value)
        for candidate in candidates:
            try:
                return str(ipaddress.ip_address(candidate.strip("[]")))
            except ValueError:
                continue
        return None

    def summarize(self, events: Iterable[dict[str, Any]]) -> dict[str, Any]:
        counts: dict[str, int] = defaultdict(int)
        for event in events:
            event_type = str(event.get("type", "unknown"))
            counts[event_type] += 1
            self._event_counts[event_type] += 1
        return {
            "zone": self.zone,
            "total_events": sum(counts.values()),
            "counts_by_type": dict(sorted(counts.items())),
            "cumulative_counts": dict(sorted(self._event_counts.items())),
        }

    def detect_suspicious_rate(
        self,
        events: Iterable[dict[str, Any]],
        threshold: int = 5,
        window_seconds: int = 60,
        *,
        now: datetime | None = None,
    ) -> bool:
        if threshold < 1 or window_seconds < 1:
            raise ValueError("threshold and window_seconds must be positive.")

        reference_time = now or datetime.now(timezone.utc)
        if reference_time.tzinfo is None:
            reference_time = reference_time.replace(tzinfo=timezone.utc)
        cutoff = reference_time - timedelta(seconds=window_seconds)
        grouped: dict[str | None, list[datetime]] = defaultdict(list)

        for event in events:
            if event.get("type") not in {"ssh_failed_login", "mqtt_auth_failure"}:
                continue
            timestamp = event.get("timestamp")
            if not isinstance(timestamp, str):
                continue
            try:
                event_time = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
            except ValueError:
                continue
            if event_time.tzinfo is None:
                event_time = event_time.replace(tzinfo=timezone.utc)
            if cutoff <= event_time <= reference_time:
                grouped[event.get("source_ip")].append(event_time)

        return any(len(attempts) >= threshold for attempts in grouped.values())
