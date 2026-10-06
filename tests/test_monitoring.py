import unittest
from datetime import datetime, timedelta, timezone

from sentinel_x.monitoring.security_monitor import SecurityMonitor


class SecurityMonitorTests(unittest.TestCase):
    def test_classifies_only_explicit_ssh_and_mqtt_failures(self):
        monitor = SecurityMonitor(zone="pi_local")
        logs = [
            "sshd[1234]: Failed password for invalid user admin from 192.168.1.42 port 22 ssh2",
            "sshd[99]: Server listening on 0.0.0.0 port 22",
            "mosquitto[555]: ACL denied for client sentinel-x on topic sentinel-x/lab/events/security",
            "mosquitto: unauthorized access to topic sentinel-x/lab/private",
            "application: unauthorized access to admin endpoint",
        ]

        events = monitor.inspect_logs(logs)

        self.assertEqual([event["type"] for event in events], [
            "ssh_failed_login",
            "mqtt_auth_failure",
            "mqtt_auth_failure",
            "unauthorized_access",
        ])
        self.assertEqual(events[0]["source_ip"], "192.168.1.42")
        self.assertTrue(monitor.detect_suspicious_rate(events, threshold=1))

    def test_five_failures_in_window_trigger_detection(self):
        monitor = SecurityMonitor()
        now = datetime(2026, 10, 5, 12, tzinfo=timezone.utc)
        events = self._failed_logins(now, offsets=[0, 5, 10, 20, 59], ips=["192.0.2.1"] * 5)

        self.assertTrue(
            monitor.detect_suspicious_rate(events, threshold=5, window_seconds=60, now=now)
        )

    def test_old_failures_outside_window_do_not_trigger_detection(self):
        monitor = SecurityMonitor()
        now = datetime(2026, 10, 5, 12, tzinfo=timezone.utc)
        events = self._failed_logins(now, offsets=[61, 120, 180, 240, 300], ips=["192.0.2.1"] * 5)

        self.assertFalse(
            monitor.detect_suspicious_rate(events, threshold=5, window_seconds=60, now=now)
        )

    def test_failures_from_different_ips_are_counted_separately(self):
        monitor = SecurityMonitor()
        now = datetime(2026, 10, 5, 12, tzinfo=timezone.utc)
        events = self._failed_logins(
            now,
            offsets=[1, 2, 3, 4, 5],
            ips=["192.0.2.1", "192.0.2.1", "192.0.2.1", "192.0.2.2", "192.0.2.2"],
        )

        self.assertFalse(
            monitor.detect_suspicious_rate(events, threshold=4, window_seconds=60, now=now)
        )

    def test_summary_counts_events(self):
        monitor = SecurityMonitor(zone="pi_local")
        events = [
            {"type": "unauthorized_access"},
            {"type": "unauthorized_access"},
            {"type": "network_scan"},
        ]

        summary = monitor.summarize(events)
        self.assertEqual(summary["total_events"], 3)
        self.assertEqual(summary["counts_by_type"]["network_scan"], 1)

    @staticmethod
    def _failed_logins(now, offsets, ips):
        return [
            {
                "type": "ssh_failed_login",
                "source_ip": ip,
                "timestamp": (now - timedelta(seconds=offset)).isoformat(),
            }
            for offset, ip in zip(offsets, ips)
        ]


if __name__ == "__main__":
    unittest.main()
