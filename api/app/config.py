"""Configuration par variables d'environnement (fournies par docker-compose.yml / .env).

Base de données : variables libpq standard (PGHOST, PGDATABASE, PGUSER=sentinel_app, PGPASSWORD).
"""
import os

# Jetons de service (aucune valeur par défaut : un secret absent doit faire échouer le démarrage).
API_TOKEN = os.environ["API_TOKEN"]                  # automates / scripts : rôle « operator », jamais « admin »
API_DEVICE_TOKEN = os.environ["API_DEVICE_TOKEN"]    # ESP32 : POST /api/v1/alerts

# Premier compte administrateur, créé uniquement si la table users est vide (changement de mot de passe imposé).
DASHBOARD_USER = os.environ.get("DASHBOARD_USER", "admin")
DASHBOARD_PASS = os.environ.get("DASHBOARD_PASS", "")


def _int(name: str, default: int) -> int:
    return int(os.environ.get(name, default))


# Sessions : inactivité et durée de vie absolue.
SESSION_IDLE_MIN = _int("SESSION_IDLE_MIN", 30)
SESSION_ABSOLUTE_H = _int("SESSION_ABSOLUTE_H", 12)
MAX_SESSIONS_PER_USER = _int("MAX_SESSIONS_PER_USER", 10)

# Pause après échecs : LOGIN_MAX_FAILS échecs consécutifs -> le compte attend LOCK_BASE_S secondes, doublées à chaque
# pause successive (plafond LOCK_MAX_S). Remis à zéro par une connexion réussie. Courte : ce n'est pas un bannissement.
LOGIN_MAX_FAILS = _int("LOGIN_MAX_FAILS", 5)
LOCK_BASE_S = _int("LOCK_BASE_S", 30)
LOCK_MAX_S = _int("LOCK_MAX_S", 300)
# Limite de débit des connexions par adresse IP (sans ban, sans alerte) : au-delà, HTTP 429 jusqu'à la minute suivante.
LOGIN_RATE_PER_MIN = _int("LOGIN_RATE_PER_MIN", 10)

# Blocage d'une adresse IP (DÉSACTIVÉ par défaut : IP_BLOCKING=on pour l'activer) : trop d'échecs, ou trop d'identifiants différents (credential stuffing), dans la fenêtre.
IP_BLOCKING = os.environ.get("IP_BLOCKING", "off").lower() in ("on", "1", "true", "yes")
IP_FAIL_THRESHOLD = _int("IP_FAIL_THRESHOLD", 20)
IP_USERNAME_THRESHOLD = _int("IP_USERNAME_THRESHOLD", 6)
IP_WINDOW_S = _int("IP_WINDOW_S", 600)
IP_BLOCK_MIN = _int("IP_BLOCK_MIN", 15)
# Reverse proxys de confiance (liste séparée par des virgules) : seuls eux peuvent fournir X-Forwarded-For.
TRUSTED_PROXIES = {p.strip() for p in os.environ.get("TRUSTED_PROXIES", "").split(",") if p.strip()}

# API_DOCS=off : masque /docs, /redoc et /openapi.json (inutiles en production, ils décrivent toute la surface d'attaque).
API_DOCS = os.environ.get("API_DOCS", "on").lower() not in ("off", "0", "false", "no")

MQTT_HOST = os.environ.get("MQTT_HOST", "mosquitto")
MQTT_PORT = int(os.environ.get("MQTT_PORT", "8883"))
MQTT_CAFILE = os.environ.get("MQTT_CAFILE", "/certs/ca.crt")
MQTT_USERNAME = os.environ.get("MQTT_USERNAME", "api")
MQTT_PASSWORD = os.environ["MQTT_PASSWORD"]

# 6 moteurs pas-à-pas (05_PILOTAGE_6_MOTEURS_SIMULTANES.md), indices 0 à MOTOR_COUNT-1.
MOTOR_COUNT = int(os.environ.get("MOTOR_COUNT", "6"))
DB_POOL_MAX = int(os.environ.get("DB_POOL_MAX", "4"))

TOPIC_ACCESS = "sentinel/access"
TOPIC_ACCESS_RESPONSE = "sentinel/access/response"
TOPIC_COMMANDS = "sentinel/commands"
