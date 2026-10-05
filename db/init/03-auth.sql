-- SENTINEL-X — comptes utilisateurs, sessions et journal de sécurité.
-- Idempotent (IF NOT EXISTS) : exécuté à la création du volume ET par scripts/migrate-db.sh sur une base existante.
-- Exécuté par le superuser : sentinel_app reçoit SELECT/INSERT/UPDATE (privilèges par défaut de 02-roles.sh),
-- jamais DELETE -> le journal d'audit est append-only pour l'application.

CREATE TABLE IF NOT EXISTS users (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username            text NOT NULL CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,31}$'),
    full_name           text NOT NULL CHECK (length(full_name) BETWEEN 1 AND 128),  -- personne physique (plusieurs comptes possibles)
    role                text NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
    active              boolean NOT NULL DEFAULT true,
    password_hash       text NOT NULL,                       -- scrypt$n$r$p$sel$hash
    must_change_password boolean NOT NULL DEFAULT true,
    password_changed_at timestamptz,
    failed_attempts     integer NOT NULL DEFAULT 0,
    lockouts            integer NOT NULL DEFAULT 0,          -- verrouillages successifs (durée croissante)
    locked_until        timestamptz,
    last_login_at       timestamptz,
    last_login_ip       text,
    totp_secret         text,                                -- base32 ; actif seulement si totp_enabled
    totp_enabled        boolean NOT NULL DEFAULT false,
    totp_last_step      bigint,                              -- anti-rejeu du code à 6 chiffres
    created_at          timestamptz NOT NULL DEFAULT now(),
    created_by          text
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_idx ON users (username);
CREATE INDEX IF NOT EXISTS users_full_name_idx ON users (lower(full_name));

-- Sessions : seul le SHA-256 du jeton est stocké (une fuite de la base ne donne aucun jeton utilisable).
CREATE TABLE IF NOT EXISTS sessions (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     bigint NOT NULL REFERENCES users (id),
    token_hash  text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    last_seen   timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,                        -- durée de vie absolue
    ip          text,
    user_agent  text,
    revoked_at  timestamptz,
    revoked_by  text
);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_idx ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

-- Journal de sécurité (connexions, échecs, verrouillages, intrusions, administration).
CREATE TABLE IF NOT EXISTS security_events (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ts         timestamptz NOT NULL DEFAULT now(),
    event_type text NOT NULL CHECK (length(event_type) <= 48),
    severity   text NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
    username   text CHECK (length(username) <= 64),
    actor      text CHECK (length(actor) <= 64),            -- compte qui a effectué l'action d'administration
    ip         text CHECK (length(ip) <= 64),
    user_agent text CHECK (length(user_agent) <= 256),
    details    text CHECK (length(details) <= 512)
);
CREATE INDEX IF NOT EXISTS security_events_ts_idx ON security_events (ts DESC);
CREATE INDEX IF NOT EXISTS security_events_type_idx ON security_events (event_type, ts DESC);

-- Les hachés de mots de passe et les sessions ne sont jamais lisibles par le rôle en lecture seule (IA, dashboard).
-- Bloc conditionnel : le rôle n'existe pas encore si ce script est rejoué hors séquence d'initialisation.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentinel_ro') THEN
        REVOKE ALL ON users, sessions FROM sentinel_ro;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentinel_app') THEN
        GRANT SELECT, INSERT, UPDATE ON users, sessions, security_events TO sentinel_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sentinel_app;
    END IF;
END $$;
