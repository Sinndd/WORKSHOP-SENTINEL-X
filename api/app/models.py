"""Schémas du contrat v2 (docs/CONTRAT-MQTT.md), validés strictement.

strict=True : aucun transtypage silencieux ("12" n'est pas un entier, 1 n'est pas un booléen).
extra="ignore" : champs inconnus tolérés et ignorés (compatibilité ascendante).
"""
import time
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, StringConstraints, field_validator

from . import config

MIN_EPOCH_S = 1_704_067_200
MAX_CLOCK_SKEW_S = 300

CARD_UID_RE = r"^[0-9A-F]{2}(:[0-9A-F]{2}){3,9}$"


def _upper(value):
    return value.upper() if isinstance(value, str) else value


NodeId = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$")]
# Format "A3:5F:B2:1C" (4, 7 ou 10 octets), normalisé en majuscules.
CardUid = Annotated[str, BeforeValidator(_upper), StringConstraints(pattern=CARD_UID_RE)]
Code = Annotated[str, StringConstraints(pattern=r"^[A-Z0-9_]{1,32}$")]
EventType = Literal["INTRUSION_DETECTED", "GAS_LEAK_WARNING", "THERMAL_RUNAWAY", "UNAUTHORIZED_ACCESS"]
Severity = Literal["INFO", "WARNING", "CRITICAL"]


class Strict(BaseModel):
    model_config = ConfigDict(strict=True, extra="ignore", allow_inf_nan=False)


def resolve_ts(device_timestamp: int | None, now: float | None = None) -> float:
    """Epoch (s) de référence : "timestamp" de l'ESP s'il est un epoch plausible (s ou ms),
    sinon l'heure de réception (le firmware actuel envoie millis() depuis le démarrage)."""
    now = time.time() if now is None else now
    if device_timestamp is not None:
        for candidate in (device_timestamp, device_timestamp / 1000):
            if MIN_EPOCH_S <= candidate <= now + MAX_CLOCK_SKEW_S:
                return candidate
    return now


# --- Messages émis par l'ESP32 -------------------------------------------------------
class AlertIn(Strict):
    """POST /api/v1/alerts et topic sentinel/alerts (03_SPECIFICATION § 1.B)."""
    node_id: NodeId
    timestamp: Annotated[int, Field(ge=0)] | None = None
    event_type: EventType
    severity: Severity
    source_sensor: Annotated[str, Field(max_length=64)] | None = None
    value: float | None = None
    details: Annotated[str, Field(max_length=512)] | None = None

    model_config = ConfigDict(json_schema_extra={"examples": [{
        "node_id": "SENTINEL-X-CORE", "timestamp": 1728132045, "event_type": "INTRUSION_DETECTED",
        "severity": "CRITICAL", "source_sensor": "PIR_MOTION", "value": 1.0,
        "details": "Mouvement anormal detecte dans le perimetre d'acces restreint"}]})


class AccessScan(Strict):
    """Topic sentinel/access (03_SPECIFICATION § 1.C)."""
    node_id: NodeId
    timestamp: Annotated[int, Field(ge=0)] | None = None
    card_uid: CardUid
    card_type: Annotated[str, Field(max_length=32)] | None = None
    door_id: Annotated[str, Field(max_length=32)] | None = None


# --- Commandes envoyées à l'ESP32 (topic sentinel/commands) -----------------------------
class OperateMotor(Strict):
    """03_SPECIFICATION § 2.A."""
    action: Literal["OPERATE_MOTOR"]
    target: Literal["AIRLOCK_MAIN", "GAS_VALVE", "BARRIER", "VENT"]
    command: Literal["OPEN", "CLOSE", "STOP"]
    duration_ms: Annotated[int, Field(ge=1, le=60_000)] | None = None


class MotorStep(Strict):
    motor_id: Annotated[int, Field(ge=0)]
    direction: Literal["CW", "CCW"]
    angle_deg: Annotated[int, Field(ge=1, le=3600)]
    speed_rpm: Annotated[int, Field(ge=1, le=15)]    # 28BYJ-48 : ~15 tr/min maximum

    @field_validator("motor_id")
    @classmethod
    def _motor_exists(cls, v: int) -> int:
        if v >= config.MOTOR_COUNT:
            raise ValueError(f"motor_id doit être compris entre 0 et {config.MOTOR_COUNT - 1}")
        return v


