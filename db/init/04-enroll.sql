-- Enrôlement de badges depuis le tableau de bord : une demande = un ordre ENROLL_BADGE envoyé à l'ESP32,
-- qui répond sur sentinel/enroll ; l'API rattache alors le badge à l'utilisateur (table badges).
CREATE TABLE IF NOT EXISTS badge_enrollments (
    id               bigserial PRIMARY KEY,
    user_name        text NOT NULL CHECK (length(user_name) BETWEEN 1 AND 128),
    clearance_level  text NOT NULL CHECK (length(clearance_level) BETWEEN 1 AND 64),
    auto_unlock_door boolean NOT NULL DEFAULT true,
    status           text NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING', 'SUCCESS', 'FAILED', 'TIMEOUT', 'CANCELLED')),
    card_uid         text CHECK (card_uid ~ '^[0-9A-F]{2}(:[0-9A-F]{2}){3,9}$'),
    error            text CHECK (length(error) <= 200),
    created_at       timestamptz NOT NULL DEFAULT now(),
    expires_at       timestamptz NOT NULL,
    finished_at      timestamptz
);
CREATE INDEX IF NOT EXISTS badge_enrollments_status_idx ON badge_enrollments (status, created_at DESC);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentinel_app') THEN
        GRANT SELECT, INSERT, UPDATE ON badge_enrollments TO sentinel_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sentinel_app;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentinel_ro') THEN
        GRANT SELECT ON badge_enrollments TO sentinel_ro;
    END IF;
END $$;
