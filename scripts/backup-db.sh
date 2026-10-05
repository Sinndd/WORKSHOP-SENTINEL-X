#!/usr/bin/env bash
# Sauvegarde / restauration PostgreSQL (pg_dump format custom, compressé).
#
#   ./scripts/backup-db.sh                      # sauvegarde dans $BACKUP_DIR (défaut ./backups), garde $KEEP fichiers
#   ./scripts/backup-db.sh --restore FICHIER    # restauration (confirmation demandée, ingestor/api arrêtés pendant)
#
# Conseil carte SD : BACKUP_DIR=/media/usb/sentinel ./scripts/backup-db.sh (clé USB), puis copie hors du Pi.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP="${KEEP:-7}"
umask 077   # les dumps contiennent toutes les données

if [[ "${1:-}" == "--restore" ]]; then
  file="${2:?usage: $0 --restore FICHIER.dump}"
  [[ -f "$file" ]] || { echo "Fichier introuvable : $file" >&2; exit 1; }
  echo "Restauration de $file dans la base '$POSTGRES_DB' : les données actuelles seront REMPLACÉES."
  read -r -p "Taper 'oui' pour continuer : " answer
  [[ "$answer" == "oui" ]] || { echo "Abandon."; exit 1; }
  docker compose stop ingestor api
  docker compose exec -T postgres pg_restore -U postgres -d "$POSTGRES_DB" --clean --if-exists --single-transaction < "$file"
  docker compose start ingestor api
  echo "Restauration terminée."
  exit 0
fi

mkdir -p "$BACKUP_DIR"
out="$BACKUP_DIR/${POSTGRES_DB}-$(date +%Y%m%d-%H%M%S).dump"
docker compose exec -T postgres pg_dump -U postgres -d "$POSTGRES_DB" -Fc -Z 6 > "$out.part"
# Vérifie que l'archive est lisible avant de la valider.
docker compose exec -T postgres pg_restore -l < "$out.part" > /dev/null
mv "$out.part" "$out"
echo "Sauvegarde : $out ($(du -h "$out" | cut -f1))"

# Rotation : on garde les $KEEP plus récentes.
ls -1t "$BACKUP_DIR/${POSTGRES_DB}"-*.dump 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
  rm -f -- "$old" && echo "Supprimée (rotation) : $old"
done
