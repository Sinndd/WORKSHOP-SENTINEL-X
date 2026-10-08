"""Endpoints REST /api/v1 (contrat : docs/CONTRAT-MQTT.md, détail : docs/API.md, interactif : /docs)."""
import asyncio
import math
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query, Request, Response
from fastapi.responses import Response as RawResponse, StreamingResponse
from psycopg import sql
from pydantic import ValidationError
from psycopg.types.json import Jsonb

from . import config
from .db import SQL_ENSURE_DEVICE, pool
from .models import (CARD_UID_RE, AccessEventOut, AirlockAction, AlarmAction, MoveAction, OperateMotor, AlertIn, AlertOut, BadgeIn, BadgeOut,
                     Command, CommandOut, DeviceOut, EnrollIn, EnrollmentOut, Severity, TelemetryAggregate,
                     TelemetryOut, VisionEventOut, resolve_ts)
from .mqtt_bridge import bridge
from .auth import client_ip, rate_limited, require_device_or_operator, require_operator, require_viewer

# Tampon mémoire RAM pour le dernier snapshot webcam (aucun impact I/O sur carte SD)
_latest_snapshot: bytes | None = None
_latest_snapshot_ts: datetime | None = None

# Relais vidéo : chaque image reçue est diffusée en direct aux flux MJPEG ouverts (GET /vision/stream).
# Une file d'une ou deux images par spectateur : un client lent perd des images au lieu de retarder les autres.
_viewers: set[asyncio.Queue] = set()
_last_frame_seq = 0      # numéro de séquence de la dernière image diffusée (envois parallèles : une image en retard est ignorée)
MAX_VIEWERS = 8


def _publish_frame(jpeg: bytes) -> None:
    for q in list(_viewers):
        if q.full():
            try:
                q.get_nowait()
            except asyncio.QueueEmpty:
                pass
        q.put_nowait(jpeg)


def _mjpeg_part(jpeg: bytes) -> bytes:
    return b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n" % len(jpeg) + jpeg + b"\r\n"

router = APIRouter(prefix="/api/v1")
operator = [Depends(require_operator)]
viewer = [Depends(require_viewer)]   # lecture seule
Limit = Annotated[int, Query(ge=1, le=1000)]
CardUidPath = Annotated[str, Path(pattern=CARD_UID_RE.replace("[0-9A-F]", "[0-9A-Fa-f]"),
                                  examples=["A3:5F:B2:1C"])]

