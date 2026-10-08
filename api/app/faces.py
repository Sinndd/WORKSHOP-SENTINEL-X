"""Visages autorisés : ajout depuis le tableau de bord, consommation par le script de vision (/api/v1/faces).

Fonctionnement : l'API n'a pas le modèle de reconnaissance (dlib tourne sur la machine de vision). Un administrateur
crée une demande d'enrôlement (caméra ou photo) ; le script de vision la récupère, calcule les vecteurs (128 nombres)
et les renvoie. L'API ne garde que ces vecteurs : une photo envoyée est effacée dès la fin du traitement.

  - gestion (liste, ajout, renommage, désactivation, suppression) : administrateur ;
  - lecture des vecteurs et dépôt des résultats : réservés au jeton de service (script de vision), jamais aux sessions.
"""
import base64
import math
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Request, Response
from pydantic import Field, ValidationError

from . import auth
from .auth import Principal
from .db import pool
from .models import Strict

router = APIRouter(prefix="/api/v1/faces", tags=["visages"])

MAX_PHOTO_BYTES = 2 * 1024 * 1024
DURATION_S = {"camera": 90, "photo": 60}
EMBEDDING_SIZE = 128
SQL_EXPIRE = ("UPDATE face_enrollments SET status = 'TIMEOUT', finished_at = now(), photo = NULL, "
              "error = 'délai écoulé' WHERE status = 'PENDING' AND expires_at < now()")

Name = Annotated[str, Field(min_length=1, max_length=64)]
Id = Annotated[int, Path(ge=1)]


class FaceEnrollIn(Strict):
    member_id: Annotated[int | None, Field(ge=1)] = None     # ajouter des échantillons à une personne existante
    name: Name | None = None                                  # ou créer une nouvelle personne
    consent: bool = False
    mode: str = Field(pattern=r"^(camera|photo)$")
    samples: Annotated[int, Field(ge=1, le=10)] = 5


class FaceUpdate(Strict):
    name: Name | None = None
    active: bool | None = None


class EmbeddingsIn(Strict):
    embeddings: Annotated[list[list[float]], Field(min_length=1, max_length=10)]


class FailIn(Strict):
    error: Annotated[str, Field(max_length=200)] = "échec"


def require_vision(request: Request, principal: Principal = Depends(auth.require_operator)) -> Principal:
    """Réservé au jeton de service (script de vision) : les vecteurs faciaux ne sortent pas par une session humaine."""
    if not principal.service:
        auth.log_event("ACCESS_DENIED", "WARNING", username=principal.username, ip=auth.client_ip(request),
                       ua=auth.user_agent(request), details=f"{request.method} {request.url.path} (réservé au script de vision)")
        raise HTTPException(403, "réservé au script de vision")
    return principal


def _name(value: str) -> str:
    cleaned = auth.clean(value).strip()
    if not cleaned:
        raise HTTPException(422, "nom vide")
    return cleaned


def _ctx(request: Request) -> dict:
    return {"ip": auth.client_ip(request), "ua": auth.user_agent(request)}


ENROLLMENT_COLUMNS = ("id, member_id, mode, samples_target, samples_done, status, error, created_at, expires_at, "
                      "finished_at, (SELECT name FROM face_members WHERE id = member_id) AS name")


# --- Gestion (administrateur) -----------------------------------------------------------------------
@router.get("")
def list_faces(_: Principal = Depends(auth.require_operator)):
    with pool.connection() as conn:
        return conn.execute(
            """SELECT m.id, m.name, m.active, m.created_by, m.created_at,
                      (SELECT count(*) FROM face_embeddings e WHERE e.member_id = m.id) AS samples
               FROM face_members m ORDER BY lower(m.name)""").fetchall()


def _create_enrollment(request: Request, admin: Principal, body: FaceEnrollIn, photo: bytes | None) -> dict:
    with pool.connection() as conn, conn.transaction():
        conn.execute(SQL_EXPIRE)
        if conn.execute("SELECT 1 FROM face_enrollments WHERE status = 'PENDING'").fetchone():
            raise HTTPException(409, "un enrôlement de visage est déjà en cours : l'annuler ou attendre sa fin")
        if body.member_id is not None:
            member = conn.execute("SELECT id, name FROM face_members WHERE id = %s", (body.member_id,)).fetchone()
            if member is None:
                raise HTTPException(404, "personne inconnue")
        else:
            if not body.name:
                raise HTTPException(422, "nom requis")
            if not body.consent:
                raise HTTPException(422, "le consentement de la personne est obligatoire")
            name = _name(body.name)
            if conn.execute("SELECT 1 FROM face_members WHERE lower(name) = lower(%s)", (name,)).fetchone():
                raise HTTPException(409, "cette personne existe déjà : utilisez « Ajouter des échantillons »")
            member = conn.execute(
                "INSERT INTO face_members (name, consent, created_by) VALUES (%s, true, %s) RETURNING id, name",
                (name, admin.username)).fetchone()
        samples = 1 if body.mode == "photo" else body.samples
        row = conn.execute(
            f"""INSERT INTO face_enrollments (member_id, mode, samples_target, photo, requested_by, expires_at)
                VALUES (%s, %s, %s, %s, %s, now() + make_interval(secs => %s)) RETURNING {ENROLLMENT_COLUMNS}""",
            (member["id"], body.mode, samples, photo, admin.username, DURATION_S[body.mode])).fetchone()
    auth.log_event("FACE_ENROLL_REQUESTED", "INFO", username=member["name"], actor=admin.username, **_ctx(request),
                   details=f"mode {body.mode}")
    return row


