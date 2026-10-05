"""Endpoints REST /api/v1 (contrat : docs/CONTRAT-MQTT.md, détail : docs/API.md, interactif : /docs)."""
import math
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query
from fastapi.responses import StreamingResponse
from psycopg import sql
from psycopg.types.json import Jsonb

from . import config
from .db import SQL_ENSURE_DEVICE, pool
from .models import (CARD_UID_RE, AccessEventOut, AlertIn, AlertOut, BadgeIn, BadgeOut, Command, CommandOut,
                     DeviceOut, Severity, TelemetryAggregate, TelemetryOut, VisionEventOut, resolve_ts)
from .mqtt_bridge import bridge
from .security import require_device_or_operator, require_operator

router = APIRouter(prefix="/api/v1")
operator = [Depends(require_operator)]
Limit = Annotated[int, Query(ge=1, le=1000)]
CardUidPath = Annotated[str, Path(pattern=CARD_UID_RE.replace("[0-9A-F]", "[0-9A-Fa-f]"),
                                  examples=["A3:5F:B2:1C"])]

ALERT_COLUMNS = ("id, node_id, ts, received_at, event_type, severity, source_sensor, value, details, channel, "
                 "acknowledged, acknowledged_at")


# --- Alertes --------------------------------------------------------------------------------
@router.post("/alerts", status_code=201, response_model=AlertOut, tags=["alertes"],
             dependencies=[Depends(require_device_or_operator)])
def create_alert(alert: AlertIn):
    """Alerte critique émise par l'ESP32 (jeton d'appareil) ou saisie par un opérateur."""
    with pool.connection() as conn, conn.transaction():
        conn.execute(SQL_ENSURE_DEVICE, (alert.node_id,))
        return conn.execute(
            f"""INSERT INTO alerts (node_id, ts, device_timestamp, event_type, severity, source_sensor, value,
                                    details, channel, payload)
                VALUES (%s, to_timestamp(%s), %s, %s, %s, %s, %s, %s, 'http', %s) RETURNING {ALERT_COLUMNS}""",
            (alert.node_id, resolve_ts(alert.timestamp), alert.timestamp, alert.event_type, alert.severity,
             alert.source_sensor, alert.value, alert.details, Jsonb(alert.model_dump()))).fetchone()


@router.get("/alerts", response_model=list[AlertOut], tags=["alertes"], dependencies=operator)
def list_alerts(node_id: str | None = None, severity: Severity | None = None,
                acknowledged: bool | None = None, since: datetime | None = None, limit: Limit = 100):
    with pool.connection() as conn:
        return conn.execute(
            f"""SELECT {ALERT_COLUMNS} FROM alerts
                WHERE (%(node)s::text IS NULL OR node_id = %(node)s)
                  AND (%(sev)s::text IS NULL OR severity = %(sev)s)
                  AND (%(ack)s::boolean IS NULL OR acknowledged = %(ack)s)
                  AND (%(since)s::timestamptz IS NULL OR ts >= %(since)s)
                ORDER BY ts DESC, id DESC LIMIT %(limit)s""",
            {"node": node_id, "sev": severity, "ack": acknowledged, "since": since, "limit": limit}).fetchall()


