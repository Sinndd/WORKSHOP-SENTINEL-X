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

from .db import pool
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
    bridge.start()
    yield
    bridge.stop()
    pool.close()


app = FastAPI(
    title="API SENTINEL-X",
    version="2.1.0",
    description="Supervision du module ESP32 SENTINEL-X : alertes, télémétrie, contrôle d'accès RFID, "
                "commandes moteurs/alarme. Authentification : `Authorization: Bearer <jeton>`.",
    lifespan=lifespan,
)
app.include_router(router)


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

CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
       "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    if request.url.path.startswith("/dashboard"):
        response.headers["Content-Security-Policy"] = CSP
        response.headers["Referrer-Policy"] = "no-referrer"
    return response
