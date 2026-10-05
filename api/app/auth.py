"""Authentification : comptes, sessions, TOTP, verrouillage, blocage d'IP et journal de sécurité.

Principes :
  - mots de passe hachés en scrypt (bibliothèque standard, sel aléatoire par compte) ;
  - jetons de session aléatoires de 256 bits, seul leur SHA-256 est stocké ;
  - réponse d'échec identique (et durée comparable) que le compte existe ou non ;
  - verrouillage de compte progressif + blocage d'IP en mémoire (échecs répétés, credential stuffing) ;
  - toute action sensible est tracée dans security_events ; les blocages graves créent aussi une alerte
    INTRUSION_DETECTED visible dans le journal des alertes du dashboard.
"""
import base64
import hashlib
import hmac
import logging
import os
import re
import secrets
import struct
import threading
import time
from collections import deque
from dataclasses import dataclass

from fastapi import HTTPException, Request, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
import psycopg
from psycopg.types.json import Jsonb

from . import config
from .db import SQL_ENSURE_DEVICE, pool

log = logging.getLogger("api.auth")

ROLES = ("viewer", "operator", "admin")
RANK = {role: i for i, role in enumerate(ROLES, start=1)}
USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{2,31}$")
GENERIC_LOGIN_ERROR = "Identifiants incorrects ou compte temporairement en pause (réessayez dans quelques instants)."
ALERT_NODE = "SENTINEL-X-CORE"


# --- Mots de passe ---------------------------------------------------------------------------
_N, _R, _P = 2 ** 14, 8, 1                    # 16 Mio par hachage : compatible avec les 128 Mo du conteneur
_hash_slots = threading.BoundedSemaphore(2)   # au plus 2 scrypt simultanés (mémoire du Pi)

_COMMON = {
    "password", "motdepasse", "azerty", "qwerty", "sentinel", "sentinelx", "aethercorp", "administrateur",
    "admin", "welcome", "letmein", "changeme", "iloveyou", "123456", "12345678", "123456789", "0123456789",
}


def _scrypt(password: str, salt: bytes, n: int, r: int, p: int) -> bytes:
    with _hash_slots:
        return hashlib.scrypt(password.encode(), salt=salt, n=n, r=r, p=p, dklen=32, maxmem=96 * 1024 * 1024)


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = _scrypt(password, salt, _N, _R, _P)
    return f"scrypt${_N}${_R}${_P}${base64.b64encode(salt).decode()}${base64.b64encode(digest).decode()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, n, r, p, salt, digest = stored.split("$")
        expected = base64.b64decode(digest)
        got = _scrypt(password, base64.b64decode(salt), int(n), int(r), int(p))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(got, expected)


_DUMMY_HASH = hash_password(secrets.token_urlsafe(16))  # compte inconnu : même coût CPU qu'un compte réel


def password_policy_errors(password: str, username: str = "") -> list[str]:
    """Politique : 12 caractères minimum, 3 classes sur 4 (ou 20+ caractères), pas de mot courant ni d'identifiant."""
    errors = []
    if len(password) < 12:
        errors.append("12 caractères minimum")
    if len(password) > 128:
        errors.append("128 caractères maximum")
    classes = sum(bool(re.search(p, password)) for p in (r"[a-z]", r"[A-Z]", r"[0-9]", r"[^A-Za-z0-9]"))
    if classes < 3 and len(password) < 20:
        errors.append("mélanger majuscules, minuscules, chiffres et symboles (3 types au moins)")
    low = password.lower()
    if len(username) >= 3 and username.lower() in low:
        errors.append("ne doit pas contenir l'identifiant")
    if any(c in low for c in _COMMON) and len(password) < 20:
        errors.append("ne doit pas contenir un mot de passe courant")
    if len(set(password)) < 5:
        errors.append("trop de caractères répétés")
    return errors


# --- TOTP (RFC 6238, SHA-1, 6 chiffres, pas de 30 s) -----------------------------------------------
def new_totp_secret() -> str:
    return base64.b32encode(os.urandom(20)).decode()


def totp_uri(secret: str, username: str) -> str:
    return f"otpauth://totp/SENTINEL-X:{username}?secret={secret}&issuer=SENTINEL-X&algorithm=SHA1&digits=6&period=30"


