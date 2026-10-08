"""API SENTINEL-X (FastAPI) — point d'entrée.

Lancement : uvicorn app.main:app --host 0.0.0.0 --port 8000
Documentation interactive : http://<pi>:8000/docs
"""
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import auth, config
from .auth_routes import router as auth_router
from .db import pool
from .faces import router as faces_router
from .mqtt_bridge import bridge
from .routes import router

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


class _SkipHealth(logging.Filter):
    """Pas de ligne de log pour le healthcheck Docker (toutes les 30 s) : moins d'écritures sur la carte SD."""
    def filter(self, record):
        return "/health" not in record.getMessage()


logging.getLogger("uvicorn.access").addFilter(_SkipHealth())


@asynccontextmanager
async def lifespan(_app: FastAPI):
    pool.open(wait=False)
    try:
        auth.revoke_all_sessions()
        auth.bootstrap_admin()
    except Exception:
        logging.getLogger("api").exception("création du compte administrateur initial impossible")
    bridge.start()
    yield
    bridge.stop()
    pool.close()


app = FastAPI(
    title="API SENTINEL-X",
    version="2.2.0",
    description="Supervision du module ESP32 SENTINEL-X : alertes, télémétrie, contrôle d'accès RFID, "
                "commandes moteurs/alarme. Authentification : comptes personnels (`POST /api/v1/auth/login`) puis `Authorization: Bearer <jeton de session>`.",
    lifespan=lifespan,
    docs_url="/docs" if config.API_DOCS else None,
    redoc_url="/redoc" if config.API_DOCS else None,
    openapi_url="/openapi.json" if config.API_DOCS else None,
)
app.include_router(router)
app.include_router(auth_router)
app.include_router(faces_router)


@app.get("/health", tags=["supervision"])
def health():
    """Vivacité du processus (healthcheck Docker), sans dépendance externe."""
    return {"status": "ok"}


@app.get("/ready", tags=["supervision"])
def ready():
    """Disponibilité : base de données et broker MQTT joignables."""
    try:
        with pool.connection(timeout=2) as conn:
            conn.execute("SELECT 1")
        db_ok = True
    except Exception:
        db_ok = False
    checks = {"db": db_ok, "mqtt": bridge.connected}
    ok = all(checks.values())
    return JSONResponse({"status": "ok" if ok else "degraded", **checks}, status_code=200 if ok else 503)



# Tableau de bord React (dashboard/, compilé dans l'image par le Dockerfile). Page publique : les
# données, elles, exigent le jeton API_TOKEN. check_dir=False : absent hors image (tests unitaires).
app.mount("/dashboard", StaticFiles(directory=Path(__file__).parent / "static" / "dashboard", html=True,
                                    check_dir=False), name="dashboard")

CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
       "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")


MAX_BODY = 64 * 1024                     # JSON : 64 Kio ; seul le snapshot webcam peut aller jusqu'à 2 Mio
MAX_BODY_SNAPSHOT = 2 * 1024 * 1024 + 1024
BIG_BODY_PATHS = {"/api/v1/vision/snapshot", "/api/v1/faces/enrollments/photo"}   # images : jusqu'à 2 Mio


@app.middleware("http")
async def security_headers(request: Request, call_next):
    if request.method in ("POST", "PUT", "PATCH"):
        limit = MAX_BODY_SNAPSHOT if request.url.path in BIG_BODY_PATHS else MAX_BODY
        length = request.headers.get("content-length")
        if length is None and "chunked" in request.headers.get("transfer-encoding", "").lower():
            return JSONResponse({"detail": "Content-Length requis"}, status_code=411)
        if length is not None and (not length.isdigit() or int(length) > limit):
            return JSONResponse({"detail": "corps de requête trop volumineux"}, status_code=413)
    remaining = auth.ip_block_remaining(auth.client_ip(request))
    if remaining and request.url.path not in ("/health", "/ready"):
        return JSONResponse({"detail": "Adresse temporairement bloquée (tentatives d'intrusion détectées)."},
                            status_code=429, headers={"Retry-After": str(remaining)})
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Referrer-Policy"] = "no-referrer"
    if request.url.path.startswith("/api"):
        response.headers["Cache-Control"] = "no-store"
    if request.url.path.startswith("/dashboard"):
        response.headers["Content-Security-Policy"] = CSP
        # Fichiers de build à nom haché : immuables. Le reste (index.html, modèle 3D) est revalidé à chaque
        # chargement (ETag -> 304) pour qu'une nouvelle version soit vue sans vider le cache du navigateur.
        if request.url.path.startswith("/dashboard/assets/"):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            response.headers["Cache-Control"] = "no-cache"
    return response
