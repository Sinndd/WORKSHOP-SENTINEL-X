#!/usr/bin/env bash
# Test de bout en bout du contrat v2 : MQTTS (comptes esp32 / api / vision) + API REST.
#   - télémétrie (format spec et format réel du firmware), alertes MQTT et HTTP ;
#   - circuit RFID : badge autorisé -> réponse accordée, badge inconnu -> refus + alerte ;
#   - commande superviseur reçue par le compte esp32 ;
#   - refus attendus : anonyme, mauvais mot de passe, ACL, jetons, validation, rôle lecture seule.
#
# Usage : ./scripts/smoke-test.sh                    # via le réseau Docker (mosquitto:8883)
#         ./scripts/smoke-test.sh --host 192.168.10.1   # MQTT via le port publié (depuis le Pi)
# Effets de bord : lignes de test marquées "smoke-", badge de test créé puis révoqué.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

IMAGE="$(grep -m1 -oE 'eclipse-mosquitto:[^"[:space:]]+' docker-compose.yml)"
NET=(--network sentinel_frontend); HOST=mosquitto
if [[ "${1:-}" == "--host" ]]; then NET=(--network host); HOST="$2"; fi
CA="$PWD/mosquitto/certs/ca.crt"
RUN_ID="smoke-$(date +%s)-$RANDOM"
NOW="$(date +%s)"
MARK=$(( (RANDOM << 15) | RANDOM ))                 # valeur unique pour retrouver nos lignes
hex() { printf '%02X' $((RANDOM % 256)); }
UID_OK="$(hex):$(hex):$(hex):$(hex)"; UID_KO="$(hex):$(hex):$(hex):$(hex):$(hex):$(hex):$(hex)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
ok() { echo "  [OK]   $*"; pass=$((pass + 1)); }
ko() { echo "  [FAIL] $*"; fail=$((fail + 1)); }
check() { local label="$1"; shift; if "$@"; then ok "$label"; else ko "$label"; fi; }
refused() { ! "$@" >/dev/null 2>&1; }

