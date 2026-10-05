#!/usr/bin/env bash
# Génère .env (mots de passe aléatoires) puis mosquitto/secrets/passwd (haché par mosquitto_passwd).
#
# Idempotent : un .env existant n'est jamais écrasé (sauf --force) ; le fichier
# passwd est en revanche toujours reconstruit à partir du .env courant.
# Aucun mot de passe ne transite en argument de commande (pas de fuite via `ps`).
#
# Usage : ./scripts/gen-env.sh [--force]
# (sans --force, les clés apparues dans .env.example sont ajoutées au .env existant)
set -euo pipefail
cd "$(dirname "$0")/.."

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

MOSQUITTO_IMAGE="$(grep -m1 -oE 'eclipse-mosquitto:[^"[:space:]]+' docker-compose.yml)"

rand() { head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-32; }

umask 077

if [[ -f .env && $FORCE -eq 0 ]]; then
  echo "[gen-env] .env existe déjà : conservé (utiliser --force pour régénérer)."
  # Clés ajoutées à .env.example depuis la génération : complétées avec un nouveau secret, sans toucher aux autres.
  sed -e '/^#/d' -e 's/[[:space:]]*#.*$//' -e '/^$/d' .env.example | while IFS= read -r line; do
    key="${line%%=*}"
    if ! grep -q "^${key}=" .env; then
      [[ $line == *change-me* ]] && line="${line/change-me/$(rand)}"
      printf '%s\n' "$line" >> .env
      echo "[gen-env] clé ajoutée : $key"
    fi
  done
else
  [[ -f .env ]] && cp .env ".env.bak.$(date +%Y%m%d%H%M%S)"
  hn="$(hostname -s 2>/dev/null || hostname)"
  sed \
    -e "s/^PUID=.*/PUID=$(id -u)/" \
    -e "s/^PGID=.*/PGID=$(id -g)/" \
    -e "s/^SENTINEL_HOSTNAME=.*/SENTINEL_HOSTNAME=${hn}/" \
    -e '/^#/d' -e 's/[[:space:]]*#.*$//' \
    .env.example |
  {
    echo "# Généré par scripts/gen-env.sh le $(date -Iseconds) — NE PAS VERSIONNER"
    # Chaque "change-me" devient un secret distinct de 32 caractères alphanumériques.
    while IFS= read -r line; do
      [[ $line == *change-me* ]] && line="${line/change-me/$(rand)}"
      printf '%s\n' "$line"
    done
  } > .env
  chmod 600 .env
  echo "[gen-env] .env généré (mode 600)."
fi

set -a; . ./.env; set +a

# --- Fichier de mots de passe Mosquitto ---------------------------------------
SECRETS_DIR="$PWD/mosquitto/secrets"
tmp="$SECRETS_DIR/passwd.tmp"
trap 'rm -f "$tmp"' EXIT
{
  printf 'esp32:%s\n'           "$MQTT_PASS_ESP32"
  printf 'ingestor:%s\n'        "$MQTT_PASS_INGESTOR"
  printf 'api:%s\n'             "$MQTT_PASS_API"
  printf 'vision:%s\n'          "$MQTT_PASS_VISION"
  printf 'healthcheck:%s\n'     "$MQTT_PASS_HEALTHCHECK"
} > "$tmp"

# mosquitto_passwd -U hache le fichier en place (PBKDF2-SHA512), sans réseau.
docker run --rm --network none --user "${PUID}:${PGID}" \
  --mount "type=bind,source=$SECRETS_DIR,target=/secrets" "$MOSQUITTO_IMAGE" \
  mosquitto_passwd -U /secrets/passwd.tmp
mv "$tmp" "$SECRETS_DIR/passwd"
chmod 600 "$SECRETS_DIR/passwd"
echo "[gen-env] mosquitto/secrets/passwd régénéré ($(wc -l < "$SECRETS_DIR/passwd" | tr -d ' ') comptes, hachés)."
echo "[gen-env] Étape suivante : ./scripts/gen-certs.sh"
