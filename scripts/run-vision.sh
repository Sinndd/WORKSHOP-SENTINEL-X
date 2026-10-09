#!/usr/bin/env bash
# Lance le flux caméra + IA vers le tableau de bord (voir sentinel_x/ai/dashboard_stream.py). Prérequis : ./scripts/setup-vision.sh
# La stack doit tourner (l'API reçoit les images). Le jeton opérateur est lu dans .env (API_TOKEN).
# Exemples :
#   ./scripts/run-vision.sh --source tcp://10.42.0.2:5001      # caméra du Raspberry (cf. scripts/pi-camera-stream.sh)
#   ./scripts/run-vision.sh --source 0 --no-ai                 # webcam du PC, vidéo seule
# Variables : SENTINEL_API_URL (https://127.0.0.1:8443 par défaut ; 8443 = port du proxy en test podman, 443 sur le Pi)
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -x .venv-vision/bin/python ]] || { echo "Environnement absent : lancer ./scripts/setup-vision.sh" >&2; exit 1; }
set -a; . ./.env; set +a
export PYTHONPATH="$PWD${PYTHONPATH:+:$PYTHONPATH}"
exec .venv-vision/bin/python -m sentinel_x.ai.dashboard_stream "$@"
