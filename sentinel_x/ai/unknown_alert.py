"""Alerte « personne inconnue » : alarme du robot, alerte dans le tableau de bord et notification Discord.

Déclenchée par dashboard_stream quand le pipeline confirme (3 images sur 5) un visage absent de la base autorisée
(statut « unknown_person »). Une personne sans visage exploitable (« unidentified_person ») ne déclenche rien.

  1. alerte INTRUSION_DETECTED / CRITICAL dans le journal des alertes (le tableau de bord sonne et affiche) ;
  2. alarme du robot (buzzer + LED rouge, POST /actuators/alarm), coupée seule après ALARM_SECONDS ;
  3. message Discord (webhook) avec l'heure et, si activé, l'image annotée.

Un seul déclenchement par COOLDOWN_S (15 s par défaut) : une personne qui reste ne fait pas sonner en boucle.
Tout part dans un thread : la vidéo n'attend jamais le réseau. Ce module tourne sur la machine de vision (qui a
Internet) ; le Pi, lui, n'en a pas besoin.

Configuration (.env de la machine de vision, jamais dans Git) :
  DISCORD_WEBHOOK_URL   adresse du webhook du salon (Discord : Paramètres du salon > Intégrations > Webhooks). Secrète.
  UNKNOWN_ALARM=on|off  alarme du robot (défaut on)        UNKNOWN_ALARM_SECONDS=10
  UNKNOWN_COOLDOWN_S=15                                     DISCORD_SEND_IMAGE=on|off  (défaut on : image jointe)
Essai de la notification seule :  python -m sentinel_x.ai.unknown_alert --test
"""
from __future__ import annotations

import json
import os
import queue
import re
import sys
import threading
import time
from datetime import datetime

import requests

NODE_ID = "SENTINEL-X-CORE"
WEBHOOK_RE = re.compile(r"^https://(?:discord|discordapp)\.com/api/webhooks/\d+/[\w-]+$")


def log(msg: str) -> None:
    print(f"[inconnu {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def _on(value: str | None, default: bool) -> bool:
    return default if value is None else value.strip().lower() in ("on", "1", "true", "yes", "oui")


class UnknownAlert:
    def __init__(self, api: str, token: str, verify: str | bool, webhook: str | None = None, alarm: bool = True,
                 alarm_seconds: float = 10, cooldown_s: float = 15, send_image: bool = True) -> None:
        self.base, self.verify = api.rstrip("/") + "/api/v1", verify
        self.http = requests.Session()
        self.http.headers.update({"Authorization": f"Bearer {token}"})
        self.webhook = webhook if webhook and WEBHOOK_RE.match(webhook) else None
        if webhook and not self.webhook:
            log("DISCORD_WEBHOOK_URL ignorée : adresse de webhook Discord invalide")
        self.alarm, self.alarm_seconds, self.cooldown_s, self.send_image = alarm, alarm_seconds, cooldown_s, send_image
        self._last = -1e9
        self._queue: queue.Queue = queue.Queue(maxsize=4)
        self._alarm_off: threading.Timer | None = None
        threading.Thread(target=self._run, name="inconnu", daemon=True).start()

    @classmethod
    def from_env(cls, api: str, token: str, verify: str | bool) -> "UnknownAlert":
        env = os.environ.get
        return cls(api, token, verify, webhook=env("DISCORD_WEBHOOK_URL"), alarm=_on(env("UNKNOWN_ALARM"), True),
                   alarm_seconds=float(env("UNKNOWN_ALARM_SECONDS", "10")), cooldown_s=float(env("UNKNOWN_COOLDOWN_S", "15")),
                   send_image=_on(env("DISCORD_SEND_IMAGE"), True))

    # --- Détection (appelée à chaque image : doit rester instantanée) ---------------------------
    @staticmethod
    def unknown_count(result: dict | None) -> int:
        return sum(1 for p in (result or {}).get("persons", []) if p.get("status") == "unknown_person" and p.get("stable"))

    def update(self, result: dict | None, jpeg_factory) -> bool:
        """`jpeg_factory()` produit le JPEG annoté ; appelé seulement au déclenchement. Renvoie True si déclenché."""
        count = self.unknown_count(result)
        now = time.monotonic()
        if not count or now - self._last < self.cooldown_s:
            return False
        self._last = now
        try:
            self._queue.put_nowait((count, datetime.now(), jpeg_factory() if self.send_image else None))
        except queue.Full:
            pass
        log(f"{count} personne(s) inconnue(s) : alerte déclenchée")
        return True

    # --- Actions réseau (thread dédié) --------------------------------------------------------
    def _run(self) -> None:
        while True:
            count, when, jpeg = self._queue.get()
            self._server_alert(count)
            if self.alarm:
                self._set_alarm(True)
                if self._alarm_off:
                    self._alarm_off.cancel()
                self._alarm_off = threading.Timer(self.alarm_seconds, self._set_alarm, args=(False,))
                self._alarm_off.daemon = True
                self._alarm_off.start()
            self.notify_discord(count, when, jpeg)

    def _post(self, path: str, payload: dict) -> None:
        r = self.http.post(self.base + path, json=payload, timeout=5, verify=self.verify)
        r.raise_for_status()

    def _server_alert(self, count: int) -> None:
        try:
            self._post("/alerts", {"node_id": NODE_ID, "event_type": "INTRUSION_DETECTED", "severity": "CRITICAL",
                                   "source_sensor": "CAMERA_AI",
                                   "details": f"Personne inconnue détectée par la caméra ({count} personne(s))"})
        except Exception as exc:
            log(f"alerte API impossible : {exc}")

    def _set_alarm(self, state: bool) -> None:
        try:
            self._post("/actuators/alarm", {"state": state, "color": "RED", "sound": "SIREN_ALERT"})
        except Exception as exc:
            log(f"alarme impossible : {exc}")

    def notify_discord(self, count: int, when: datetime, jpeg: bytes | None, test: bool = False) -> bool:
        if not self.webhook:
            return False
        embed = {"title": "🧪 Test de notification SENTINEL-X" if test else "🚨 Personne inconnue détectée",
                 "description": f"{count} personne(s) non reconnue(s) par la caméra.\n{when:%d/%m/%Y à %H:%M:%S}",
                 "color": 0x3BA55D if test else 0xED4245}
        if jpeg:
            embed["image"] = {"url": "attachment://inconnu.jpg"}
        try:
            files = {"file": ("inconnu.jpg", jpeg, "image/jpeg")} if jpeg else None
            r = requests.post(self.webhook, data={"payload_json": json.dumps({"username": "SENTINEL-X", "embeds": [embed]})},
                              files=files, timeout=10)
            r.raise_for_status()
            return True
        except Exception as exc:                  # l'adresse du webhook est secrète : jamais dans les journaux
            log(f"notification Discord impossible : {type(exc).__name__} {getattr(getattr(exc, 'response', None), 'status_code', '')}")
            return False


def main() -> int:
    if "--test" not in sys.argv:
        print(__doc__)
        return 2
    alert = UnknownAlert.from_env("https://localhost", "-", False)
    if not alert.webhook:
        print("DISCORD_WEBHOOK_URL absente ou invalide (voir l'en-tête de ce fichier).", file=sys.stderr)
        return 1
    ok = alert.notify_discord(1, datetime.now(), None, test=True)
    print("Message de test envoyé." if ok else "Échec de l'envoi.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
