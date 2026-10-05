"""Pool de connexions PostgreSQL (rôle sentinel_app), partagé par les routes et le pont MQTT."""
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from . import config

# conninfo vide : paramètres lus dans l'environnement libpq. 4 connexions max (max_connections=15 côté serveur).
pool = ConnectionPool(
    conninfo="",
    min_size=1,
    max_size=config.DB_POOL_MAX,
    timeout=5,
    open=False,
    check=ConnectionPool.check_connection,   # reconnexion transparente après un redémarrage de PostgreSQL
    kwargs={"autocommit": True, "row_factory": dict_row, "application_name": "api"},
    name="api",
)

SQL_ENSURE_DEVICE = "INSERT INTO devices (node_id) VALUES (%s) ON CONFLICT DO NOTHING"
