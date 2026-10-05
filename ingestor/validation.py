"""Validation des messages MQTT du contrat v2 (docs/CONTRAT-MQTT.md).

Volontairement sans dépendance (pas de pydantic) pour limiter la RAM sur le Pi.
Toute non-conformité lève ValidationError : le message est rejeté et journalisé.
Champs inconnus : tolérés et ignorés (ex. "type": "TELEMETRY").
"""
import json
import math
import re
import time

MAX_PAYLOAD_BYTES = 2048
MIN_EPOCH_S = 1_704_067_200        # 01/01/2024 : en dessous, ce n'est pas un epoch NTP
MAX_CLOCK_SKEW_S = 300

NODE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$")
EVENT_TYPES = {"INTRUSION_DETECTED", "GAS_LEAK_WARNING", "THERMAL_RUNAWAY", "UNAUTHORIZED_ACCESS"}
SEVERITIES = {"INFO", "WARNING", "CRITICAL"}
ACTUATORS = ("airlock_open", "gas_valve_open", "ventilation_active", "barrier_open", "alarm_active")
TOPICS = {"sentinel/telemetry": "telemetry", "sentinel/alerts": "alerts", "sentinel/vision/events": "vision"}


class ValidationError(ValueError):
    pass


def _field(d, key, kind, *, lo=None, hi=None, required=True, nullable=False, max_len=None, choices=None,
           pattern=None):
    if not isinstance(d, dict):
        raise ValidationError(f"objet attendu pour {key}")
    if key not in d:
        if required:
            raise ValidationError(f"champ manquant: {key}")
        return None
    val = d[key]
    if val is None:
        if nullable:
            return None
        raise ValidationError(f"{key}: null interdit")
    if kind == "bool":
        ok = isinstance(val, bool)
    elif kind == "int":
        ok = isinstance(val, int) and not isinstance(val, bool)
    elif kind == "num":
        ok = isinstance(val, (int, float)) and not isinstance(val, bool) and math.isfinite(val)
    elif kind == "str":
        ok = isinstance(val, str)
    elif kind == "obj":
        ok = isinstance(val, dict)
    else:
        raise AssertionError(kind)
    if not ok:
        raise ValidationError(f"{key}: type {kind} attendu")
    if lo is not None and val < lo:
        raise ValidationError(f"{key}: {val} < {lo}")
    if hi is not None and val > hi:
        raise ValidationError(f"{key}: {val} > {hi}")
    if max_len is not None and len(val) > max_len:
        raise ValidationError(f"{key}: longueur > {max_len}")
    if choices is not None and val not in choices:
        raise ValidationError(f"{key}: valeur inconnue {val!r}")
    if pattern is not None and not pattern.match(val):
        raise ValidationError(f"{key}: format invalide {val!r}")
    return val


def resolve_ts(device_timestamp, now):
    """Horodatage de référence (epoch s) à partir du champ "timestamp" de l'ESP.

    Epoch en secondes ou en millisecondes s'il est plausible ; sinon (ex. millis()
    depuis le démarrage, NTP absent) on retient l'heure de réception du serveur.
    """
    if device_timestamp is None:
        return now
    for candidate in (device_timestamp, device_timestamp / 1000):
        if MIN_EPOCH_S <= candidate <= now + MAX_CLOCK_SKEW_S:
            return candidate
    return now


def validate(topic, payload, now=None):
    """Valide un message brut. Retourne (kind, données normalisées, dict brut)."""
    now = time.time() if now is None else now
    kind = TOPICS.get(topic)
    if kind is None:
        raise ValidationError(f"topic hors contrat: {topic}")
    if len(payload) > MAX_PAYLOAD_BYTES:
        raise ValidationError(f"payload trop gros ({len(payload)} o)")
    try:
        raw = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValidationError(f"JSON invalide: {exc}") from None
    if not isinstance(raw, dict):
        raise ValidationError("objet JSON attendu")

    if kind == "telemetry":
        metrics = _field(raw, "metrics", "obj")
        actuators = _field(raw, "actuators_state", "obj", required=False) or {}
        system = _field(raw, "system", "obj", required=False) or {}
        data = {
            "node_id": _field(raw, "node_id", "str", pattern=NODE_ID_RE),
            "device_timestamp": _field(raw, "timestamp", "int", lo=0),
            "uptime_ms": _field(raw, "uptime_ms", "int", lo=0, required=False),
            "temperature_celsius": _field(metrics, "temperature_celsius", "num", lo=-40, hi=80, nullable=True),
            "humidity_percent": _field(metrics, "humidity_percent", "num", lo=0, hi=100, nullable=True),
            "gas_raw_ppm": _field(metrics, "gas_raw_ppm", "int", lo=0, hi=4095),
            "presence_detected": _field(metrics, "presence_detected", "bool"),
            "wifi_rssi_dbm": _field(system, "wifi_rssi_dbm", "int", lo=-120, hi=0, required=False),
            "free_heap_bytes": _field(system, "free_heap_bytes", "int", lo=0, required=False),
        }
        for name in ACTUATORS:
            data[name] = _field(actuators, name, "bool", required=False)
        data["ts"] = resolve_ts(data["device_timestamp"], now)
    elif kind == "alerts":
        data = validate_alert(raw, now)
    else:  # vision
        data = {
            "ts": _field(raw, "ts", "num", lo=MIN_EPOCH_S, hi=now + MAX_CLOCK_SKEW_S),
            "label": _field(raw, "label", "str", max_len=64),
            "confidence": _field(raw, "confidence", "num", lo=0, hi=1),
            "frame_w": _field(raw, "frame_w", "int", lo=1, hi=10000),
            "frame_h": _field(raw, "frame_h", "int", lo=1, hi=10000),
            "snapshot_path": _field(raw, "snapshot_path", "str", nullable=True, required=False, max_len=255),
        }
        if not data["label"]:
            raise ValidationError("label vide")
        bbox = raw.get("bbox")
        if (not isinstance(bbox, list) or len(bbox) != 4
                or not all(isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) and x >= 0
                           for x in bbox)):
            raise ValidationError("bbox: [x, y, w, h] numériques >= 0 attendus")
        x, y, w, h = bbox
        if x + w > data["frame_w"] + 1 or y + h > data["frame_h"] + 1:
            raise ValidationError("bbox hors de l'image")
        data["bbox"] = bbox
    return kind, data, raw


def validate_alert(raw, now):
    data = {
        "node_id": _field(raw, "node_id", "str", pattern=NODE_ID_RE),
        "device_timestamp": _field(raw, "timestamp", "int", lo=0, required=False),
        "event_type": _field(raw, "event_type", "str", choices=EVENT_TYPES),
        "severity": _field(raw, "severity", "str", choices=SEVERITIES),
        "source_sensor": _field(raw, "source_sensor", "str", max_len=64, required=False, nullable=True),
        "value": _field(raw, "value", "num", required=False, nullable=True),
        "details": _field(raw, "details", "str", max_len=512, required=False, nullable=True),
    }
    data["ts"] = resolve_ts(data["device_timestamp"], now)
    return data