@router.post("/alerts/{alert_id}/ack", response_model=AlertOut, tags=["alertes"], dependencies=operator)
def acknowledge_alert(alert_id: int):
    with pool.connection() as conn:
        row = conn.execute(
            f"""UPDATE alerts SET acknowledged = true, acknowledged_at = COALESCE(acknowledged_at, now())
                WHERE id = %s RETURNING {ALERT_COLUMNS}""", (alert_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "alerte inconnue")
    return row


# --- Télémétrie et nœuds -------------------------------------------------------------------------
@router.get("/devices", response_model=list[DeviceOut], tags=["télémétrie"], dependencies=operator)
def list_devices():
    with pool.connection() as conn:
        return conn.execute("SELECT * FROM devices ORDER BY node_id").fetchall()


@router.get("/telemetry/latest", response_model=TelemetryOut, tags=["télémétrie"], dependencies=operator)
def latest_telemetry(node_id: str = "SENTINEL-X-CORE"):
    with pool.connection() as conn:
        row = conn.execute("SELECT * FROM telemetry WHERE node_id = %s ORDER BY ts DESC, id DESC LIMIT 1",
                           (node_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "aucune télémétrie pour ce nœud")
    return row


@router.get("/telemetry", response_model=list[TelemetryOut], tags=["télémétrie"], dependencies=operator)
def telemetry_history(node_id: str = "SENTINEL-X-CORE", since: datetime | None = None,
                      until: datetime | None = None,
                      limit: Annotated[int, Query(ge=1, le=5000)] = 500):
    """Historique (plus récent d'abord) : dashboard et modèle IA de maintenance prédictive."""
    with pool.connection() as conn:
        return conn.execute(
            """SELECT * FROM telemetry
               WHERE node_id = %(node)s
                 AND (%(since)s::timestamptz IS NULL OR ts >= %(since)s)
                 AND (%(until)s::timestamptz IS NULL OR ts < %(until)s)
               ORDER BY ts DESC, id DESC LIMIT %(limit)s""",
            {"node": node_id, "since": since, "until": until, "limit": limit}).fetchall()


MAX_RANGE = timedelta(days=31)
STATS_COLUMNS = """count(*) AS samples,
    avg(temperature_celsius) AS temperature_avg, min(temperature_celsius) AS temperature_min,
    max(temperature_celsius) AS temperature_max,
    avg(humidity_percent) AS humidity_avg, min(humidity_percent) AS humidity_min, max(humidity_percent) AS humidity_max,
    avg(gas_raw_ppm) AS gas_avg, max(gas_raw_ppm) AS gas_max,
    avg(presence_detected::int) AS presence_ratio"""


def _range(since: datetime | None, until: datetime | None) -> tuple[datetime, datetime]:
    until = until or datetime.now(timezone.utc)
    since = since or until - timedelta(hours=1)
    if since >= until or until - since > MAX_RANGE:
        raise HTTPException(422, "intervalle invalide (since < until, 31 jours maximum)")
    return since, until


@router.get("/telemetry/aggregate", response_model=TelemetryAggregate, tags=["télémétrie"], dependencies=operator)
def telemetry_aggregate(node_id: str = "SENTINEL-X-CORE", since: datetime | None = None,
                        until: datetime | None = None,
                        points: Annotated[int, Query(ge=10, le=1000)] = 300):
    """Agrégats par intervalle régulier (≈ `points` intervalles) + résumé sur toute la période.

    Pour l'analyse sur de longues périodes sans transférer chaque mesure (défaut : dernière heure)."""
    since, until = _range(since, until)
    bucket_s = max(2, math.ceil((until - since).total_seconds() / points))
    params = {"node": node_id, "since": since, "until": until, "bucket": bucket_s}
    where = "node_id = %(node)s AND ts >= %(since)s AND ts < %(until)s"
    with pool.connection() as conn:
        summary = conn.execute(f"SELECT {STATS_COLUMNS} FROM telemetry WHERE {where}", params).fetchone()
        buckets = conn.execute(
            f"""SELECT date_bin(make_interval(secs => %(bucket)s), ts, timestamptz '2000-01-01') AS bucket,
                       {STATS_COLUMNS}
                FROM telemetry WHERE {where} GROUP BY 1 ORDER BY 1""", params).fetchall()
    return {"node_id": node_id, "since": since, "until": until, "bucket_s": bucket_s,
            "summary": summary, "buckets": buckets}


@router.get("/telemetry.csv", tags=["télémétrie"], dependencies=operator,
            response_class=StreamingResponse, responses={200: {"content": {"text/csv": {}}}})
def telemetry_csv(node_id: str = "SENTINEL-X-CORE", since: datetime | None = None, until: datetime | None = None):
    """Export CSV brut de la période (31 jours max), diffusé en flux (COPY) : mémoire constante côté Pi."""
    since, until = _range(since, until)
    query = sql.SQL("""COPY (SELECT ts, received_at, device_timestamp, uptime_ms, temperature_celsius,
        humidity_percent, gas_raw_ppm, presence_detected, airlock_open, gas_valve_open, ventilation_active,
        barrier_open, alarm_active, wifi_rssi_dbm, free_heap_bytes
        FROM telemetry WHERE node_id = {} AND ts >= {} AND ts < {} ORDER BY ts) TO STDOUT WITH (FORMAT csv, HEADER)""").format(
        sql.Literal(node_id), sql.Literal(since), sql.Literal(until))

    def stream():
        with pool.connection() as conn, conn.cursor() as cur, cur.copy(query) as copy:
            for chunk in copy:
                yield bytes(chunk)

    filename = f"telemetry_{node_id}_{since:%Y%m%d-%H%M}_{until:%Y%m%d-%H%M}.csv"
    return StreamingResponse(stream(), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="{filename}"'})


# --- Contrôle d'accès RFID ----------------------------------------------------------------------
@router.get("/access/events", response_model=list[AccessEventOut], tags=["accès RFID"], dependencies=operator)
def list_access_events(since: datetime | None = None, limit: Limit = 100):
    with pool.connection() as conn:
        return conn.execute(
            """SELECT id, node_id, ts, received_at, card_uid, card_type, door_id, access_granted, user_name,
                      clearance_level FROM access_events
               WHERE (%(since)s::timestamptz IS NULL OR ts >= %(since)s)
               ORDER BY ts DESC, id DESC LIMIT %(limit)s""", {"since": since, "limit": limit}).fetchall()


@router.get("/badges", response_model=list[BadgeOut], tags=["accès RFID"], dependencies=operator)
def list_badges():
    with pool.connection() as conn:
        return conn.execute("SELECT * FROM badges ORDER BY user_name").fetchall()


@router.put("/badges/{card_uid}", response_model=BadgeOut, tags=["accès RFID"], dependencies=operator)
def upsert_badge(card_uid: CardUidPath, badge: BadgeIn):
    """Crée ou modifie un badge autorisé (active=false pour le révoquer)."""
    with pool.connection() as conn:
        return conn.execute(
            """INSERT INTO badges (card_uid, user_name, clearance_level, auto_unlock_door, active)
               VALUES (%s, %s, %s, %s, %s)
               ON CONFLICT (card_uid) DO UPDATE SET user_name = EXCLUDED.user_name,
                   clearance_level = EXCLUDED.clearance_level, auto_unlock_door = EXCLUDED.auto_unlock_door,
                   active = EXCLUDED.active, updated_at = now()
               RETURNING *""",
            (card_uid.upper(), badge.user_name, badge.clearance_level, badge.auto_unlock_door,
             badge.active)).fetchone()


@router.delete("/badges/{card_uid}", response_model=BadgeOut, tags=["accès RFID"], dependencies=operator)
def revoke_badge(card_uid: CardUidPath):
    """Révocation (le badge est conservé pour l'historique, active=false)."""
    with pool.connection() as conn:
        row = conn.execute("UPDATE badges SET active = false, updated_at = now() WHERE card_uid = %s RETURNING *",
                           (card_uid.upper(),)).fetchone()
    if row is None:
        raise HTTPException(404, "badge inconnu")
    return row


# --- Commandes superviseur --------------------------------------------------------------------------
@router.post("/commands", status_code=202, tags=["commandes"], dependencies=operator)
def send_command(command: Annotated[Command, Body(openapi_examples={
    "sas": {"value": {"action": "OPERATE_MOTOR", "target": "AIRLOCK_MAIN", "command": "OPEN",
                      "duration_ms": 3000}},
    "multi-moteurs": {"value": {"action": "CONTROL_MOTORS", "commands": [
        {"motor_id": 0, "direction": "CW", "angle_deg": 90, "speed_rpm": 12},
        {"motor_id": 1, "direction": "CCW", "angle_deg": 180, "speed_rpm": 8}]}},
    "arrêt d'urgence": {"value": {"action": "EMERGENCY_STOP_ALL"}},
    "alarme": {"value": {"action": "TRIGGER_ALARM", "state": True, "color": "RED", "sound": "SIREN_ALERT"}},
})]):
    """Publie l'ordre tel quel sur sentinel/commands (QoS 1) après validation, et le journalise."""
    payload = command.model_dump(exclude_none=True)
    try:
        command_id = bridge.publish(config.TOPIC_COMMANDS, payload, payload["action"])
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from None
    return {"id": command_id, "topic": config.TOPIC_COMMANDS, "payload": payload}


@router.get("/commands", response_model=list[CommandOut], tags=["commandes"], dependencies=operator)
def list_commands(limit: Limit = 100):
    with pool.connection() as conn:
        return conn.execute("SELECT * FROM commands ORDER BY created_at DESC, id DESC LIMIT %s", (limit,)).fetchall()


# --- Vision IA ------------------------------------------------------------------------------------------
@router.get("/vision/events", response_model=list[VisionEventOut], tags=["vision IA"], dependencies=operator)
def list_vision_events(limit: Limit = 100):
    with pool.connection() as conn:
        return conn.execute("SELECT * FROM vision_events ORDER BY ts DESC, id DESC LIMIT %s", (limit,)).fetchall()
