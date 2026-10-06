#!/usr/bin/env bash
# Audit de sécurité défensif de la stack SENTINEL-X en cours d'exécution (preuves pour le rapport d'audit).
# Vérifie : surface exposée, protections de l'API, durcissement du broker MQTT (TLS, ACL), secrets hors dépôt.
# Aucune attaque destructive ; les tests de brute force / blocage d'IP sont couverts par les tests unitaires.
#
# Usage : ./scripts/audit-security.sh        (la stack doit tourner : ./scripts/start.sh)
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1   # Git Bash (Windows) : pas de conversion des chemins passés à docker

DC="docker compose"; command -v docker &>/dev/null && docker compose version &>/dev/null || DC="podman compose"
PASS=0; FAIL=0
check() { # check "description" commande...
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "PASS  $name"; PASS=$((PASS+1)); else echo "FAIL  $name"; FAIL=$((FAIL+1)); fi
}
env_get() { grep -m1 "^$1=" .env | cut -d= -f2- | tr -d '\r' | sed 's/ *#.*//;s/ *$//'; }
section() { echo; echo "== $*"; }

section "1. Surface exposée"
published="$($DC ps --format '{{.Ports}}' | grep -oE '0\.0\.0\.0:[0-9]+' | cut -d: -f2 | sort -nu | tr '\n' ' ')"
echo "ports publiés sur l'hôte : $published"
check "seuls 80/443 (proxy HTTPS), 123 (NTP) et 8883 (MQTTS) sont publiés ; l'API (8000) ne l'est pas" test "$published" = "80 123 443 8883 "
check "PostgreSQL non publié sur l'hôte" bash -c "! $DC ps --format '{{.Ports}}' | grep -q '5432->'"
check "MQTT en clair (1883) non publié" bash -c "! $DC ps --format '{{.Ports}}' | grep -q '1883->'"
for svc in proxy ntp api mosquitto postgres ingestor; do
  cid="$($DC ps -q $svc)"
  check "$svc : racine en lecture seule, no-new-privileges, toutes capacités retirées" \
    bash -c "docker inspect $cid --format '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.SecurityOpt}} {{.HostConfig.CapDrop}}' | grep -q 'true .*no-new-privileges.* \[ALL\]'"
  check "$svc : ne tourne pas en root" bash -c "u=\$(docker inspect $cid --format '{{.Config.User}}'); [ -n \"\$u\" ] && [ \"\${u%%:*}\" != 0 ] && [ \"\${u%%:*}\" != root ]"
  check "$svc : limite mémoire définie" bash -c "[ \"\$(docker inspect $cid --format '{{.HostConfig.Memory}}')\" -gt 0 ]"
done
check "socket Docker non montée dans les conteneurs" bash -c "! docker inspect \$($DC ps -q) --format '{{range .Mounts}}{{.Source}} {{end}}' | grep -q docker.sock"

section "2. API (depuis le conteneur api)"
$DC exec -T api python - < scripts/audit_api.py && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
# Le contrôle « pas d'énumération » tente un mauvais mot de passe sur « admin » : on remet les compteurs de verrouillage à zéro
# pour que l'audit ne laisse pas le vrai compte administrateur verrouillé.
$DC exec -T postgres sh -c 'psql -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "UPDATE users SET failed_attempts=0, lockouts=0, locked_until=NULL"' >/dev/null 2>&1

