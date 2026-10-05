"""Endpoints de gestion des comptes, des sessions et de la sécurité (/api/v1/auth, /users, /security)."""
import secrets
import string
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field

from . import auth, config
from .auth import Principal
from .db import pool
from .models import Strict

router = APIRouter(prefix="/api/v1")


# --- Modèles ------------------------------------------------------------------------------------
class LoginRequest(Strict):
    username: Annotated[str, Field(min_length=1, max_length=64)]
    password: Annotated[str, Field(min_length=1, max_length=256)]
    otp: Annotated[str | None, Field(max_length=12)] = None


class LoginResponse(BaseModel):
    token: str
    expires_at: str
    username: str
    full_name: str
    role: str
    must_change_password: bool
    totp_enabled: bool


class PasswordChange(Strict):
    current_password: Annotated[str, Field(min_length=1, max_length=256)]
    new_password: Annotated[str, Field(min_length=1, max_length=256)]


class UserCreate(Strict):
    username: Annotated[str, Field(min_length=3, max_length=32)]
    full_name: Annotated[str, Field(min_length=1, max_length=128)]
    role: Literal["viewer", "operator", "admin"]
    password: Annotated[str | None, Field(max_length=256)] = None   # absent : mot de passe temporaire généré


class UserUpdate(Strict):
    full_name: Annotated[str | None, Field(min_length=1, max_length=128)] = None
    role: Literal["viewer", "operator", "admin"] | None = None
    active: bool | None = None


class PasswordConfirm(Strict):
    password: Annotated[str, Field(min_length=1, max_length=256)]


class TotpEnable(Strict):
    code: Annotated[str, Field(max_length=12)]


class TotpDisable(Strict):
    password: Annotated[str, Field(min_length=1, max_length=256)]
    code: Annotated[str, Field(max_length=12)]


USER_COLUMNS = ("id, username, full_name, role, active, must_change_password, totp_enabled, locked_until, "
                "failed_attempts, last_login_at, last_login_ip, created_at, created_by, password_changed_at")


def _ctx(request: Request) -> dict:
    return {"ip": auth.client_ip(request), "ua": auth.user_agent(request)}


def _generate_password() -> str:
    """16 caractères, conforme à la politique (minuscule, majuscule, chiffre, symbole)."""
    pools = [string.ascii_lowercase, string.ascii_uppercase, string.digits, "!#$%*+-=?@"]
    chars = [secrets.choice(p) for p in pools] + [secrets.choice("".join(pools)) for _ in range(12)]
    secrets.SystemRandom().shuffle(chars)
    return "".join(chars)


def _require_human(principal: Principal) -> None:
    if principal.service:
        raise HTTPException(403, "réservé aux comptes utilisateurs (pas au jeton de service)")


