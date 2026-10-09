-- SENTINEL-X — visages autorisés (reconnaissance faciale), gérés depuis le tableau de bord.
-- Idempotent : exécuté à la création du volume ET par scripts/migrate-db.sh sur une base existante.
-- Donnée biométrique (RGPD art. 9) : seuls des vecteurs de 128 nombres sont conservés, jamais les photos
-- (une photo envoyée est effacée dès qu'elle a été traitée). Consentement obligatoire, suppression réelle possible.

CREATE TABLE IF NOT EXISTS face_members (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
    active      boolean NOT NULL DEFAULT true,
    consent     boolean NOT NULL CHECK (consent),           -- accord de la personne photographiée
    created_by  text,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS face_members_name_idx ON face_members (lower(name));

CREATE TABLE IF NOT EXISTS face_embeddings (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    member_id  bigint NOT NULL REFERENCES face_members (id) ON DELETE CASCADE,
    embedding  double precision[] NOT NULL CHECK (array_length(embedding, 1) = 128),
    source     text NOT NULL CHECK (source IN ('camera', 'photo')),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS face_embeddings_member_idx ON face_embeddings (member_id);

-- Une demande = un travail pour le script de vision (seul à disposer du modèle de reconnaissance).
CREATE TABLE IF NOT EXISTS face_enrollments (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    member_id      bigint NOT NULL REFERENCES face_members (id) ON DELETE CASCADE,
    mode           text NOT NULL CHECK (mode IN ('camera', 'photo')),
    samples_target integer NOT NULL CHECK (samples_target BETWEEN 1 AND 10),
    samples_done   integer NOT NULL DEFAULT 0,
    status         text NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING', 'SUCCESS', 'FAILED', 'TIMEOUT', 'CANCELLED')),
    photo          bytea,                                    -- mode « photo » : effacée (NULL) dès la fin du traitement
    error          text CHECK (length(error) <= 200),
    requested_by   text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    expires_at     timestamptz NOT NULL,
    finished_at    timestamptz
);
CREATE INDEX IF NOT EXISTS face_enrollments_status_idx ON face_enrollments (status, created_at DESC);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentinel_app') THEN
        -- DELETE accordé ici (effacement réel des données biométriques) ; les journaux d'audit restent sans DELETE.
        GRANT SELECT, INSERT, UPDATE, DELETE ON face_members, face_embeddings, face_enrollments TO sentinel_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sentinel_app;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentinel_ro') THEN
        REVOKE ALL ON face_members, face_embeddings, face_enrollments FROM sentinel_ro;   -- biométrie : jamais en lecture IA/dashboard
    END IF;
END $$;
