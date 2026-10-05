#!/usr/bin/env bash
# Test de bout en bout : publie en MQTTS (telemetry, alerte, événement vision) avec
# les comptes du contrat, puis vérifie la présence en base. Vérifie aussi les refus
# attendus (anonyme, mauvais mot de passe, ACL, JSON invalide, rôle lecture seule).
#
# Usage : ./scripts/smoke-test.sh                  # via le réseau Docker (mosquitto:8883)
#         ./scripts/smoke-test.sh --host 192.168.10.1   # via le port publié (depuis le Pi)
# Effet de bord : sentinel-01 passe "online" (last_seen mis à jour) ; lignes de test marquées "smoke-".
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

IMAGE="$(grep -m1 -oE 'eclipse-mosquitto:[^"[:space:]]+' docker-compose.yml)"
NET=(--network sentinel_frontend); HOST=mosquitto
if [[ "${1:-}" == "--host" ]]; then NET=(--network host); HOST="$2"; fi
CA="$PWD/mosquitto/certs/ca.crt"
RUN_ID="smoke-$(date +%s)-$RANDOM"
NOW="$(date +%s)"
SEQ=$(( (RANDOM << 15) | RANDOM ))
pass=0; fail=0
ok()  { echo "  [OK]   $*"; pass=$((pass + 1)); }
ko()  { echo "  [FAIL] $*"; fail=$((fail + 1)); }

mqtt() {  # mqtt <pub|sub> <user> <password> args...
  local tool="mosquitto_$1" user="$2" pw="$3"; shift 3
  docker run --rm "${NET[@]}" --mount "type=bind,source=$CA,target=/ca.crt,readonly" "$IMAGE" \
    "$tool" -h "$HOST" -p "${MQTT_PORT:-8883}" --cafile /ca.crt ${user:+-u "$user"} ${pw:+-P "$pw"} "$@"
}
sql() {  # requête en lecture seule avec le rôle sentinel_ro
  docker compose exec -T -e PGPASSWORD="$SENTINEL_RO_PASSWORD" postgres \
    psql -h 127.0.0.1 -U sentinel_ro -d "$POSTGRES_DB" -Atc "$1"
}
wait_sql() {  # wait_sql <requête> <attendu> : jusqu'à 15 s
  for _ in $(seq 1 15); do [[ "$(sql "$1")" == "$2" ]] && return 0; sleep 1; done; return 1
}

echo "== Sécurité du broker"
[[ -z "$(docker compose port mosquitto 1883 2>/dev/null)" ]] && ok "port 1883 non publié" || ko "port 1883 publié"
mqtt pub "" "" -t sentinel/sentinel-01/telemetry -m x >/dev/null 2>&1 && ko "connexion anonyme acceptée" || ok "connexion anonyme refusée"
mqtt pub esp_sentinel-01 wrong -t sentinel/sentinel-01/telemetry -m x >/dev/null 2>&1 && ko "mauvais mot de passe accepté" || ok "mauvais mot de passe refusé"

echo "== Publications MQTTS ($RUN_ID)"
TELEMETRY="{\"v\":1,\"device_id\":\"sentinel-01\",\"ts\":$NOW,\"seq\":$SEQ,\"temperature_c\":22.5,\"humidity_pct\":45.0,\"gas_raw\":321,\"motion\":true,\"rssi_dbm\":-58,\"uptime_s\":123}"
ALERT="{\"v\":1,\"device_id\":\"sentinel-01\",\"ts\":$NOW,\"type\":\"gas_high\",\"severity\":\"critical\",\"value\":812,\"threshold\":600,\"message\":\"$RUN_ID\"}"
VISION="{\"v\":1,\"ts\":$NOW,\"label\":\"person\",\"confidence\":0.91,\"bbox\":[10,20,100,200],\"frame_w\":640,\"frame_h\":480,\"snapshot_path\":\"$RUN_ID.jpg\"}"
mqtt pub esp_sentinel-01 "$MQTT_PASS_ESP_SENTINEL_01" -q 0 -t sentinel/sentinel-01/telemetry -m "$TELEMETRY" && ok "telemetry publiée (QoS 0)" || ko "publication telemetry"
mqtt pub esp_sentinel-01 "$MQTT_PASS_ESP_SENTINEL_01" -q 1 -t sentinel/sentinel-01/alerts -m "$ALERT" && ok "alerte publiée (QoS 1)" || ko "publication alerte"
mqtt pub vision "$MQTT_PASS_VISION" -q 1 -t sentinel/vision/events -m "$VISION" && ok "événement vision publié" || ko "publication vision"
# Messages qui NE doivent PAS arriver en base :
mqtt pub esp_sentinel-01 "$MQTT_PASS_ESP_SENTINEL_01" -q 1 -t sentinel/sentinel-02/alerts \
  -m "${ALERT//sentinel-01/sentinel-02}" >/dev/null 2>&1 || true   # interdit par l'ACL
mqtt pub esp_sentinel-01 "$MQTT_PASS_ESP_SENTINEL_01" -q 1 -t sentinel/sentinel-01/alerts -m '{"v":1,"broken"' || true
mqtt pub esp_sentinel-01 "$MQTT_PASS_ESP_SENTINEL_01" -q 1 -t sentinel/sentinel-01/alerts \
  -m "${ALERT/gas_high/fire}" || true   # type hors contrat

echo "== Vérifications en base (rôle sentinel_ro)"
wait_sql "SELECT count(*) FROM sensor_readings WHERE device_id='sentinel-01' AND seq=$SEQ AND gas_raw=321 AND received_at IS NOT NULL" 1 \
  && ok "sensor_readings contient la telemetry (seq=$SEQ)" || ko "telemetry absente"
wait_sql "SELECT count(*) FROM alerts WHERE message='$RUN_ID' AND type='gas_high' AND payload->>'severity'='critical'" 1 \
  && ok "alerts contient l'alerte" || ko "alerte absente"
wait_sql "SELECT count(*) FROM vision_events WHERE snapshot_path='$RUN_ID.jpg'" 1 \
  && ok "vision_events contient l'événement" || ko "événement vision absent"
wait_sql "SELECT state FROM devices WHERE device_id='sentinel-01' AND last_seen > now() - interval '1 minute'" online \
  && ok "devices.last_seen / state mis à jour" || ko "devices non mis à jour"
sleep 2
[[ "$(sql "SELECT count(*) FROM alerts WHERE message='$RUN_ID'")" == 1 ]] \
  && ok "ACL (sentinel-02) et alerte hors contrat non insérées" || ko "message interdit inséré"
# Logs capturés d'abord : `logs | grep -q` + pipefail échoue aléatoirement (SIGPIPE).
ingestor_logs="$(docker compose logs --since 1m ingestor)"
grep -q 'rejeté.*JSON invalide' <<<"$ingestor_logs" && ok "JSON invalide rejeté et journalisé" || ko "rejet JSON non journalisé"
sql "INSERT INTO devices (device_id) VALUES ('smoke-ro-check')" >/dev/null 2>&1 && ko "sentinel_ro peut écrire" || ok "sentinel_ro ne peut pas écrire"
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q ingestor)")" == healthy ]] \
  && ok "ingestor toujours healthy" || ko "ingestor non healthy"

echo "== Résultat : $pass OK, $fail échec(s)"
[[ $fail -eq 0 ]]