class ControlMotors(Strict):
    """03_CONTRAT § 3.A : plusieurs moteurs simultanément."""
    action: Literal["CONTROL_MOTORS"]
    commands: Annotated[list[MotorStep], Field(min_length=1, max_length=6)]

    @field_validator("commands")
    @classmethod
    def _unique_motors(cls, v: list[MotorStep]) -> list[MotorStep]:
        if len({c.motor_id for c in v}) != len(v):
            raise ValueError("un même motor_id ne peut apparaître qu'une fois")
        return v


class EmergencyStopAll(Strict):
    """03_CONTRAT § 3.B."""
    action: Literal["EMERGENCY_STOP_ALL"]


class TriggerAlarm(Strict):
    """03_SPECIFICATION § 2.B."""
    action: Literal["TRIGGER_ALARM"]
    state: bool
    color: Code | None = None
    sound: Code | None = None


Command = Annotated[OperateMotor | ControlMotors | EmergencyStopAll | TriggerAlarm, Field(discriminator="action")]


# --- Authentification Opérateur --------------------------------------------------------
class LoginRequest(Strict):
    username: str
    password: str


class LoginResponse(BaseModel):
    token: str
    username: str
    role: str = "operator"


class AirlockAction(Strict):
    state: bool  # True = OPEN, False = CLOSE
    duration_ms: Annotated[int, Field(ge=1, le=60_000)] = 3000


class AlarmAction(Strict):
    state: bool
    color: Code | None = "RED"
    sound: Code | None = "SIREN_ALERT"


# --- Gestion des badges ---------------------------------------------------------------
class BadgeIn(Strict):
    user_name: Annotated[str, Field(min_length=1, max_length=128)]
    clearance_level: Annotated[str, Field(min_length=1, max_length=64)]
    auto_unlock_door: bool = True
    active: bool = True


# --- Réponses ---------------------------------------------------------------------------
class AlertOut(BaseModel):
    id: int
    node_id: str
    ts: datetime
    received_at: datetime
    event_type: str
    severity: str
    source_sensor: str | None
    value: float | None
    details: str | None
    channel: str
    acknowledged: bool
    acknowledged_at: datetime | None


class TelemetryOut(BaseModel):
    id: int
    node_id: str
    ts: datetime
    device_timestamp: int
    received_at: datetime
    uptime_ms: int | None
    temperature_celsius: float | None
    humidity_percent: float | None
    gas_raw_ppm: int | None
    presence_detected: bool | None
    airlock_open: bool | None
    gas_valve_open: bool | None
    ventilation_active: bool | None
    barrier_open: bool | None
    alarm_active: bool | None
    wifi_rssi_dbm: int | None
    free_heap_bytes: int | None


class DeviceOut(BaseModel):
    node_id: str
    name: str | None
    last_seen: datetime | None
    last_uptime_ms: int | None
    last_wifi_rssi_dbm: int | None
    last_free_heap_bytes: int | None


class BadgeOut(BaseModel):
    card_uid: str
    user_name: str
    clearance_level: str
    auto_unlock_door: bool
    active: bool
    created_at: datetime
    updated_at: datetime


class AccessEventOut(BaseModel):
    id: int
    node_id: str
    ts: datetime
    received_at: datetime
    card_uid: str
    card_type: str | None
    door_id: str | None
    access_granted: bool
    user_name: str | None
    clearance_level: str | None


class CommandOut(BaseModel):
    id: int
    created_at: datetime
    topic: str
    action: str | None
    payload: dict


class VisionEventOut(BaseModel):
    id: int
    ts: datetime
    received_at: datetime
    label: str
    confidence: float
    bbox: list[float]
    frame_w: int
    frame_h: int
    snapshot_path: str | None


class TelemetryStats(BaseModel):
    samples: int
    temperature_avg: float | None
    temperature_min: float | None
    temperature_max: float | None
    humidity_avg: float | None
    humidity_min: float | None
    humidity_max: float | None
    gas_avg: float | None
    gas_max: int | None
    presence_ratio: float | None          # part des mesures avec présence détectée (0..1)


class TelemetryBucket(TelemetryStats):
    bucket: datetime                      # début de l'intervalle


class TelemetryAggregate(BaseModel):
    node_id: str
    since: datetime
    until: datetime
    bucket_s: int
    summary: TelemetryStats
    buckets: list[TelemetryBucket]
