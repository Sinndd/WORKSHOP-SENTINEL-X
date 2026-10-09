import time
import unittest
from unittest import mock

from sentinel_x.ai.unknown_alert import UnknownAlert

UNKNOWN = {"persons": [{"status": "unknown_person", "stable": True}]}
OK = {"persons": [{"status": "authorized_person", "stable": True, "member": "Lucas"}]}


def make(**kw):
    with mock.patch("sentinel_x.ai.unknown_alert.threading.Thread"):      # pas de thread réseau dans les tests
        return UnknownAlert("https://x", "tok", False, **kw)


class UnknownAlertTest(unittest.TestCase):
    def test_only_stable_unknown_triggers(self):
        a = make()
        self.assertFalse(a.update(OK, lambda: b""))
        self.assertFalse(a.update({"persons": [{"status": "unknown_person", "stable": False}]}, lambda: b""))
        self.assertFalse(a.update({"persons": [{"status": "unidentified_person", "stable": True}]}, lambda: b""))
        self.assertFalse(a.update(None, lambda: b""))
        self.assertTrue(a.update(UNKNOWN, lambda: b"jpg"))

    def test_cooldown(self):
        a = make(cooldown_s=60)
        self.assertTrue(a.update(UNKNOWN, lambda: b""))
        self.assertFalse(a.update(UNKNOWN, lambda: b""))
        a._last = time.monotonic() - 61
        self.assertTrue(a.update(UNKNOWN, lambda: b""))

    def test_image_only_built_when_triggered_and_enabled(self):
        calls = []
        a = make(send_image=False)
        a.update(UNKNOWN, lambda: calls.append(1))
        self.assertEqual(calls, [])
        b = make(send_image=True)
        b.update(OK, lambda: calls.append(1))
        self.assertEqual(calls, [])
        b.update(UNKNOWN, lambda: calls.append(1) or b"x")
        self.assertEqual(calls, [1])

    def test_webhook_validation(self):
        self.assertIsNone(make(webhook="https://evil.example/api/webhooks/1/abc").webhook)
        self.assertIsNone(make(webhook="http://discord.com/api/webhooks/1/abc").webhook)
        self.assertEqual(make(webhook="https://discord.com/api/webhooks/123/ab-C_d").webhook, "https://discord.com/api/webhooks/123/ab-C_d")

    def test_discord_payload_without_leaking_url(self):
        a = make(webhook="https://discord.com/api/webhooks/123/secret")
        with mock.patch("sentinel_x.ai.unknown_alert.requests.post") as post:
            self.assertTrue(a.notify_discord(2, __import__("datetime").datetime.now(), b"jpg"))
        args, kw = post.call_args
        self.assertIn("embeds", kw["data"]["payload_json"])
        self.assertIn("file", kw["files"])


if __name__ == "__main__":
    unittest.main()