@router.post("/enrollments", status_code=202)
def start_enrollment(body: FaceEnrollIn, request: Request, admin: Principal = Depends(auth.require_admin)):
    """Enrôlement par la caméra : la personne se place devant, le script de vision capte `samples` images nettes."""
    if body.mode != "camera":
        raise HTTPException(422, "mode photo : utiliser POST /faces/enrollments/photo")
    return _create_enrollment(request, admin, body, None)


@router.post("/enrollments/photo", status_code=202)
async def start_photo_enrollment(request: Request, name: str | None = None, member_id: int | None = None,
                                 consent: bool = False, admin: Principal = Depends(auth.require_admin)):
    """Enrôlement par photo : corps = image JPEG ou PNG (2 Mio max, un seul visage visible). La photo n'est pas conservée."""
    photo = await request.body()
    if not photo or len(photo) > MAX_PHOTO_BYTES or not (photo.startswith(b"\xff\xd8\xff") or photo.startswith(b"\x89PNG\r\n\x1a\n")):
        raise HTTPException(415, "image JPEG ou PNG de 2 Mio maximum attendue")
    try:
        body = FaceEnrollIn.model_validate({"name": name, "member_id": member_id, "consent": consent, "mode": "photo"})
    except ValidationError as exc:
        raise HTTPException(422, "; ".join(e["msg"] for e in exc.errors())) from None
    return _create_enrollment(request, admin, body, photo)