section "3. Broker MQTT (TLS, authentification, ACL)"
MQ="$($DC ps -q mosquitto)"
export MQTT_PASS_ESP32="$(env_get MQTT_PASS_ESP32)" MQTT_PASS_API="$(env_get MQTT_PASS_API)"
check "connexion anonyme refusée" bash -c "! docker exec $MQ mosquitto_pub -h localhost -p 8883 --cafile /mosquitto/certs/ca.crt -t sentinel/telemetry -m {}"
check "mauvais mot de passe refusé" bash -c "! docker exec $MQ mosquitto_pub -h localhost -p 8883 --cafile /mosquitto/certs/ca.crt -u esp32 -P mauvais -t sentinel/telemetry -m '{}'"
check "TLS 1.1 refusé" bash -c "! docker exec $MQ mosquitto_pub -h localhost -p 8883 --cafile /mosquitto/certs/ca.crt --tls-version tlsv1.1 -u esp32 -P \"$MQTT_PASS_ESP32\" -t sentinel/telemetry -m '{}'"
check "TLS 1.2 + identifiants valides acceptés (le contrôle positif qui rend les refus ci-dessus probants)" docker exec -e MQTT_PASS_ESP32 "$MQ" sh -c "mosquitto_pub -h localhost -p 8883 --cafile /mosquitto/certs/ca.crt --tls-version tlsv1.2 -u esp32 -P \"\$MQTT_PASS_ESP32\" -t sentinel/telemetry -m '{\"audit\":true}' -q 1"
check "connexion sans vérification de la CA refusée (certificat non fiable)" bash -c "! docker exec $MQ mosquitto_pub -h localhost -p 8883 -u esp32 -P \"$MQTT_PASS_ESP32\" -t sentinel/telemetry -m '{}'"
# ACL : l'ESP ne doit ni écouter les commandes d'un autre, ni écrire sur le topic des commandes, ni tout espionner avec '#'.
docker exec -e MQTT_PASS_ESP32 -e MQTT_PASS_API "$MQ" sh -c '
  rm -f /tmp/spy /tmp/cmd
  mosquitto_sub -h localhost -p 8883 --cafile /mosquitto/certs/ca.crt -u esp32 -P "$MQTT_PASS_ESP32" -t "#" -W 4 > /tmp/spy 2>/dev/null &
  mosquitto_sub -h localhost -p 8883 --cafile /mosquitto/certs/ca.crt -u api -P "$MQTT_PASS_API" -t sentinel/commands -W 4 > /tmp/cmd 2>/dev/null &
  sleep 1
  mosquitto_pub -h localhost -p 8883 --cafile /mosquitto/certs/ca.crt -u esp32 -P "$MQTT_PASS_ESP32" -t sentinel/commands -m "{\"action\":\"EMERGENCY_STOP_ALL\"}"
  mosquitto_pub -h localhost -p 8883 --cafile /mosquitto/certs/ca.crt -u api -P "$MQTT_PASS_API" -t sentinel/access/response -m "{\"audit\":1}"
  mosquitto_pub -h localhost -p 8883 --cafile /mosquitto/certs/ca.crt -u api -P "$MQTT_PASS_API" -t sentinel/secret/test -m "{\"audit\":1}"
  wait' >/dev/null 2>&1
check "ACL : l'ESP ne peut pas publier sur sentinel/commands" docker exec "$MQ" sh -c '[ ! -s /tmp/cmd ]'
check "ACL : l'abonnement '#' de l'ESP ne reçoit rien d'inattendu (seulement ses topics)" \
  docker exec "$MQ" sh -c '! grep -q "secret/test\|EMERGENCY" /tmp/spy'
check "charge utile > max_packet_size (4 Kio) rejetée" bash -c "! docker exec $MQ sh -c 'head -c 6000 /dev/zero | tr \"\\0\" A | mosquitto_pub -h localhost -p 8883 --cafile /mosquitto/certs/ca.crt -u esp32 -P \"\$MQTT_PASS_ESP32\" -t sentinel/telemetry -s'"

section "4. Secrets et dépôt"
check ".env ignoré par Git" git check-ignore -q .env
check "clés privées et secrets MQTT ignorés par Git" bash -c "git check-ignore -q mosquitto/certs/ca.key && git check-ignore -q mosquitto/secrets/passwd"
check "secrets.h du firmware ignoré par Git" git check-ignore -q firmware/sentinel_core/secrets.h
check "aucun mot de passe / jeton en clair dans les fichiers suivis (hors exemples et tests)" \
  bash -c "! git grep -nIE '(PASS|PASSWORD|TOKEN|SECRET)[A-Z_]* *[=(] *\"[A-Za-z0-9!@#%^&*_.-]{6,}\"' -- ':!*.example' ':!api/tests' ':!docs' ':!*.md' ':!scripts/audit*' ':!api/app/static' ':!dashboard/package-lock.json' | grep -v 'getenv\|environ\|change-me\|CHANGE-ME'"
check "aucun fichier de clé privée suivi par Git" bash -c "! git ls-files | grep -E '\.(key|pem)$'"

echo
echo "Résultat : $PASS réussis, $FAIL en échec"
[[ $FAIL -eq 0 ]]