def _totp_code(secret: str, step: int) -> str:
    digest = hmac.new(base64.b32decode(secret), struct.pack(">Q", step), "sha1").digest()
    offset = digest[-1] & 0x0F
    return f"{(struct.unpack('>I', digest[offset:offset + 4])[0] & 0x7FFFFFFF) % 1_000_000:06d}"


def verify_totp(secret: str, code: str, last_step: int | None = None, now: float | None = None) -> int | None:
    """Retourne le pas de temps validé (à mémoriser contre le rejeu) ou None. Tolérance ±1 pas."""
    code = code.strip().replace(" ", "")
    if not re.fullmatch(r"[0-9]{6}", code):
        return None
    current = int((time.time() if now is None else now) // 30)
    for step in (current - 1, current, current + 1):
        if step > (last_step or -1) and hmac.compare_digest(_totp_code(secret, step), code):
            return step
    return None


# --- Adresse IP, blocage, journal ---------------------------------------------------------------
_lock = threading.Lock()
_failures: dict[str, deque] = {}     # ip -> deque[(horodatage, identifiant)]
_blocked: dict[str, float] = {}      # ip -> fin du blocage (monotonic)
_LOOPBACK = {"127.0.0.1", "::1", "localhost"}


def client_ip(request: Request) -> str:
    ip = request.client.host if request.client else "inconnue"
    if ip in config.TRUSTED_PROXIES:
        forwarded = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
        if forwarded:
            ip = forwarded
    return ip[:64]


def user_agent(request: Request) -> str:
    return request.headers.get("user-agent", "")[:256]


_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]")


def clean(value: str | None) -> str | None:
    """Neutralise les caractères de contrôle (retours à la ligne) : pas de fausse ligne dans les journaux."""
    return None if value is None else _CONTROL.sub(" ", value)


# --- Limiteur de débit (fenêtre glissante, en mémoire) ----------------------------------------------
_hits: dict[str, deque] = {}


def rate_limited(key: str, limit: int, window_s: int) -> bool:
    """True si `key` a déjà fait `limit` appels dans les `window_s` dernières secondes (l'appel courant est compté)."""
    now = time.monotonic()
    with _lock:
        hits = _hits.setdefault(key, deque())
        while hits and now - hits[0] > window_s:
            hits.popleft()
        if len(_hits) > 5000:
            for stale in [k for k, v in _hits.items() if not v or now - v[-1] > window_s]:
                del _hits[stale]
        if len(hits) >= limit:
            return True
        hits.append(now)
        return False