@router.get("/enrollments/{enroll_id}")
def get_enrollment(enroll_id: Id, _: Principal = Depends(auth.require_operator)):
    with pool.connection() as conn:
        conn.execute(SQL_EXPIRE)
        row = conn.execute(f"SELECT {ENROLLMENT_COLUMNS} FROM face_enrollments WHERE id = %s", (enroll_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "enrôlement inconnu")
    return row


@router.delete("/enrollments/{enroll_id}")
def cancel_enrollment(enroll_id: Id, _: Principal = Depends(auth.require_admin)):
    with pool.connection() as conn, conn.transaction():
        conn.execute("UPDATE face_enrollments SET status = 'CANCELLED', finished_at = now(), photo = NULL "
                     "WHERE id = %s AND status = 'PENDING'", (enroll_id,))
        row = conn.execute(f"SELECT {ENROLLMENT_COLUMNS} FROM face_enrollments WHERE id = %s", (enroll_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "enrôlement inconnu")
        _drop_empty_member(conn, row)
    return row


def _drop_empty_member(conn, enrollment: dict) -> None:
    """Une personne créée par un enrôlement qui n'a donné aucun échantillon ne doit pas rester en base."""
    if enrollment["status"] in ("FAILED", "TIMEOUT", "CANCELLED"):
        conn.execute("""DELETE FROM face_members m WHERE m.id = %s
                        AND NOT EXISTS (SELECT 1 FROM face_embeddings e WHERE e.member_id = m.id)""",
                     (enrollment["member_id"],))


@router.patch("/{member_id}")
def update_face(member_id: Id, body: FaceUpdate, request: Request, admin: Principal = Depends(auth.require_admin)):
    with pool.connection() as conn:
        try:
            row = conn.execute(
                """UPDATE face_members SET name = COALESCE(%s, name), active = COALESCE(%s, active) WHERE id = %s
                   RETURNING id, name, active, created_by, created_at""",
                (_name(body.name) if body.name else None, body.active, member_id)).fetchone()
        except Exception as exc:                         # nom déjà pris (index unique)
            if getattr(exc, "sqlstate", "") == "23505":
                raise HTTPException(409, "ce nom est déjà utilisé") from None
            raise
    if row is None:
        raise HTTPException(404, "personne inconnue")
    auth.log_event("FACE_UPDATED", "WARNING" if body.active is False else "INFO", username=row["name"],
                   actor=admin.username, **_ctx(request),
                   details=", ".join(f"{k}={v}" for k, v in body.model_dump(exclude_none=True).items()))
    return row


@router.delete("/{member_id}", status_code=204)
def delete_face(member_id: Id, request: Request, admin: Principal = Depends(auth.require_admin)):
    """Effacement réel de la personne et de tous ses vecteurs (droit à l'effacement)."""
    with pool.connection() as conn:
        row = conn.execute("DELETE FROM face_members WHERE id = %s RETURNING name", (member_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "personne inconnue")
    auth.log_event("FACE_DELETED", "WARNING", username=row["name"], actor=admin.username, **_ctx(request))
    return Response(status_code=204)


# --- Script de vision (jeton de service) -------------------------------------------------------------
@router.get("/version")
def faces_version(_: Principal = Depends(require_vision)):
    """Empreinte de la base de visages actifs : le script ne retélécharge les vecteurs que si elle change."""
    with pool.connection() as conn:
        row = conn.execute(
            """SELECT md5(coalesce(string_agg(e.id::text, ',' ORDER BY e.id), '')) AS version
               FROM face_embeddings e JOIN face_members m ON m.id = e.member_id WHERE m.active""").fetchone()
    return row


@router.get("/embeddings")
def faces_embeddings(_: Principal = Depends(require_vision)):
    with pool.connection() as conn:
        rows = conn.execute(
            """SELECT m.name, e.embedding FROM face_embeddings e JOIN face_members m ON m.id = e.member_id
               WHERE m.active ORDER BY m.id, e.id""").fetchall()
    members: dict[str, list] = {}
    for r in rows:
        members.setdefault(r["name"], []).append(r["embedding"])
    return {"members": members}


@router.get("/enrollments")
def pending_enrollments(_: Principal = Depends(require_vision)):
    """Travail à faire pour le script de vision (au plus un). La photo éventuelle est jointe en base64."""
    with pool.connection() as conn:
        conn.execute(SQL_EXPIRE)
        row = conn.execute(
            f"SELECT {ENROLLMENT_COLUMNS}, photo FROM face_enrollments WHERE status = 'PENDING' "
            "ORDER BY id LIMIT 1").fetchone()
    if row is None:
        return []
    photo = row.pop("photo")
    return [{**row, "photo_b64": base64.b64encode(photo).decode() if photo else None}]


def _valid_embedding(vec: list[float]) -> bool:
    return len(vec) == EMBEDDING_SIZE and all(math.isfinite(v) and abs(v) < 5 for v in vec)


@router.post("/enrollments/{enroll_id}/embeddings")
def submit_embeddings(enroll_id: Id, body: EmbeddingsIn, request: Request, _: Principal = Depends(require_vision)):
    if not all(_valid_embedding(v) for v in body.embeddings):
        raise HTTPException(422, f"vecteur invalide ({EMBEDDING_SIZE} nombres attendus)")
    with pool.connection() as conn, conn.transaction():
        conn.execute(SQL_EXPIRE)
        enr = conn.execute("SELECT * FROM face_enrollments WHERE id = %s FOR UPDATE", (enroll_id,)).fetchone()
        if enr is None or enr["status"] != "PENDING":
            raise HTTPException(409, "enrôlement terminé ou inconnu")
        accepted = body.embeddings[:max(0, enr["samples_target"] - enr["samples_done"])]
        for vec in accepted:
            conn.execute("INSERT INTO face_embeddings (member_id, embedding, source) VALUES (%s, %s, %s)",
                         (enr["member_id"], vec, enr["mode"]))
        done = enr["samples_done"] + len(accepted)
        finished = done >= enr["samples_target"]
        conn.execute(
            """UPDATE face_enrollments SET samples_done = %s, error = NULL,
                      status = CASE WHEN %s THEN 'SUCCESS' ELSE status END,
                      finished_at = CASE WHEN %s THEN now() ELSE finished_at END,
                      photo = CASE WHEN %s THEN NULL ELSE photo END WHERE id = %s""",
            (done, finished, finished, finished, enroll_id))
        row = conn.execute(f"SELECT {ENROLLMENT_COLUMNS} FROM face_enrollments WHERE id = %s", (enroll_id,)).fetchone()
    if finished:
        auth.log_event("FACE_ENROLLED", "INFO", username=row["name"], actor="script de vision", **_ctx(request),
                       details=f"{done} échantillon(s), mode {enr['mode']}")
    return row


@router.post("/enrollments/{enroll_id}/fail")
def fail_enrollment(enroll_id: Id, body: FailIn, _: Principal = Depends(require_vision)):
    """Échec définitif (photo sans visage, plusieurs visages…) : message affiché dans le tableau de bord."""
    with pool.connection() as conn, conn.transaction():
        conn.execute("UPDATE face_enrollments SET status = 'FAILED', error = %s, finished_at = now(), photo = NULL "
                     "WHERE id = %s AND status = 'PENDING'", (auth.clean(body.error), enroll_id))
        row = conn.execute(f"SELECT {ENROLLMENT_COLUMNS} FROM face_enrollments WHERE id = %s", (enroll_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "enrôlement inconnu")
        _drop_empty_member(conn, row)
    return row


@router.post("/enrollments/{enroll_id}/progress")
def report_progress(enroll_id: Id, body: FailIn, _: Principal = Depends(require_vision)):
    """Indication non définitive (« aucun visage devant la caméra »…) affichée pendant l'attente."""
    with pool.connection() as conn:
        conn.execute("UPDATE face_enrollments SET error = %s WHERE id = %s AND status = 'PENDING'",
                     (auth.clean(body.error), enroll_id))
    return {"ok": True}
