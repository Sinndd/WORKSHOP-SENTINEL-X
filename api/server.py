"""API SENTINEL-X — serveur de test (placeholder).

GET  /health          -> 200 tant que le processus répond (healthcheck Docker, sans effet de bord).
GET  /ready           -> 200 si PostgreSQL et Mosquitto sont joignables (TCP), 503 sinon.
POST /api/v1/alerts   -> 501 : à implémenter par l'équipe DEV (même schéma que le
                         payload MQTT "alerts", cf. docs/CONTRAT-MQTT.md).
Variables disponibles pour la vraie API : PGHOST, PGDATABASE, PGUSER (sentinel_app),
PGPASSWORD, MQTT_HOST, MQTT_PORT, MQTT_USERNAME (api), MQTT_PASSWORD, MQTT_CAFILE.
"""
import json
import os
import signal
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEPS = {
    "db": (os.environ.get("PGHOST", "postgres"), int(os.environ.get("PGPORT", "5432"))),
    "mqtt": (os.environ.get("MQTT_HOST", "mosquitto"), int(os.environ.get("MQTT_PORT", "8883"))),
}


def reachable(addr):
    try:
        with socket.create_connection(addr, timeout=2):
            return True
    except OSError:
        return False


class Handler(BaseHTTPRequestHandler):
    server_version = "sentinel-api-placeholder/0.1"

    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self.reply(200, {"status": "ok"})
        elif self.path == "/ready":
            checks = {name: reachable(addr) for name, addr in DEPS.items()}
            ok = all(checks.values())
            self.reply(200 if ok else 503, {"status": "ok" if ok else "degraded", **checks})
        else:
            self.reply(404, {"error": "not_found"})

    def do_POST(self):
        if self.path == "/api/v1/alerts":
            self.reply(501, {"error": "not_implemented", "contract": "docs/CONTRAT-MQTT.md#alerts"})
        else:
            self.reply(404, {"error": "not_found"})

    def log_message(self, fmt, *args):
        if self.path != "/health":  # pas de bruit (et pas d'écritures) pour le healthcheck
            super().log_message(fmt, *args)


if __name__ == "__main__":
    httpd = ThreadingHTTPServer(("0.0.0.0", 8000), Handler)
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=httpd.shutdown).start())
    print("API placeholder sur :8000", flush=True)
    httpd.serve_forever()
