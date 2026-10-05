# API SENTINEL-X (FastAPI) + tableau de bord React. Contexte de build : racine du dépôt
# (cf. .dockerignore : seuls api/ et dashboard/ sont envoyés, jamais les secrets).

# --- 1. Compilation du tableau de bord (Node, jetée après le build) ---
FROM node:22.22.3-alpine3.24 AS dashboard
WORKDIR /build
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY dashboard/ ./
RUN npm run build

# --- 2. Image finale : Python seul (arm64 : wheels musllinux aarch64, aucune compilation) ---
FROM python:3.13.16-alpine3.24

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /srv
COPY api/requirements.txt .
RUN pip install -r requirements.txt \
 && adduser -D -H -u 10002 api

COPY api/app ./app
COPY --from=dashboard /build/dist ./app/static/dashboard
RUN python -m compileall -q /srv/app

USER 10002:10002
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8000/health || exit 1
# Un seul worker : RAM du Pi ; les routes synchrones tournent dans le pool de threads d'AnyIO.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
