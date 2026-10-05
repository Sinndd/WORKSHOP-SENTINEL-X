"""Configuration par variables d'environnement (fournies par docker-compose.yml / .env).

Base de données : variables libpq standard (PGHOST, PGDATABASE, PGUSER=sentinel_app, PGPASSWORD).
"""
import os

API_TOKEN = os.environ.get("API_TOKEN", "aethercorp-sentinel-2026-secret-token")  # dashboard / opérateur
API_DEVICE_TOKEN = os.environ.get("API_DEVICE_TOKEN", "esp32-sentinel-device-token")    # ESP32 : POST /api/v1/alerts

# Authentification opérateur Dashboard (User / Mot de passe)
DASHBOARD_USER = os.environ.get("DASHBOARD_USER", "admin")
DASHBOARD_PASS = os.environ.get("DASHBOARD_PASS", "sentinel2026")

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
