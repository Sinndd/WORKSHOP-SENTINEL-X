-- SENTINEL-X — schéma initial v2 (exécuté une seule fois, à la création du volume pgdata).
-- Référentiel : docs/CONTRAT-MQTT.md (issu des spécifications ESP32 03_SPECIFICATION_API / 03_CONTRAT).
-- Les noms de colonnes reprennent les noms de champs JSON du contrat.

-- Nœuds ESP32 (ex. SENTINEL-X-CORE), créés automatiquement au premier message.
CREATE TABLE devices (
    node_id              text PRIMARY KEY CHECK (node_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$'),
    name                 text,
    last_seen            timestamptz,
    last_uptime_ms       bigint,
    last_wifi_rssi_dbm   smallint,
    last_free_heap_bytes integer
);

-- Télémétrie périodique (topic sentinel/telemetry, toutes les 2 s).
CREATE TABLE telemetry (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    node_id             text NOT NULL REFERENCES devices (node_id) ON UPDATE CASCADE,
    ts                  timestamptz NOT NULL,      -- timestamp ESP s'il est un epoch valide, sinon received_at
    device_timestamp    bigint NOT NULL,           -- champ "timestamp" brut envoyé par l'ESP
    received_at         timestamptz NOT NULL DEFAULT now(),
    uptime_ms           bigint CHECK (uptime_ms >= 0),
    temperature_celsius real     CHECK (temperature_celsius BETWEEN -40 AND 80),
    humidity_percent    real     CHECK (humidity_percent BETWEEN 0 AND 100),
    gas_raw_ppm         smallint CHECK (gas_raw_ppm BETWEEN 0 AND 4095),   -- ADC 12 bits brut
    presence_detected   boolean,
    airlock_open        boolean,
    gas_valve_open      boolean,
    ventilation_active  boolean,
    barrier_open        boolean,
    alarm_active        boolean,
    wifi_rssi_dbm       smallint CHECK (wifi_rssi_dbm BETWEEN -120 AND 0),
    free_heap_bytes     integer  CHECK (free_heap_bytes >= 0)
);
CREATE INDEX telemetry_node_ts_idx ON telemetry (node_id, ts DESC);

-- Alertes critiques (POST /api/v1/alerts ou topic sentinel/alerts).
CREATE TABLE alerts (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    node_id          text NOT NULL REFERENCES devices (node_id) ON UPDATE CASCADE,
    ts               timestamptz NOT NULL,
    device_timestamp bigint,
    received_at      timestamptz NOT NULL DEFAULT now(),
    event_type       text NOT NULL CHECK (event_type IN
                       ('INTRUSION_DETECTED', 'GAS_LEAK_WARNING', 'THERMAL_RUNAWAY', 'UNAUTHORIZED_ACCESS')),
    severity         text NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
    source_sensor    text CHECK (length(source_sensor) <= 64),
    value            double precision,
    details          text CHECK (length(details) <= 512),
    channel          text NOT NULL CHECK (channel IN ('http', 'mqtt', 'server')),
    payload          jsonb NOT NULL,                -- message brut validé (audit)
    acknowledged     boolean NOT NULL DEFAULT false,
    acknowledged_at  timestamptz
);
CREATE INDEX alerts_node_ts_idx ON alerts (node_id, ts DESC);
CREATE INDEX alerts_unack_idx   ON alerts (ts DESC) WHERE NOT acknowledged;

-- Badges RFID autorisés (gérés par l'API). Révocation : active = false.
CREATE TABLE badges (
    card_uid         text PRIMARY KEY CHECK (card_uid ~ '^[0-9A-F]{2}(:[0-9A-F]{2}){3,9}$'),
    user_name        text NOT NULL CHECK (length(user_name) BETWEEN 1 AND 128),
    clearance_level  text NOT NULL CHECK (length(clearance_level) BETWEEN 1 AND 64),
    auto_unlock_door boolean NOT NULL DEFAULT true,
    active           boolean NOT NULL DEFAULT true,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Journal des passages de badge et décisions du serveur (topic sentinel/access).
CREATE TABLE access_events (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    node_id          text NOT NULL REFERENCES devices (node_id) ON UPDATE CASCADE,
    ts               timestamptz NOT NULL,
    device_timestamp bigint,
    received_at      timestamptz NOT NULL DEFAULT now(),
    card_uid         text NOT NULL,
    card_type        text,
    door_id          text,
    access_granted   boolean NOT NULL,
    user_name        text,
    clearance_level  text
);
CREATE INDEX access_events_ts_idx ON access_events (ts DESC);

-- Traçabilité des commandes envoyées à l'ESP32 (topics sentinel/commands, sentinel/access/response).
CREATE TABLE commands (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now(),
    topic      text NOT NULL,
    action     text,
    payload    jsonb NOT NULL
);
CREATE INDEX commands_created_idx ON commands (created_at DESC);

-- Détections de la caméra (script IA, topic sentinel/vision/events).
CREATE TABLE vision_events (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ts            timestamptz NOT NULL,
    received_at   timestamptz NOT NULL DEFAULT now(),
    label         text NOT NULL CHECK (length(label) BETWEEN 1 AND 64),
    confidence    real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    bbox          jsonb NOT NULL,                             -- [x, y, w, h] en pixels
    frame_w       integer NOT NULL CHECK (frame_w > 0),
    frame_h       integer NOT NULL CHECK (frame_h > 0),
    snapshot_path text CHECK (length(snapshot_path) <= 255)
);
CREATE INDEX vision_events_ts_idx ON vision_events (ts DESC);

INSERT INTO devices (node_id, name) VALUES ('SENTINEL-X-CORE', 'Module unique ESP32 SENTINEL-X');