def log_event(event_type: str, severity: str, *, username: str | None = None, actor: str | None = None,
              ip: str | None = None, ua: str | None = None, details: str | None = None) -> None:
    """Journal de sécurité. Ne lève jamais : un incident de base ne doit pas casser la requête en cours."""
    username, actor, ip, ua, details = (clean(v) for v in (username, actor, ip, ua, details))
    level = {"INFO": logging.INFO, "WARNING": logging.WARNING, "CRITICAL": logging.CRITICAL}[severity]
    log.log(level, "%s user=%s actor=%s ip=%s %s", event_type, username, actor, ip, details or "")
    try:
        with pool.connection(timeout=2) as conn:
            conn.execute(
                "INSERT INTO security_events (event_type, severity, username, actor, ip, user_agent, details) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                (event_type, severity, username, actor, ip, (ua or None), (details or "")[:512] or None))
    except Exception:
        log.exception("écriture du journal de sécurité impossible")


def raise_intrusion_alert(severity: str, details: str, payload: dict) -> None:
    """Fait apparaître l'incident dans le journal des alertes (INTRUSION_DETECTED, canal « server »)."""
    try:
        with pool.connection(timeout=2) as conn, conn.transaction():
            conn.execute(SQL_ENSURE_DEVICE, (ALERT_NODE,))
            conn.execute(
                """INSERT INTO alerts (node_id, ts, event_type, severity, source_sensor, details, channel, payload)
                   VALUES (%s, now(), 'INTRUSION_DETECTED', %s, 'AUTH', %s, 'server', %s)""",
                (ALERT_NODE, severity, details[:512], Jsonb(payload)))
    except Exception:
        log.exception("création de l'alerte d'intrusion impossible")


def ip_block_remaining(ip: str) -> int:
    """Secondes restantes de blocage pour cette IP (0 = non bloquée)."""
    with _lock:
        until = _blocked.get(ip)
        if until is None:
            return 0
        remaining = until - time.monotonic()
        if remaining <= 0:
            del _blocked[ip]
            return 0
        return int(remaining) + 1


def blocked_ips() -> list[dict]:
    now = time.monotonic()
    with _lock:
        return [{"ip": ip, "remaining_s": int(until - now) + 1} for ip, until in _blocked.items() if until > now]


def unblock_ip(ip: str) -> bool:
    with _lock:
        _failures.pop(ip, None)
        return _blocked.pop(ip, None) is not None


def note_failure(ip: str, username: str | None, ua: str | None = None) -> None:
    """Compte un échec d'authentification pour cette IP ; bloque l'IP si un seuil est franchi."""
    if not config.IP_BLOCKING or ip in _LOOPBACK:
        return
    now = time.monotonic()
    reason = None
    with _lock:
        if ip in _blocked and _blocked[ip] > now:
            return
        window = _failures.setdefault(ip, deque(maxlen=200))
        window.append((now, username))
        while window and now - window[0][0] > config.IP_WINDOW_S:
            window.popleft()
        names = {u for _, u in window if u}
        if len(window) >= config.IP_FAIL_THRESHOLD:
            reason = f"{len(window)} échecs d'authentification en {config.IP_WINDOW_S // 60} min (force brute)"
        elif len(names) >= config.IP_USERNAME_THRESHOLD:
            reason = f"{len(names)} identifiants différents essayés en {config.IP_WINDOW_S // 60} min (credential stuffing)"
        if reason:
            _blocked[ip] = now + config.IP_BLOCK_MIN * 60
            del _failures[ip]
        elif len(_failures) > 5000:                      # borne mémoire : purge des IP inactives
            for stale in [k for k, v in _failures.items() if not v or now - v[-1][0] > config.IP_WINDOW_S]:
                del _failures[stale]
    if reason:
        details = f"IP {ip} bloquée {config.IP_BLOCK_MIN} min : {reason}"
        log_event("IP_BLOCKED", "CRITICAL", ip=ip, ua=ua, details=details)
        raise_intrusion_alert("CRITICAL", f"Tentative d'intrusion : {details}", {"type": "IP_BLOCKED", "ip": ip})


# --- Sessions ----------------------------------------------------------------------------------
def _sha256(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_session(user_id: int, ip: str, ua: str) -> tuple[str, str]:
    """Crée une session et retourne (jeton, expiration ISO). Au-delà du plafond, la plus ancienne est révoquée."""
    token = "sx_" + secrets.token_urlsafe(32)
    with pool.connection() as conn, conn.transaction():
        conn.execute(
            """UPDATE sessions SET revoked_at = now(), revoked_by = 'plafond de sessions'
               WHERE id IN (SELECT id FROM sessions WHERE user_id = %s AND revoked_at IS NULL
                            ORDER BY last_seen DESC OFFSET %s)""",
            (user_id, config.MAX_SESSIONS_PER_USER - 1))
        row = conn.execute(
            """INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent)
               VALUES (%s, %s, now() + make_interval(hours => %s), %s, %s) RETURNING expires_at""",
            (user_id, _sha256(token), config.SESSION_ABSOLUTE_H, ip, ua or None)).fetchone()
    return token, row["expires_at"].isoformat()


def revoke_sessions(where: str, params: tuple, by: str) -> int:
    with pool.connection() as conn:
        cur = conn.execute(
            f"UPDATE sessions SET revoked_at = now(), revoked_by = %s WHERE revoked_at IS NULL AND {where}",
            (by, *params))
        return cur.rowcount


# --- Principal et dépendances FastAPI ---------------------------------------------------------------
@dataclass(frozen=True)
class Principal:
    username: str
    full_name: str
    role: str
    user_id: int | None = None
    session_id: int | None = None
    service: bool = False
    must_change_password: bool = False


_bearer = HTTPBearer(auto_error=False)
_SESSION_SQL = """
    SELECT s.id AS sid, s.expires_at > now() AS live,
           s.revoked_at IS NULL AND s.last_seen > now() - make_interval(mins => %s) AS fresh,
           s.last_seen < now() - interval '60 seconds' AS stale,
           u.id AS uid, u.username, u.full_name, u.role, u.active, u.must_change_password
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = %s"""


def _unauthorized(detail: str = "jeton absent ou invalide") -> HTTPException:
    return HTTPException(401, detail, headers={"WWW-Authenticate": "Bearer"})


def authenticate(request: Request, creds: HTTPAuthorizationCredentials | None) -> Principal:
    token = creds.credentials if creds else ""
    if not token:
        raise _unauthorized()
    if hmac.compare_digest(token.encode(), config.API_TOKEN.encode()):
        return Principal("service", "Jeton de service", "operator", service=True)
    if token.startswith("sx_"):
        try:
            with pool.connection() as conn:
                row = conn.execute(_SESSION_SQL, (config.SESSION_IDLE_MIN, _sha256(token))).fetchone()
                if row is not None and row["live"] and row["fresh"] and row["active"] and row["stale"]:
                    conn.execute("UPDATE sessions SET last_seen = now() WHERE id = %s", (row["sid"],))
        except psycopg.Error:           # inclut PoolTimeout / PoolClosed (OperationalError)
            log.exception("base de données indisponible pendant l'authentification")
            raise HTTPException(503, "base de données indisponible") from None
        if row is not None:
            if not (row["live"] and row["fresh"] and row["active"]):
                raise _unauthorized("session expirée ou révoquée")   # jeton connu : pas une sonde
            return Principal(row["username"], row["full_name"], row["role"], row["uid"], row["sid"],
                             must_change_password=row["must_change_password"])
    # Jeton inconnu : sonde potentielle, comptée pour le blocage d'IP.
    ip = client_ip(request)
    note_failure(ip, None, user_agent(request))
    raise _unauthorized()


def require_role(minimum: str, allow_pending_password: bool = False):
    def dependency(request: Request, creds: HTTPAuthorizationCredentials | None = Security(_bearer)) -> Principal:
        principal = authenticate(request, creds)
        if principal.must_change_password and not allow_pending_password:
            raise HTTPException(403, "changement de mot de passe requis")
        if RANK[principal.role] < RANK[minimum]:
            log_event("ACCESS_DENIED", "WARNING", username=principal.username, ip=client_ip(request),
                      ua=user_agent(request), details=f"{request.method} {request.url.path} (rôle {principal.role})")
            raise HTTPException(403, "droits insuffisants")
        return principal
    return dependency


require_viewer = require_role("viewer")
require_operator = require_role("operator")
require_admin = require_role("admin")
require_session = require_role("viewer", allow_pending_password=True)   # /auth/me, mot de passe, déconnexion


def require_device_or_operator(request: Request,
                               creds: HTTPAuthorizationCredentials | None = Security(_bearer)) -> Principal | None:
    """ESP32 (jeton d'appareil) ou opérateur."""
    if creds and hmac.compare_digest(creds.credentials.encode(), config.API_DEVICE_TOKEN.encode()):
        return None
    return require_operator(request, creds)


# --- Connexion -----------------------------------------------------------------------------------
def _record_failure(username: str, user: dict | None, ip: str, ua: str, reason: str) -> None:
    log_event("LOGIN_FAILURE", "WARNING", username=username, ip=ip, ua=ua, details=reason)
    if user is not None:
        with pool.connection() as conn:
            row = conn.execute(
                """UPDATE users SET
                     failed_attempts = CASE WHEN failed_attempts + 1 >= %(max)s THEN 0 ELSE failed_attempts + 1 END,
                     lockouts = CASE WHEN failed_attempts + 1 >= %(max)s THEN lockouts + 1 ELSE lockouts END,
                     locked_until = CASE WHEN failed_attempts + 1 >= %(max)s
                       THEN now() + make_interval(secs => LEAST(%(base)s * power(2, lockouts), %(cap)s)::int)
                       ELSE locked_until END
                   WHERE id = %(id)s RETURNING locked_until > now() AS locked, locked_until""",
                {"max": config.LOGIN_MAX_FAILS, "base": config.LOCK_BASE_S, "cap": config.LOCK_MAX_S, "id": user["id"]}).fetchone()
        if row and row["locked"]:
            details = f"compte « {username} » en pause jusqu'à {row['locked_until']:%H:%M:%S} UTC après {config.LOGIN_MAX_FAILS} échecs"
            log_event("ACCOUNT_LOCKED", "CRITICAL", username=username, ip=ip, ua=ua, details=details)
            raise_intrusion_alert("WARNING", f"Tentative d'intrusion : {details} (IP {ip})",
                                  {"type": "ACCOUNT_LOCKED", "username": username, "ip": ip})
    note_failure(ip, username, ua)
    raise HTTPException(401, GENERIC_LOGIN_ERROR)


def login(username: str, password: str, otp: str | None, ip: str, ua: str) -> dict:
    username = username.strip().lower()[:64]
    remaining = ip_block_remaining(ip)
    if remaining:
        raise HTTPException(429, "Trop de tentatives depuis cette adresse. Réessayez plus tard.",
                            headers={"Retry-After": str(remaining)})
    if rate_limited(f"login:{ip}", config.LOGIN_RATE_PER_MIN, 60):     # simple limite de débit : pas de ban
        raise HTTPException(429, "Trop de tentatives de connexion : patientez une minute.", headers={"Retry-After": "60"})
    with pool.connection() as conn:
        user = conn.execute("SELECT * FROM users WHERE username = %s", (username,)).fetchone()

    if user is not None and user["locked_until"] is not None and user["locked_until"].timestamp() > time.time():
        verify_password(password, _DUMMY_HASH)                 # même durée de réponse, sans toucher au compteur
        log_event("LOGIN_REFUSED_LOCKED", "WARNING", username=username, ip=ip, ua=ua, details="compte verrouillé")
        note_failure(ip, username, ua)
        raise HTTPException(401, GENERIC_LOGIN_ERROR)
    password_ok = verify_password(password, user["password_hash"] if user else _DUMMY_HASH)
    if user is None or not password_ok:
        _record_failure(username, user, ip, ua, "identifiant inconnu" if user is None else "mot de passe incorrect")
    if not user["active"]:
        log_event("LOGIN_REFUSED_DISABLED", "WARNING", username=username, ip=ip, ua=ua, details="compte désactivé")
        note_failure(ip, username, ua)
        raise HTTPException(401, GENERIC_LOGIN_ERROR)

    new_step = None
    if user["totp_enabled"]:
        if not otp:
            raise HTTPException(401, "otp_required")        # mot de passe valide : on demande le second facteur
        new_step = verify_totp(user["totp_secret"], otp, user["totp_last_step"])
        if new_step is None:
            _record_failure(username, user, ip, ua, "code TOTP invalide")

    with pool.connection() as conn:
        conn.execute(
            """UPDATE users SET failed_attempts = 0, lockouts = 0, locked_until = NULL, last_login_at = now(),
                                last_login_ip = %s, totp_last_step = COALESCE(%s, totp_last_step) WHERE id = %s""",
            (ip, new_step, user["id"]))
    token, expires_at = create_session(user["id"], ip, ua)
    log_event("LOGIN_SUCCESS", "INFO", username=username, ip=ip, ua=ua)
    return {"token": token, "expires_at": expires_at, "username": username, "full_name": user["full_name"],
            "role": user["role"], "must_change_password": user["must_change_password"],
            "totp_enabled": user["totp_enabled"]}


def revoke_all_sessions() -> None:
    """Au démarrage de l'API : toutes les sessions sont fermées. Sans horloge RTC, l'heure du Pi peut sauter
    au redémarrage ; repartir de zéro évite qu'une session survive à un saut d'horloge."""
    with pool.connection() as conn:
        n = conn.execute("UPDATE sessions SET revoked_at = now(), revoked_by = 'redémarrage de l''API' "
                         "WHERE revoked_at IS NULL").rowcount
    if n:
        log.info("%d session(s) fermée(s) au démarrage", n)


def bootstrap_admin() -> None:
    """Crée le premier administrateur si aucun compte n'existe (mot de passe temporaire à changer)."""
    if not config.DASHBOARD_PASS:
        log.warning("aucun compte et DASHBOARD_PASS vide : créer un administrateur (voir docs/SECURITE.md)")
        return
    username = config.DASHBOARD_USER.strip().lower()
    if not USERNAME_RE.match(username):
        log.error("DASHBOARD_USER invalide pour un compte (a-z, 0-9, . _ -, 3 à 32 caractères)")
        return
    with pool.connection() as conn:
        if conn.execute("SELECT 1 FROM users LIMIT 1").fetchone():
            return
        conn.execute(
            """INSERT INTO users (username, full_name, role, password_hash, must_change_password, created_by)
               VALUES (%s, 'Administrateur', 'admin', %s, true, 'initialisation') ON CONFLICT DO NOTHING""",
            (username, hash_password(config.DASHBOARD_PASS)))
    log_event("USER_CREATED", "INFO", username=username, actor="initialisation",
              details="premier administrateur (changement de mot de passe imposé)")
