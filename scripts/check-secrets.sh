#!/usr/bin/env bash
# Refuse de démarrer si un secret du .env est une ancienne valeur par défaut publiée dans l'historique Git.
# Compare des empreintes SHA-256 (scripts/leaked-secrets.sha256) : aucune valeur n'est affichée.
# Correctif : ./scripts/gen-env.sh --force, puis reflasher l'ESP32 (secrets.h) et relancer la stack.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -f .env ]] || exit 0
bad=0
while IFS='=' read -r key value; do
  [[ "$key" =~ ^[A-Z0-9_]+$ ]] || continue
  value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
  [[ -n "$value" ]] || continue
  h=$(printf '%s' "$value" | sha256sum | cut -d' ' -f1)
  if grep -qx "$h" scripts/leaked-secrets.sha256; then
    echo "[ERREUR] $key est une valeur par défaut publiée dans l'historique Git : à régénérer." >&2
    bad=1
  fi
done < .env
if (( bad )); then
  echo "Correctif : ./scripts/gen-env.sh --force, reflasher l'ESP32 (secrets.h), puis ./scripts/start.sh" >&2
  exit 1
fi
