-- SENTINEL-X — schéma initial (exécuté une seule fois, à la création du volume pgdata).
-- Source de vérité des payloads : docs/CONTRAT-MQTT.md (schéma v1).

CREATE TABLE devices (
    device_id   text PRIMARY KEY CHECK (device_id ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
    name        text,
    last_seen   timestamptz,
    state       text NOT NULL DEFAULT 'unknown' CHECK (state IN ('online', 'offline', 'unknown')),
    ip          inet,
    fw_version  text CHECK (length(fw_version) <= 32)
);

CREATE TABLE sensor_readings (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    device_id     text NOT NULL REFERENCES devices (device_id) ON UPDATE CASCADE,
    ts            timestamptz NOT NULL,                       -- horodatage ESP (NTP)
    received_at   timestamptz NOT NULL DEFAULT now(),         -- horodatage serveur
    seq           bigint CHECK (seq >= 0),
    temperature_c real     CHECK (temperature_c BETWEEN -40 AND 80),   -- NULL = lecture DHT22 en échec
    humidity_pct  real     CHECK (humidity_pct  BETWEEN 0 AND 100),
    gas_raw       smallint CHECK (gas_raw       BETWEEN 0 AND 1023),
    motion        boolean,
    rssi_dbm      smallint CHECK (rssi_dbm      BETWEEN -120 AND 0),
    uptime_s      bigint   CHECK (uptime_s >= 0)
);
CREATE INDEX sensor_readings_device_ts_idx ON sensor_readings (device_id, ts DESC);

CREATE TABLE alerts (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    device_id    text NOT NULL REFERENCES devices (device_id) ON UPDATE CASCADE,
    ts           timestamptz NOT NULL,
    received_at  timestamptz NOT NULL DEFAULT now(),
    type         text NOT NULL CHECK (type IN ('gas_high', 'temp_high', 'motion_detected', 'sensor_fault', 'tamper')),
    severity     text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
    value        double precision,
    threshold    double precision,
    message      text CHECK (length(message) <= 256),
    payload      jsonb NOT NULL,                              -- message brut validé (audit)
    acknowledged boolean NOT NULL DEFAULT false
);
CREATE INDEX alerts_device_ts_idx ON alerts (device_id, ts DESC);
CREATE INDEX alerts_unack_idx     ON alerts (ts DESC) WHERE NOT acknowledged;

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

INSERT INTO devices (device_id, name) VALUES ('sentinel-01', 'Boîtier SENTINEL-X n°1');
