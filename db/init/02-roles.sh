#!/bin/sh
# Rôles applicatifs (le superuser "postgres" n'est utilisé que pour l'init et les sauvegardes).
#   sentinel_app : SELECT/INSERT/UPDATE  -> API + ingestor
#   sentinel_ro  : SELECT seul           -> IA + dashboard
# Les mots de passe sont lus dans l'environnement par \getenv (jamais en argument de commande).
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'EOSQL'
\getenv app_pw SENTINEL_APP_PASSWORD
\getenv ro_pw  SENTINEL_RO_PASSWORD
\getenv db     POSTGRES_DB

CREATE ROLE sentinel_app LOGIN PASSWORD :'app_pw' CONNECTION LIMIT 8;
CREATE ROLE sentinel_ro  LOGIN PASSWORD :'ro_pw'  CONNECTION LIMIT 4;

REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO sentinel_app, sentinel_ro;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO sentinel_app, sentinel_ro;

GRANT SELECT, INSERT, UPDATE ON ALL TABLES    IN SCHEMA public TO sentinel_app;
GRANT USAGE, SELECT          ON ALL SEQUENCES IN SCHEMA public TO sentinel_app;
GRANT SELECT                 ON ALL TABLES    IN SCHEMA public TO sentinel_ro;

-- Tables créées plus tard par le superuser (migrations) : mêmes droits.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES    TO sentinel_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT          ON SEQUENCES TO sentinel_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT                 ON TABLES    TO sentinel_ro;

-- Garde-fous : lecture seule forcée, requêtes bornées (RAM/CPU du Pi).
ALTER ROLE sentinel_ro  SET default_transaction_read_only = on;
ALTER ROLE sentinel_ro  SET statement_timeout = '30s';
ALTER ROLE sentinel_app SET statement_timeout = '10s';
EOSQL
