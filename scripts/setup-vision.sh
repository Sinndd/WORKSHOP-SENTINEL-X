#!/usr/bin/env bash
# Installe la chaîne vision/IA du PC (YOLO + reconnaissance de visages + envoi vers le tableau de bord) dans un
# environnement isolé .venv-vision (Python 3.12 via uv). Rien n'est installé en dehors du dossier du projet.
# Taille : environ 4 Go (torch CPU, ultralytics, OpenCV, PyAV, dlib précompilé). Nécessite Internet.
# Usage : ./scripts/setup-vision.sh
set -euo pipefail
cd "$(dirname "$0")/.."
command -v uv >/dev/null || { echo "uv est requis (https://docs.astral.sh/uv/)." >&2; exit 1; }

VENV=.venv-vision
[[ -d $VENV ]] || uv venv "$VENV" --python 3.12
PY="$VENV/bin/python"

echo "[setup-vision] torch (CPU) ..."
uv pip install --python "$PY" torch torchvision --index-url https://download.pytorch.org/whl/cpu \
  --extra-index-url https://pypi.org/simple --index-strategy unsafe-best-match
echo "[setup-vision] YOLO, OpenCV, PyAV, visages ..."
# setuptools<81 : face_recognition_models utilise encore pkg_resources.
uv pip install --python "$PY" ultralytics opencv-python-headless av numpy requests scikit-learn "setuptools<81" dlib-bin face_recognition_models
"$PY" - <<'PY'
import av, cv2, dlib, face_recognition_models, torch, ultralytics
print("[setup-vision] OK : opencv", cv2.__version__, "| torch", torch.__version__, "| dlib", dlib.__version__, "| ultralytics", ultralytics.__version__)
PY
