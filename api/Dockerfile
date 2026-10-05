# API SENTINEL-X — PLACEHOLDER (bibliothèque standard uniquement).
# À remplacer par l'API du coéquipier DEV : garder USER non-root, le port 8000
# et la route GET /health (utilisée par le healthcheck).
FROM python:3.13.16-alpine3.24

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
RUN adduser -D -H -u 10002 api
COPY server.py .

USER 10002:10002
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8000/health || exit 1
CMD ["python", "server.py"]
