#!/usr/bin/env bash
# Applique les migrations idempotentes (db/init/03-*.sql et suivants) sur une base DÉJÀ initialisée.
# Une base neuve les exécute d'elle-même ; ce script sert aux volumes existants (mise à jour).
#
# Usage : ./scripts/migrate-db.sh
set -euo pipefail
cd "$(dirname "$0")/.."

DOCKER_CMD="docker compose"
command -v docker &>/dev/null && docker compose version &>/dev/null || DOCKER_CMD="podman compose"

# Le superuser ne sort jamais du conteneur : le SQL est lu sur l'entrée standard.
for f in db/init/0[3-9]-*.sql; do
  [[ -f "$f" ]] || continue
  echo "[migrate-db] $f"
  $DOCKER_CMD exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$f"
done
echo "[migrate-db] terminé."