mqtt() {  # mqtt <pub|sub> <user> <password> args...
  local tool="mosquitto_$1" user="$2" pw="$3"; shift 3
  docker run --rm "${NET[@]}" --mount "type=bind,source=$CA,target=/ca.crt,readonly" "$IMAGE" \
    "$tool" -h "$HOST" -p "${MQTT_PORT:-8883}" --cafile /ca.crt ${user:+-u "$user"} ${pw:+-P "$pw"} "$@"
}
pub() { mqtt pub esp32 "$MQTT_PASS_ESP32" -q 1 -t "$1" -m "$2"; }
listen() {  # listen <fichier> <user> <password> <topic> : 1 message, 10 s max, en arrière-plan
  mqtt sub "$2" "$3" -t "$4" -C 1 -W 10 > "$1" 2>/dev/null &
  sleep 2   # laisse le temps à la poignée de main TLS et à l'abonnement
}
api() {  # api <METHODE> <chemin> <jeton|""> [corps] -> "CODE CORPS" (requête depuis le conteneur api)
  docker compose exec -T api python - "$@" <<'PY'
import sys, urllib.error, urllib.request
method, path, token = sys.argv[1:4]
body = sys.argv[4].encode() if len(sys.argv) > 4 else None
headers = {"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})}
req = urllib.request.Request(f"http://127.0.0.1:8000{path}", data=body, method=method, headers=headers)
try:
    with urllib.request.urlopen(req, timeout=10) as r:
        print(r.status, r.read().decode())
except urllib.error.HTTPError as e:
    print(e.code, e.read().decode())
PY
}
code() { api "$@" | cut -d' ' -f1; }
sql() {  # lecture avec le rôle sentinel_ro
  docker compose exec -T -e PGPASSWORD="$SENTINEL_RO_PASSWORD" postgres \
    psql -h 127.0.0.1 -U sentinel_ro -d "$POSTGRES_DB" -Atc "$1"
}
sql_is() {  # sql_is <requête> <attendu> : réessaie jusqu'à 15 s
  for _ in $(seq 1 15); do [[ "$(sql "$1")" == "$2" ]] && return 0; sleep 1; done; return 1
}

echo "== Broker"
check "port 1883 non publié" test -z "$(docker compose port mosquitto 1883 2>/dev/null)"
check "connexion anonyme refusée" refused mqtt pub "" "" -t sentinel/telemetry -m x
check "mauvais mot de passe refusé" refused mqtt pub esp32 wrong -t sentinel/telemetry -m x
listen "$TMP/acl" api "$MQTT_PASS_API" sentinel/commands
pub sentinel/commands '{"action":"EMERGENCY_STOP_ALL"}'          # interdit à esp32 par l'ACL
wait || true
check "ACL : esp32 ne peut pas publier de commande" test ! -s "$TMP/acl"

echo "== Télémétrie et alertes MQTT ($RUN_ID)"
pub sentinel/telemetry "{\"node_id\":\"SENTINEL-X-CORE\",\"timestamp\":$NOW,\"uptime_ms\":142580,\"metrics\":{\"temperature_celsius\":23.4,\"humidity_percent\":48.0,\"gas_raw_ppm\":215,\"presence_detected\":false},\"actuators_state\":{\"airlock_open\":false,\"gas_valve_open\":true,\"ventilation_active\":false,\"barrier_open\":false,\"alarm_active\":false},\"system\":{\"wifi_rssi_dbm\":-58,\"free_heap_bytes\":$MARK}}"
pub sentinel/telemetry "{\"node_id\":\"SENTINEL-X-CORE\",\"timestamp\":$MARK,\"metrics\":{\"temperature_celsius\":21.0,\"humidity_percent\":40.0,\"gas_raw_ppm\":4095,\"presence_detected\":true},\"actuators_state\":{\"airlock_open\":true}}"
pub sentinel/alerts "{\"node_id\":\"SENTINEL-X-CORE\",\"timestamp\":$NOW,\"event_type\":\"GAS_LEAK_WARNING\",\"severity\":\"WARNING\",\"source_sensor\":\"MQ2\",\"value\":3900,\"details\":\"$RUN_ID-mqtt\"}"
pub sentinel/alerts '{"node_id":"SENTINEL-X-CORE","broken"'
mqtt pub vision "$MQTT_PASS_VISION" -q 1 -t sentinel/vision/events \
  -m "{\"ts\":$NOW,\"label\":\"person\",\"confidence\":0.9,\"bbox\":[10,20,100,200],\"frame_w\":640,\"frame_h\":480,\"snapshot_path\":\"$RUN_ID.jpg\"}"
check "télémétrie (format spec) en base" \
  sql_is "SELECT count(*) FROM telemetry WHERE free_heap_bytes=$MARK AND gas_valve_open AND gas_raw_ppm=215 AND ts=to_timestamp($NOW)" 1
check "télémétrie firmware (timestamp=millis) horodatée à réception" \
  sql_is "SELECT count(*) FROM telemetry WHERE device_timestamp=$MARK AND gas_raw_ppm=4095 AND abs(extract(epoch FROM ts - received_at)) < 1" 1
check "devices.last_seen mis à jour" \
  sql_is "SELECT count(*) FROM devices WHERE node_id='SENTINEL-X-CORE' AND last_seen > now() - interval '1 minute' AND last_free_heap_bytes=$MARK" 1
check "alerte MQTT en base (channel mqtt)" sql_is "SELECT channel FROM alerts WHERE details='$RUN_ID-mqtt'" mqtt
check "événement vision en base" sql_is "SELECT count(*) FROM vision_events WHERE snapshot_path='$RUN_ID.jpg'" 1
ingestor_logs="$(docker compose logs --since 1m ingestor)"   # pas de `logs | grep -q` (SIGPIPE + pipefail)
check "JSON invalide rejeté et journalisé" grep -q 'rejeté sentinel/alerts: JSON invalide' <<<"$ingestor_logs"

echo "== API REST"
check "GET /health public" test "$(code GET /health '')" = 200
check "GET /ready : base + broker OK" test "$(api GET /ready '')" = '200 {"status":"ok","db":true,"mqtt":true}'
ALERT="{\"node_id\":\"SENTINEL-X-CORE\",\"timestamp\":$NOW,\"event_type\":\"INTRUSION_DETECTED\",\"severity\":\"CRITICAL\",\"source_sensor\":\"PIR_MOTION\",\"value\":1.0,\"details\":\"$RUN_ID-http\"}"
check "POST /alerts sans jeton -> 401" test "$(code POST /api/v1/alerts '' "$ALERT")" = 401
check "POST /alerts jeton appareil -> 201" test "$(code POST /api/v1/alerts "$API_DEVICE_TOKEN" "$ALERT")" = 201
check "POST /alerts invalide -> 422" test "$(code POST /api/v1/alerts "$API_DEVICE_TOKEN" "${ALERT/CRITICAL/URGENT}")" = 422
check "jeton appareil refusé en lecture -> 401" test "$(code GET /api/v1/alerts "$API_DEVICE_TOKEN")" = 401
check "alerte HTTP en base (channel http)" sql_is "SELECT channel FROM alerts WHERE details='$RUN_ID-http'" http
alert_id="$(sql "SELECT id FROM alerts WHERE details='$RUN_ID-http'")"
check "POST /alerts/{id}/ack" grep -q '"acknowledged":true' <<<"$(api POST "/api/v1/alerts/$alert_id/ack" "$API_TOKEN")"
check "GET /telemetry/latest" test "$(code GET /api/v1/telemetry/latest "$API_TOKEN")" = 200

echo "== Contrôle d'accès RFID"
BADGE="{\"user_name\":\"$RUN_ID\",\"clearance_level\":\"LEVEL_4_AETHERCORP\"}"
check "PUT /badges/$UID_OK" test "$(code PUT "/api/v1/badges/$UID_OK" "$API_TOKEN" "$BADGE")" = 200
listen "$TMP/granted" esp32 "$MQTT_PASS_ESP32" sentinel/access/response
pub sentinel/access "{\"node_id\":\"SENTINEL-X-CORE\",\"card_uid\":\"$UID_OK\",\"door_id\":\"AIRLOCK_MAIN\"}"
wait || true
check "badge autorisé -> access_granted=true reçu par l'ESP" \
  grep -q "\"card_uid\":\"$UID_OK\",\"access_granted\":true,\"user_name\":\"$RUN_ID\".*\"auto_unlock_door\":true" "$TMP/granted"
listen "$TMP/denied" esp32 "$MQTT_PASS_ESP32" sentinel/access/response
pub sentinel/access "{\"node_id\":\"SENTINEL-X-CORE\",\"timestamp\":$NOW,\"card_uid\":\"$UID_KO\",\"card_type\":\"MIFARE_CLASSIC\",\"door_id\":\"AIRLOCK_MAIN\"}"
wait || true
check "badge inconnu -> access_granted=false" grep -q "\"card_uid\":\"$UID_KO\",\"access_granted\":false" "$TMP/denied"
check "badge inconnu -> alerte UNAUTHORIZED_ACCESS" \
  sql_is "SELECT count(*) FROM alerts WHERE event_type='UNAUTHORIZED_ACCESS' AND details LIKE '%$UID_KO'" 1
check "passages journalisés (access_events)" \
  sql_is "SELECT string_agg(access_granted::text, ',' ORDER BY id) FROM access_events WHERE card_uid IN ('$UID_OK','$UID_KO')" "true,false"
check "DELETE /badges (révocation)" grep -q '"active":false' <<<"$(api DELETE "/api/v1/badges/$UID_OK" "$API_TOKEN")"

echo "== Commandes superviseur"
CMD='{"action":"CONTROL_MOTORS","commands":[{"motor_id":0,"direction":"CW","angle_deg":90,"speed_rpm":12},{"motor_id":5,"direction":"CCW","angle_deg":45,"speed_rpm":8}]}'
listen "$TMP/cmd" esp32 "$MQTT_PASS_ESP32" sentinel/commands
check "POST /commands -> 202" test "$(code POST /api/v1/commands "$API_TOKEN" "$CMD")" = 202
wait || true
check "commande reçue par l'ESP sur sentinel/commands" grep -q '"action":"CONTROL_MOTORS".*"motor_id":5' "$TMP/cmd"
BAD_CMD='{"action":"CONTROL_MOTORS","commands":[{"motor_id":9,"direction":"CW","angle_deg":90,"speed_rpm":12}]}'
check "motor_id hors plage -> 422" test "$(code POST /api/v1/commands "$API_TOKEN" "$BAD_CMD")" = 422
check "commande journalisée" \
  sql_is "SELECT count(*) > 0 FROM commands WHERE action='CONTROL_MOTORS' AND created_at > now() - interval '1 minute'" t

echo "== Base et services"
check "sentinel_ro ne peut pas écrire" refused docker compose exec -T -e PGPASSWORD="$SENTINEL_RO_PASSWORD" postgres \
  psql -h 127.0.0.1 -U sentinel_ro -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "INSERT INTO devices (node_id) VALUES ('ro-check')"
for svc in ingestor api; do
  check "$svc toujours healthy" test "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q "$svc")")" = healthy
done

echo "== Résultat : $pass OK, $fail échec(s)"
[[ $fail -eq 0 ]]
