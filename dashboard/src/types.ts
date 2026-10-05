// Formats renvoyés par l'API (docs/API.md).
export type Severity = "INFO" | "WARNING" | "CRITICAL";

export interface Device {
  node_id: string;
  name: string | null;
  last_seen: string | null;
  last_uptime_ms: number | null;
  last_wifi_rssi_dbm: number | null;
  last_free_heap_bytes: number | null;
}

export interface Telemetry {
  id: number;
  node_id: string;
  ts: string;
  received_at: string;
  temperature_celsius: number | null;
  humidity_percent: number | null;
  gas_raw_ppm: number | null;
  presence_detected: boolean | null;
  airlock_open: boolean | null;
  gas_valve_open: boolean | null;
  ventilation_active: boolean | null;
  barrier_open: boolean | null;
  alarm_active: boolean | null;
  wifi_rssi_dbm: number | null;
  free_heap_bytes: number | null;
}

export interface Stats {
  samples: number;
  temperature_avg: number | null;
  temperature_min: number | null;
  temperature_max: number | null;
  humidity_avg: number | null;
  humidity_min: number | null;
  humidity_max: number | null;
  gas_avg: number | null;
  gas_max: number | null;
  presence_ratio: number | null;
}

export interface Bucket extends Stats {
  bucket: string;
}

export interface Aggregate {
  node_id: string;
  since: string;
  until: string;
  bucket_s: number;
  summary: Stats;
  buckets: Bucket[];
}

export interface Alert {
  id: number;
  node_id: string;
  ts: string;
  received_at: string;
  event_type: string;
  severity: Severity;
  source_sensor: string | null;
  value: number | null;
  details: string | null;
  channel: string;
  acknowledged: boolean;
  acknowledged_at: string | null;
}

export interface AccessEvent {
  id: number;
  ts: string;
  card_uid: string;
  door_id: string | null;
  access_granted: boolean;
  user_name: string | null;
  clearance_level: string | null;
}

export interface CommandLog {
  id: number;
  created_at: string;
  topic: string;
  action: string | null;
  payload: Record<string, unknown>;
}
