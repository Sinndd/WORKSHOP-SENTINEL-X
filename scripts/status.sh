#!/usr/bin/env bash
# MCO léger : état des conteneurs, CPU/RAM, RAM hôte, logs MQTT, volumétrie de la base.
# Usage : ./scripts/status.sh        (code retour 1 si un service n'est pas healthy ou si le budget RAM est dépassé)
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
BUDGET_MB="${BUDGET_MB:-450}"
rc=0

echo "== Conteneurs"
docker compose ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}'
unhealthy="$(docker compose ps --format '{{.Service}} {{.Status}}' | grep -v '(healthy)' || true)"
[[ -n "$unhealthy" ]] && { echo "!! Non healthy : $unhealthy"; rc=1; }

echo; echo "== CPU / RAM par conteneur"
ids="$(docker compose ps -q)"
[[ -z "$ids" ]] && { echo "Stack arrêtée."; exit 1; }
# shellcheck disable=SC2086
stats="$(docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.PIDs}}' $ids)"
printf 'NOM\tCPU\tMEM / LIMITE\tMEM%%\tPIDS\n%s\n' "$stats" | column -t -s $'\t'
total="$(awk -F'\t' '{ split($3, m, " / "); v = m[1] + 0;
  if (m[1] ~ /GiB/) v *= 1024; else if (m[1] ~ /KiB/) v /= 1024; else if (m[1] ~ /B$/ && m[1] !~ /iB/) v /= 1048576;
  t += v } END { printf "%.0f", t }' <<<"$stats")"
echo "Total stack Docker : ${total} Mo (budget ${BUDGET_MB} Mo)"
(( total > BUDGET_MB )) && { echo "!! BUDGET RAM DÉPASSÉ"; rc=1; }

echo; echo "== Hôte"
if command -v free >/dev/null; then
  free -m
  awk '/MemAvailable/ { printf "RAM disponible : %d Mo\n", $2 / 1024 }' /proc/meminfo
  swapon --show 2>/dev/null || true
else
  echo "(free indisponible : hôte non Linux, mesure à faire sur le Pi)"
fi
df -h / | tail -1 | awk '{ print "Disque / : " $3 " utilisés, " $4 " libres (" $5 ")" }'

echo; echo "== Logs Mosquitto (json-file, rotation 2 x 5 Mo)"
log_path="$(docker inspect -f '{{.LogPath}}' "$(docker compose ps -q mosquitto)")"
if [[ -r "$log_path" ]]; then du -h "$log_path"*
elif sudo -n true 2>/dev/null && sudo test -e "$log_path"; then sudo du -h "$log_path"*
else echo "Fichier courant (approx.) : $(docker compose logs --no-color mosquitto | wc -c | awk '{ printf "%.1f Ko", $1 / 1024 }')"
fi

echo; echo "== Base PostgreSQL"
docker compose exec -T postgres psql -U postgres -d "$POSTGRES_DB" -P footer=off -c "
SELECT 'devices' AS table_name, count(*) AS lignes FROM devices
UNION ALL SELECT 'telemetry', count(*) FROM telemetry
UNION ALL SELECT 'alerts', count(*) FROM alerts
UNION ALL SELECT 'badges', count(*) FROM badges
UNION ALL SELECT 'access_events', count(*) FROM access_events
UNION ALL SELECT 'commands', count(*) FROM commands
UNION ALL SELECT 'vision_events', count(*) FROM vision_events;" \
  -c "SELECT pg_size_pretty(pg_database_size(current_database())) AS taille_base,
            (SELECT count(*) FROM alerts WHERE NOT acknowledged) AS alertes_non_acquittees,
            (SELECT max(received_at) FROM telemetry) AS derniere_mesure;" \
  -c "SELECT node_id, last_seen, last_wifi_rssi_dbm AS rssi_dbm, last_free_heap_bytes AS heap FROM devices ORDER BY node_id;"
exit $rc
