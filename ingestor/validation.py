"""Validation des messages du contrat MQTT v1 (docs/CONTRAT-MQTT.md).

Volontairement sans dépendance (pas de pydantic) pour limiter la RAM sur le Pi.
Toute non-conformité lève ValidationError : le message est rejeté et journalisé.
"""
import ipaddress
import json
import math
import re
import time

SCHEMA_VERSION = 1
MAX_PAYLOAD_BYTES = 1024
# Avant 2024 : l'horloge de l'émetteur n'est pas synchronisée (NTP obligatoire).
MIN_TS = 1_704_067_200
MAX_CLOCK_SKEW_S = 300

DEVICE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
ALERT_TYPES = {"gas_high", "temp_high", "motion_detected", "sensor_fault", "tamper"}
SEVERITIES = {"info", "warning", "critical"}
STATES = {"online", "offline"}


class ValidationError(ValueError):
    pass


def _field(d, key, kind, *, lo=None, hi=None, required=True, nullable=False, max_len=None, choices=None):
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
    return val


def _ts(d, now):
    return _field(d, "ts", "num", lo=MIN_TS, hi=now + MAX_CLOCK_SKEW_S)


def _check_device(d, topic_device):
    device_id = _field(d, "device_id", "str")
    if device_id != topic_device:
        raise ValidationError(f"device_id {device_id!r} != topic {topic_device!r}")


def parse_topic(topic):
    """Retourne (kind, device_id) ou lève ValidationError."""
    parts = topic.split("/")
    if len(parts) == 3 and parts[0] == "sentinel":
        if parts[1:] == ["vision", "events"]:
            return "vision", None
        if parts[2] in ("telemetry", "alerts", "status") and DEVICE_ID_RE.match(parts[1]):
            return parts[2], parts[1]
    raise ValidationError(f"topic hors contrat: {topic}")


def validate(topic, payload, now=None):
    """Valide un message brut. Retourne (kind, device_id, data normalisée, dict brut)."""
    now = time.time() if now is None else now
    kind, device_id = parse_topic(topic)
    if len(payload) > MAX_PAYLOAD_BYTES:
        raise ValidationError(f"payload trop gros ({len(payload)} o)")
    try:
        raw = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValidationError(f"JSON invalide: {exc}") from None
    if not isinstance(raw, dict):
        raise ValidationError("objet JSON attendu")
    v = raw.get("v")
    if isinstance(v, bool) or v != SCHEMA_VERSION:
        raise ValidationError(f"version de schéma non supportée: v={v!r}")

    f = raw
    if kind == "telemetry":
        _check_device(f, device_id)
        data = {
            "ts": _ts(f, now),
            "seq": _field(f, "seq", "int", lo=0),
            "temperature_c": _field(f, "temperature_c", "num", lo=-40, hi=80, nullable=True),
            "humidity_pct": _field(f, "humidity_pct", "num", lo=0, hi=100, nullable=True),
            "gas_raw": _field(f, "gas_raw", "int", lo=0, hi=1023),
            "motion": _field(f, "motion", "bool"),
            "rssi_dbm": _field(f, "rssi_dbm", "int", lo=-120, hi=0),
            "uptime_s": _field(f, "uptime_s", "int", lo=0),
        }
    elif kind == "alerts":
        _check_device(f, device_id)
        data = {
            "ts": _ts(f, now),
            "type": _field(f, "type", "str", choices=ALERT_TYPES),
            "severity": _field(f, "severity", "str", choices=SEVERITIES),
            "value": _field(f, "value", "num", nullable=True),
            "threshold": _field(f, "threshold", "num", nullable=True),
            "message": _field(f, "message", "str", max_len=256),
        }
    elif kind == "status":
        data = {
            "state": _field(f, "state", "str", choices=STATES),
            "ip": _field(f, "ip", "str", required=False, nullable=True, max_len=15),
            "fw": _field(f, "fw", "str", required=False, nullable=True, max_len=32),
        }
        if data["ip"] is not None:
            try:
                ipaddress.IPv4Address(data["ip"])
            except ValueError:
                raise ValidationError(f"ip invalide: {data['ip']!r}") from None
        if data["state"] == "online" and (data["ip"] is None or data["fw"] is None):
            raise ValidationError("status online: ip et fw obligatoires")
    else:  # vision
        data = {
            "ts": _ts(f, now),
            "label": _field(f, "label", "str", max_len=64),
            "confidence": _field(f, "confidence", "num", lo=0, hi=1),
            "frame_w": _field(f, "frame_w", "int", lo=1, hi=10000),
            "frame_h": _field(f, "frame_h", "int", lo=1, hi=10000),
            "snapshot_path": _field(f, "snapshot_path", "str", nullable=True, required=False, max_len=255),
        }
        if not data["label"]:
            raise ValidationError("label vide")
        bbox = f.get("bbox")
        if (not isinstance(bbox, list) or len(bbox) != 4
                or not all(isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) and x >= 0
                           for x in bbox)):
            raise ValidationError("bbox: [x, y, w, h] numériques >= 0 attendus")
        x, y, w, h = bbox
        if x + w > data["frame_w"] + 1 or y + h > data["frame_h"] + 1:
            raise ValidationError("bbox hors de l'image")
        data["bbox"] = bbox
    return kind, device_id, data, raw
