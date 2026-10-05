# Ingestor MQTT -> PostgreSQL (arm64 : wheels musllinux aarch64, aucune compilation)
FROM python:3.13.16-alpine3.24

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt \
 && adduser -D -H -u 10001 ingestor

COPY validation.py ingestor.py ./
RUN python -m compileall -q /app

USER 10001:10001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD test -n "$(find /tmp/healthy -mmin -1 2>/dev/null)"
CMD ["python", "ingestor.py"]