def _get_user(conn, user_id: int) -> dict:
    row = conn.execute(f"SELECT {USER_COLUMNS} FROM users WHERE id = %s", (user_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "compte inconnu")
    return row


def _other_active_admins(conn, user_id: int) -> int:
    return conn.execute("SELECT count(*) AS n FROM users WHERE role = 'admin' AND active AND id <> %s",
                        (user_id,)).fetchone()["n"]


# --- Session courante ------------------------------------------------------------------------------
@router.post("/auth/login", response_model=LoginResponse, tags=["authentification"])
def login(creds: LoginRequest, request: Request):
    """Connexion par compte personnel (+ code TOTP si activé). Réponse d'échec uniforme."""
    return auth.login(creds.username, creds.password, creds.otp, **_ctx(request))


@router.post("/auth/logout", status_code=204, tags=["authentification"])
def logout(request: Request, principal: Principal = Depends(auth.require_session)):
    if principal.session_id is not None:
        auth.revoke_sessions("id = %s", (principal.session_id,), principal.username)
        auth.log_event("LOGOUT", "INFO", username=principal.username, **_ctx(request))
    return Response(status_code=204)


@router.get("/auth/me", tags=["authentification"])
def me(principal: Principal = Depends(auth.require_session)):
    if principal.service:
        return {"username": principal.username, "full_name": principal.full_name, "role": principal.role,
                "service": True, "must_change_password": False, "totp_enabled": False}
    with pool.connection() as conn:
        row = conn.execute("SELECT totp_enabled, last_login_at, last_login_ip FROM users WHERE id = %s",
                           (principal.user_id,)).fetchone()
    return {"username": principal.username, "full_name": principal.full_name, "role": principal.role,
            "service": False, "must_change_password": principal.must_change_password, **row}


@router.post("/auth/password", status_code=204, tags=["authentification"])
def change_password(body: PasswordChange, request: Request, principal: Principal = Depends(auth.require_session)):
    _require_human(principal)
    with pool.connection() as conn:
        user = conn.execute("SELECT password_hash FROM users WHERE id = %s", (principal.user_id,)).fetchone()
    if not auth.verify_password(body.current_password, user["password_hash"]):
        auth.log_event("PASSWORD_CHANGE_REFUSED", "WARNING", username=principal.username, **_ctx(request),
                       details="mot de passe actuel incorrect")
        auth.note_failure(auth.client_ip(request), principal.username)
        raise HTTPException(400, "mot de passe actuel incorrect")
    errors = auth.password_policy_errors(body.new_password, principal.username)
    if body.new_password == body.current_password:
        errors.append("doit être différent de l'actuel")
    if errors:
        raise HTTPException(422, "Mot de passe refusé : " + " ; ".join(errors))
    with pool.connection() as conn:
        conn.execute("""UPDATE users SET password_hash = %s, must_change_password = false, password_changed_at = now()
                        WHERE id = %s""", (auth.hash_password(body.new_password), principal.user_id))
    # Toutes les AUTRES sessions du compte sont fermées (un jeton volé devient inutile).
    auth.revoke_sessions("user_id = %s AND id <> %s", (principal.user_id, principal.session_id),
                         f"{principal.username} (changement de mot de passe)")
    auth.log_event("PASSWORD_CHANGED", "INFO", username=principal.username, **_ctx(request))
    return Response(status_code=204)


@router.get("/auth/sessions", tags=["authentification"])
def my_sessions(principal: Principal = Depends(auth.require_session)):
    """Sessions actives du compte courant (la session en cours est marquée « current »)."""
    _require_human(principal)
    with pool.connection() as conn:
        rows = conn.execute(
            """SELECT id, created_at, last_seen, expires_at, ip, user_agent, id = %s AS current FROM sessions
               WHERE user_id = %s AND revoked_at IS NULL AND expires_at > now()
                 AND last_seen > now() - make_interval(mins => %s) ORDER BY last_seen DESC""",
            (principal.session_id, principal.user_id, config.SESSION_IDLE_MIN)).fetchall()
    return rows


@router.delete("/auth/sessions/{session_id}", status_code=204, tags=["authentification"])
def revoke_my_session(session_id: int, request: Request, principal: Principal = Depends(auth.require_session)):
    _require_human(principal)
    if not auth.revoke_sessions("id = %s AND user_id = %s", (session_id, principal.user_id), principal.username):
        raise HTTPException(404, "session inconnue")
    auth.log_event("SESSION_REVOKED", "INFO", username=principal.username, **_ctx(request), details=f"session {session_id}")
    return Response(status_code=204)


# --- Double authentification (TOTP) ------------------------------------------------------------------
@router.post("/auth/2fa/setup", tags=["authentification"])
def totp_setup(body: PasswordConfirm, request: Request, principal: Principal = Depends(auth.require_session)):
    """Génère un secret TOTP (à saisir dans une application d'authentification) ; activé par /2fa/enable."""
    _require_human(principal)
    with pool.connection() as conn:
        user = conn.execute("SELECT password_hash, totp_enabled FROM users WHERE id = %s",
                            (principal.user_id,)).fetchone()
        if user["totp_enabled"]:
            raise HTTPException(409, "double authentification déjà activée")
        if not auth.verify_password(body.password, user["password_hash"]):
            auth.note_failure(auth.client_ip(request), principal.username)
            raise HTTPException(400, "mot de passe incorrect")
        secret = auth.new_totp_secret()
        conn.execute("UPDATE users SET totp_secret = %s WHERE id = %s", (secret, principal.user_id))
    return {"secret": secret, "uri": auth.totp_uri(secret, principal.username)}


@router.post("/auth/2fa/enable", status_code=204, tags=["authentification"])
def totp_enable(body: TotpEnable, request: Request, principal: Principal = Depends(auth.require_session)):
    _require_human(principal)
    with pool.connection() as conn:
        user = conn.execute("SELECT totp_secret, totp_enabled, totp_last_step FROM users WHERE id = %s",
                            (principal.user_id,)).fetchone()
        if user["totp_enabled"] or not user["totp_secret"]:
            raise HTTPException(409, "aucune configuration en attente")
        step = auth.verify_totp(user["totp_secret"], body.code)
        if step is None:
            raise HTTPException(400, "code invalide")
        conn.execute("UPDATE users SET totp_enabled = true, totp_last_step = %s WHERE id = %s",
                     (step, principal.user_id))
    auth.log_event("TOTP_ENABLED", "INFO", username=principal.username, **_ctx(request))
    return Response(status_code=204)


@router.post("/auth/2fa/disable", status_code=204, tags=["authentification"])
def totp_disable(body: TotpDisable, request: Request, principal: Principal = Depends(auth.require_session)):
    _require_human(principal)
    with pool.connection() as conn:
        user = conn.execute("SELECT password_hash, totp_secret, totp_enabled, totp_last_step FROM users WHERE id = %s",
                            (principal.user_id,)).fetchone()
        if not user["totp_enabled"]:
            raise HTTPException(409, "double authentification non activée")
        if not auth.verify_password(body.password, user["password_hash"]) or \
                auth.verify_totp(user["totp_secret"], body.code, user["totp_last_step"]) is None:
            auth.note_failure(auth.client_ip(request), principal.username)
            raise HTTPException(400, "mot de passe ou code incorrect")
        conn.execute("UPDATE users SET totp_enabled = false, totp_secret = NULL, totp_last_step = NULL WHERE id = %s",
                     (principal.user_id,))
    auth.log_event("TOTP_DISABLED", "WARNING", username=principal.username, **_ctx(request))
    return Response(status_code=204)


# --- Administration des comptes ---------------------------------------------------------------------
@router.get("/users", tags=["utilisateurs"])
def list_users(_: Principal = Depends(auth.require_admin)):
    with pool.connection() as conn:
        return conn.execute(
            f"""SELECT {USER_COLUMNS},
                       (SELECT count(*) FROM sessions s WHERE s.user_id = users.id AND s.revoked_at IS NULL
                          AND s.expires_at > now()
                          AND s.last_seen > now() - make_interval(mins => %s)) AS active_sessions
                FROM users ORDER BY lower(full_name), username""", (config.SESSION_IDLE_MIN,)).fetchall()


@router.post("/users", status_code=201, tags=["utilisateurs"])
def create_user(body: UserCreate, request: Request, admin: Principal = Depends(auth.require_admin)):
    """Crée un compte. Plusieurs comptes peuvent appartenir à la même personne (même nom complet).
    Sans mot de passe fourni, un mot de passe temporaire est généré et retourné UNE SEULE fois."""
    username = body.username.strip().lower()
    if not auth.USERNAME_RE.match(username):
        raise HTTPException(422, "identifiant : 3 à 32 caractères (a-z, 0-9, point, tiret, tiret bas)")
    generated = body.password is None
    password = body.password if body.password is not None else _generate_password()
    errors = auth.password_policy_errors(password, username)
    if errors:
        raise HTTPException(422, "Mot de passe refusé : " + " ; ".join(errors))
    with pool.connection() as conn:
        if conn.execute("SELECT 1 FROM users WHERE username = %s", (username,)).fetchone():
            raise HTTPException(409, "identifiant déjà utilisé")
        row = conn.execute(
            f"""INSERT INTO users (username, full_name, role, password_hash, must_change_password, created_by)
                VALUES (%s, %s, %s, %s, true, %s) RETURNING {USER_COLUMNS}""",
            (username, body.full_name.strip(), body.role, auth.hash_password(password), admin.username)).fetchone()
    auth.log_event("USER_CREATED", "INFO", username=username, actor=admin.username, **_ctx(request),
                   details=f"rôle {body.role}, titulaire {body.full_name.strip()}")
    return {**row, "temporary_password": password if generated else None}


@router.patch("/users/{user_id}", tags=["utilisateurs"])
def update_user(user_id: int, body: UserUpdate, request: Request, admin: Principal = Depends(auth.require_admin)):
    with pool.connection() as conn, conn.transaction():
        target = _get_user(conn, user_id)
        demoting = (body.role is not None and body.role != "admin") or body.active is False
        if target["role"] == "admin" and target["active"] and demoting and _other_active_admins(conn, user_id) == 0:
            raise HTTPException(409, "impossible : c'est le dernier administrateur actif")
        if user_id == admin.user_id and (body.active is False or (body.role and body.role != target["role"])):
            raise HTTPException(409, "vous ne pouvez pas modifier votre propre rôle ni désactiver votre compte")
        row = conn.execute(
            f"""UPDATE users SET full_name = COALESCE(%s, full_name), role = COALESCE(%s, role),
                                 active = COALESCE(%s, active) WHERE id = %s RETURNING {USER_COLUMNS}""",
            (body.full_name, body.role, body.active, user_id)).fetchone()
    if (body.role and body.role != target["role"]) or body.active is False:
        # Droits réduits ou compte désactivé : les sessions existantes ne doivent plus rien pouvoir.
        auth.revoke_sessions("user_id = %s", (user_id,), f"{admin.username} (modification du compte)")
    changes = ", ".join(f"{k}={v}" for k, v in body.model_dump(exclude_none=True).items())
    auth.log_event("USER_UPDATED", "WARNING" if body.active is False else "INFO", username=target["username"],
                   actor=admin.username, **_ctx(request), details=changes)
    return row


@router.post("/users/{user_id}/reset-password", tags=["utilisateurs"])
def reset_password(user_id: int, request: Request, admin: Principal = Depends(auth.require_admin)):
    """Génère un mot de passe temporaire (affiché une seule fois), ferme les sessions, impose un changement."""
    password = _generate_password()
    with pool.connection() as conn:
        target = _get_user(conn, user_id)
        conn.execute("""UPDATE users SET password_hash = %s, must_change_password = true, failed_attempts = 0,
                        locked_until = NULL WHERE id = %s""", (auth.hash_password(password), user_id))
    auth.revoke_sessions("user_id = %s", (user_id,), f"{admin.username} (réinitialisation)")
    auth.log_event("PASSWORD_RESET", "WARNING", username=target["username"], actor=admin.username, **_ctx(request))
    return {"temporary_password": password}


@router.post("/users/{user_id}/unlock", tags=["utilisateurs"])
def unlock_user(user_id: int, request: Request, admin: Principal = Depends(auth.require_admin)):
    with pool.connection() as conn:
        target = _get_user(conn, user_id)
        conn.execute("UPDATE users SET failed_attempts = 0, lockouts = 0, locked_until = NULL WHERE id = %s", (user_id,))
    auth.log_event("ACCOUNT_UNLOCKED", "INFO", username=target["username"], actor=admin.username, **_ctx(request))
    return {"ok": True}


@router.post("/users/{user_id}/reset-2fa", tags=["utilisateurs"])
def reset_2fa(user_id: int, request: Request, admin: Principal = Depends(auth.require_admin)):
    with pool.connection() as conn:
        target = _get_user(conn, user_id)
        conn.execute("UPDATE users SET totp_enabled = false, totp_secret = NULL, totp_last_step = NULL WHERE id = %s",
                     (user_id,))
    auth.log_event("TOTP_RESET", "WARNING", username=target["username"], actor=admin.username, **_ctx(request))
    return {"ok": True}


@router.post("/users/{user_id}/revoke-sessions", tags=["utilisateurs"])
def revoke_user_sessions(user_id: int, request: Request, admin: Principal = Depends(auth.require_admin)):
    with pool.connection() as conn:
        target = _get_user(conn, user_id)
    count = auth.revoke_sessions("user_id = %s", (user_id,), admin.username)
    auth.log_event("SESSION_REVOKED", "WARNING", username=target["username"], actor=admin.username, **_ctx(request),
                   details=f"{count} session(s) fermée(s)")
    return {"revoked": count}


# --- Supervision de la sécurité -------------------------------------------------------------------------
@router.get("/security/summary", tags=["sécurité"])
def security_summary(_: Principal = Depends(auth.require_admin)):
    with pool.connection() as conn:
        row = conn.execute(
            """SELECT
                 (SELECT count(*) FROM security_events WHERE ts > now() - interval '24 hours'
                    AND event_type IN ('LOGIN_FAILURE', 'LOGIN_REFUSED_LOCKED', 'LOGIN_REFUSED_DISABLED')) AS failures_24h,
                 (SELECT count(*) FROM security_events WHERE ts > now() - interval '24 hours'
                    AND event_type IN ('ACCOUNT_LOCKED', 'IP_BLOCKED')) AS intrusions_24h,
                 (SELECT count(*) FROM security_events WHERE ts > now() - interval '24 hours'
                    AND event_type = 'LOGIN_SUCCESS') AS logins_24h,
                 (SELECT count(*) FROM users WHERE locked_until > now()) AS locked_accounts,
                 (SELECT count(*) FROM sessions WHERE revoked_at IS NULL AND expires_at > now()
                    AND last_seen > now() - make_interval(mins => %s)) AS active_sessions""",
            (config.SESSION_IDLE_MIN,)).fetchone()
    return {**row, "blocked_ips": len(auth.blocked_ips())}


@router.get("/security/events", tags=["sécurité"])
def security_events(_: Principal = Depends(auth.require_admin),
                    severity: Literal["INFO", "WARNING", "CRITICAL"] | None = None,
                    event_type: Annotated[str | None, Query(max_length=48)] = None,
                    limit: Annotated[int, Query(ge=1, le=1000)] = 200):
    with pool.connection() as conn:
        return conn.execute(
            """SELECT id, ts, event_type, severity, username, actor, ip, user_agent, details FROM security_events
               WHERE (%(sev)s::text IS NULL OR severity = %(sev)s) AND (%(type)s::text IS NULL OR event_type = %(type)s)
               ORDER BY ts DESC, id DESC LIMIT %(limit)s""",
            {"sev": severity, "type": event_type, "limit": limit}).fetchall()


@router.get("/security/sessions", tags=["sécurité"])
def all_sessions(_: Principal = Depends(auth.require_admin)):
    with pool.connection() as conn:
        return conn.execute(
            """SELECT s.id, u.username, u.full_name, s.created_at, s.last_seen, s.expires_at, s.ip, s.user_agent
               FROM sessions s JOIN users u ON u.id = s.user_id
               WHERE s.revoked_at IS NULL AND s.expires_at > now() AND s.last_seen > now() - make_interval(mins => %s)
               ORDER BY s.last_seen DESC""", (config.SESSION_IDLE_MIN,)).fetchall()


@router.delete("/security/sessions/{session_id}", status_code=204, tags=["sécurité"])
def revoke_any_session(session_id: int, request: Request, admin: Principal = Depends(auth.require_admin)):
    if not auth.revoke_sessions("id = %s", (session_id,), admin.username):
        raise HTTPException(404, "session inconnue")
    auth.log_event("SESSION_REVOKED", "WARNING", actor=admin.username, **_ctx(request), details=f"session {session_id}")
    return Response(status_code=204)


@router.get("/security/blocked-ips", tags=["sécurité"])
def list_blocked_ips(_: Principal = Depends(auth.require_admin)):
    return auth.blocked_ips()


@router.delete("/security/blocked-ips/{ip}", status_code=204, tags=["sécurité"])
def release_ip(ip: str, request: Request, admin: Principal = Depends(auth.require_admin)):
    if not auth.unblock_ip(ip):
        raise HTTPException(404, "adresse non bloquée")
    auth.log_event("IP_UNBLOCKED", "INFO", actor=admin.username, **_ctx(request), details=f"IP {ip} débloquée")
    return Response(status_code=204)