NodeId = Annotated[str, Query(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$")]   # même règle que la base
MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
ALERTS_PER_MINUTE = 60            # par adresse : une alerte en boucle ne doit pas remplir la carte SD

ALERT_COLUMNS = ("id, node_id, ts, received_at, event_type, severity, source_sensor, value, details, channel, "
                 "acknowledged, acknowledged_at")


# --- Alertes --------------------------------------------------------------------------------
@router.post("/alerts", status_code=201, response_model=AlertOut, tags=["alertes"],
             dependencies=[Depends(require_device_or_operator)])
def create_alert(alert: AlertIn, request: Request):
    """Alerte critique émise par l'ESP32 (jeton d'appareil) ou saisie par un opérateur."""
    if rate_limited(f"alerts:{client_ip(request)}", ALERTS_PER_MINUTE, 60):
        raise HTTPException(429, "trop d'alertes : réessayez dans une minute", headers={"Retry-After": "60"})
    with pool.connection() as conn, conn.transaction():
        conn.execute(SQL_ENSURE_DEVICE, (alert.node_id,))
        return conn.execute(
            f"""INSERT INTO alerts (node_id, ts, device_timestamp, event_type, severity, source_sensor, value,
                                    details, channel, payload)
                VALUES (%s, to_timestamp(%s), %s, %s, %s, %s, %s, %s, 'http', %s) RETURNING {ALERT_COLUMNS}""",
            (alert.node_id, resolve_ts(alert.timestamp), alert.timestamp, alert.event_type, alert.severity,
             alert.source_sensor, alert.value, alert.details, Jsonb(alert.model_dump()))).fetchone()


@router.get("/alerts", response_model=list[AlertOut], tags=["alertes"], dependencies=viewer)
def list_alerts(node_id: NodeId | None = None, severity: Severity | None = None,
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
@router.get("/devices", response_model=list[DeviceOut], tags=["télémétrie"], dependencies=viewer)
def list_devices():
    with pool.connection() as conn:
        return conn.execute("SELECT * FROM devices ORDER BY node_id").fetchall()


@router.get("/telemetry/latest", response_model=TelemetryOut, tags=["télémétrie"], dependencies=viewer)
def latest_telemetry(node_id: NodeId = "SENTINEL-X-CORE"):
    with pool.connection() as conn:
        row = conn.execute("SELECT * FROM telemetry WHERE node_id = %s ORDER BY ts DESC, id DESC LIMIT 1",
                           (node_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "aucune télémétrie pour ce nœud")
    return row


@router.get("/telemetry", response_model=list[TelemetryOut], tags=["télémétrie"], dependencies=viewer)
def telemetry_history(node_id: NodeId = "SENTINEL-X-CORE", since: datetime | None = None,
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


@router.get("/telemetry/aggregate", response_model=TelemetryAggregate, tags=["télémétrie"], dependencies=viewer)
def telemetry_aggregate(node_id: NodeId = "SENTINEL-X-CORE", since: datetime | None = None,
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


@router.get("/telemetry.csv", tags=["télémétrie"], dependencies=viewer,
            response_class=StreamingResponse, responses={200: {"content": {"text/csv": {}}}})
def telemetry_csv(node_id: NodeId = "SENTINEL-X-CORE", since: datetime | None = None, until: datetime | None = None):
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
@router.get("/access/events", response_model=list[AccessEventOut], tags=["accès RFID"], dependencies=viewer)
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


# --- Enrôlement de badges (mode écriture de l'ESP32 piloté depuis le tableau de bord) ----------------
SQL_EXPIRE_ENROLLMENTS = "UPDATE badge_enrollments SET status = 'TIMEOUT', finished_at = now() WHERE status = 'PENDING' AND expires_at < now()"


@router.post("/enrollments", status_code=202, response_model=EnrollmentOut, tags=["accès RFID"], dependencies=operator)
def start_enrollment(req: EnrollIn):
    """Demande l'enrôlement d'un badge : l'ESP32 passe en mode écriture pendant `duration_s` secondes ; le premier badge
    présenté est écrit puis rattaché à `user_name` (badge actif, voir GET /enrollments/{id}). Un seul enrôlement à la fois."""
    with pool.connection() as conn, conn.transaction():
        conn.execute(SQL_EXPIRE_ENROLLMENTS)
        if conn.execute("SELECT 1 FROM badge_enrollments WHERE status = 'PENDING'").fetchone():
            raise HTTPException(409, "un enrôlement est déjà en cours : l'annuler ou attendre sa fin")
        row = conn.execute(
            """INSERT INTO badge_enrollments (user_name, clearance_level, auto_unlock_door, expires_at)
               VALUES (%s, %s, %s, now() + make_interval(secs => %s)) RETURNING *""",
            (req.user_name.strip(), req.clearance_level, req.auto_unlock_door, req.duration_s)).fetchone()
    try:
        bridge.publish(config.TOPIC_COMMANDS, {"action": "ENROLL_BADGE", "enroll_id": row["id"], "duration_s": req.duration_s},
                       "ENROLL_BADGE")
    except RuntimeError as exc:
        with pool.connection() as conn:
            conn.execute("UPDATE badge_enrollments SET status = 'FAILED', error = %s, finished_at = now() WHERE id = %s",
                         (str(exc)[:200], row["id"]))
        raise HTTPException(503, str(exc)) from None
    return row


@router.get("/enrollments/{enroll_id}", response_model=EnrollmentOut, tags=["accès RFID"], dependencies=operator)
def get_enrollment(enroll_id: Annotated[int, Path(ge=1)]):
    with pool.connection() as conn:
        conn.execute(SQL_EXPIRE_ENROLLMENTS)
        row = conn.execute("SELECT * FROM badge_enrollments WHERE id = %s", (enroll_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "enrôlement inconnu")
    return row


@router.delete("/enrollments/{enroll_id}", response_model=EnrollmentOut, tags=["accès RFID"], dependencies=operator)
def cancel_enrollment(enroll_id: Annotated[int, Path(ge=1)]):
    """Annule un enrôlement en cours (l'ESP32 quitte le mode écriture)."""
    with pool.connection() as conn:
        row = conn.execute("""UPDATE badge_enrollments SET status = 'CANCELLED', finished_at = now()
                              WHERE id = %s AND status = 'PENDING' RETURNING *""", (enroll_id,)).fetchone()
        if row is None:
            existing = conn.execute("SELECT * FROM badge_enrollments WHERE id = %s", (enroll_id,)).fetchone()
            if existing is None:
                raise HTTPException(404, "enrôlement inconnu")
            return existing   # déjà terminé : rien à annuler
    try:
        bridge.publish(config.TOPIC_COMMANDS, {"action": "ENROLL_CANCEL", "enroll_id": enroll_id}, "ENROLL_CANCEL")
    except RuntimeError:
        pass   # l'ESP32 quittera de lui-même à l'expiration
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


@router.get("/commands", response_model=list[CommandOut], tags=["commandes"], dependencies=viewer)
def list_commands(limit: Limit = 100):
    with pool.connection() as conn:
        return conn.execute("SELECT * FROM commands ORDER BY created_at DESC, id DESC LIMIT %s", (limit,)).fetchall()


# --- Authentification Opérateur --------------------------------------------------------
# --- Contrôle Réactif des Actionneurs (Raccourcis superviseur) ------------------------
@router.post("/actuators/airlock", status_code=202, tags=["actionneurs"], dependencies=operator)
def control_airlock(action: AirlockAction):
    """Commande rapide d'ouverture ou de fermeture du sas principal."""
    cmd = {
        "action": "OPERATE_MOTOR",
        "target": "AIRLOCK_MAIN",
        "command": "OPEN" if action.state else "CLOSE",
        "duration_ms": action.duration_ms,
    }
    try:
        cmd_id = bridge.publish(config.TOPIC_COMMANDS, cmd, "OPERATE_MOTOR")
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from None
    return {"id": cmd_id, "status": "sent", "command": cmd}


@router.post("/actuators/move", status_code=202, tags=["actionneurs"], dependencies=operator)
def move_actuator(action: MoveAction):
    """Pilote un bras (0..180°), la tête (-90..90°) ou la trappe arrière. Exemple : {"target":"ARM_LEFT","command":"SET_ANGLE","angle":120}."""
    try:
        cmd = OperateMotor(action="OPERATE_MOTOR", **action.model_dump(exclude_none=True)).model_dump(exclude_none=True)
    except ValidationError as exc:
        raise HTTPException(422, [{"msg": e["msg"].removeprefix("Value error, ")} for e in exc.errors()]) from None
    try:
        cmd_id = bridge.publish(config.TOPIC_COMMANDS, cmd, "OPERATE_MOTOR")
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from None
    return {"id": cmd_id, "status": "sent", "command": cmd}


@router.post("/actuators/alarm", status_code=202, tags=["actionneurs"], dependencies=operator)
def control_alarm(action: AlarmAction):
    """Déclenchement ou désactivation rapide de l'alarme (Buzzer + LED)."""
    cmd = {
        "action": "TRIGGER_ALARM",
        "state": action.state,
        "color": action.color,
        "sound": action.sound,
    }
    try:
        cmd_id = bridge.publish(config.TOPIC_COMMANDS, cmd, "TRIGGER_ALARM")
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from None
    return {"id": cmd_id, "status": "sent", "command": cmd}


@router.post("/actuators/emergency_stop", status_code=202, tags=["actionneurs"], dependencies=operator)
def emergency_stop():
    """Arrêt d'urgence immédiat de tous les moteurs."""
    cmd = {"action": "EMERGENCY_STOP_ALL"}
    try:
        cmd_id = bridge.publish(config.TOPIC_COMMANDS, cmd, "EMERGENCY_STOP_ALL")
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from None
    return {"id": cmd_id, "status": "sent", "command": cmd}


# --- Vision IA & Flux Webcam ----------------------------------------------------------
@router.post("/vision/snapshot", status_code=200, tags=["vision IA"], dependencies=operator)
async def upload_snapshot(request: Request):
    """Reçoit la dernière image JPEG traitée par le script IA webcam et la garde en mémoire."""
    global _latest_snapshot, _latest_snapshot_ts, _last_frame_seq
    body = await request.body()          # taille déjà plafonnée par le middleware (413)
    if len(body) > MAX_SNAPSHOT_BYTES or not body.startswith(b"\xff\xd8\xff"):
        raise HTTPException(415, "image JPEG de 2 Mio maximum attendue")
    seq = request.headers.get("x-frame-seq", "")
    if seq.isdigit():                    # envois en parallèle (30 images/s) : l'ordre d'arrivée n'est pas garanti
        if _latest_snapshot_ts is None or (datetime.now(timezone.utc) - _latest_snapshot_ts).total_seconds() > 5:
            _last_frame_seq = 0          # plus rien depuis 5 s : nouvelle session d'envoi (pont redémarré), on repart de zéro
        if int(seq) <= _last_frame_seq:
            return {"status": "stale", "bytes": len(body)}
        _last_frame_seq = int(seq)
    _latest_snapshot = body
    _latest_snapshot_ts = datetime.now(timezone.utc)
    _publish_frame(body)
    return {"status": "ok", "bytes": len(_latest_snapshot), "ts": _latest_snapshot_ts.isoformat()}


@router.get("/vision/stream", tags=["vision IA"], dependencies=viewer)
async def stream_video(request: Request):
    """Flux vidéo en direct (MJPEG, multipart/x-mixed-replace) : une image JPEG par envoi de POST /vision/snapshot.
    Authentification par l'en-tête Bearer : à lire avec fetch (une balise <img> ne peut pas l'envoyer)."""
    if len(_viewers) >= MAX_VIEWERS:
        raise HTTPException(503, "trop de spectateurs vidéo simultanés")
    q: asyncio.Queue = asyncio.Queue(maxsize=2)
    _viewers.add(q)

    async def frames():
        try:
            yield b"\r\n"                                      # envoie les en-têtes tout de suite, même sans caméra
            if _latest_snapshot is not None:
                yield _mjpeg_part(_latest_snapshot)          # image immédiate à la connexion
            while not await request.is_disconnected():
                try:
                    jpeg = await asyncio.wait_for(q.get(), timeout=2.0)
                except asyncio.TimeoutError:
                    yield b"\r\n"                              # battement : garde la connexion ouverte à travers le proxy
                    continue
                yield _mjpeg_part(jpeg)
        finally:
            _viewers.discard(q)

    return StreamingResponse(frames(), media_type="multipart/x-mixed-replace; boundary=frame",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


@router.get("/vision/snapshot", tags=["vision IA"], dependencies=viewer)
def get_latest_snapshot():
    """Renvoie la dernière capture webcam en direct (JPEG) pour l'incrustation sur le Dashboard."""
    global _latest_snapshot
    if _latest_snapshot is None:
        # Retourne une image SVG de substitution si aucune caméra n'a encore transmis
        svg = """<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">
            <rect width="100%" height="100%" fill="#111317"/>
            <circle cx="320" cy="200" r="40" fill="none" stroke="#2a78d6" stroke-width="4"/>
            <circle cx="320" cy="200" r="15" fill="#2a78d6"/>
            <text x="320" y="280" font-family="sans-serif" font-size="16" fill="#898781" text-anchor="middle">EN ATTENTE DU FLUX WEBCAM IA (YOLO)</text>
            <text x="320" y="310" font-family="sans-serif" font-size="12" fill="#52514e" text-anchor="middle">CENTRE DE COMMANDEMENT SENTINEL-X</text>
        </svg>"""
        return RawResponse(content=svg, media_type="image/svg+xml")
    # Horodatage de la capture : le tableau de bord n'affiche « Live » que si l'image est récente.
    return RawResponse(content=_latest_snapshot, media_type="image/jpeg",
                       headers={"X-Snapshot-Ts": _latest_snapshot_ts.isoformat() if _latest_snapshot_ts else "",
                                "Cache-Control": "no-store"})


@router.get("/vision/events", response_model=list[VisionEventOut], tags=["vision IA"], dependencies=viewer)
def list_vision_events(limit: Limit = 100):
    with pool.connection() as conn:
        return conn.execute("SELECT * FROM vision_events ORDER BY ts DESC, id DESC LIMIT %s", (limit,)).fetchall()
