#!/usr/bin/env bash
# À LANCER SUR LE RASPBERRY : diffuse la webcam USB en MJPEG 30 fps sur le câble Ethernet.
# Le PC se connecte à ce flux (TCP) : aucune règle entrante n'est nécessaire sur le PC.
#
#   sudo apt install ffmpeg v4l-utils          (une seule fois)
#   ./pi-camera-stream.sh                      # écoute sur le port 5001 (s'arrête avec la session SSH)
#   nohup ./pi-camera-stream.sh > /tmp/camera.log 2>&1 &   # reste actif après la fermeture de la session
#   ou, en permanence : scripts/pi-camera-stream.service (démarrage au boot)
#
# Le MJPEG de la webcam est copié tel quel (-c:v copy, flux « mjpeg » brut : une suite d'images JPEG ; le conteneur mpegts
# rangerait le MJPEG en « données privées », illisible côté PC) : presque aucun CPU sur le Pi. Si la webcam n'offre pas de MJPEG
# à 30 fps, voir « v4l2-ctl --list-formats-ext » et ajuster VIDEO_SIZE / FPS ; sinon, remplacer « -c:v copy » par
# « -c:v libx264 -preset ultrafast -tune zerolatency -g 30 ».
# Variables : DEVICE (/dev/video0), VIDEO_SIZE (640x480), FPS (30), PORT (5001)
# Pare-feu du Pi : ./scripts/harden-host.sh ouvre ce port depuis le câble (CAM_PORT, CAM_NET) ; sinon :
#   sudo ufw allow in on eth0 from 10.42.0.0/24 to any port 5001 proto tcp
set -uo pipefail
DEVICE="${DEVICE:-/dev/video0}"; VIDEO_SIZE="${VIDEO_SIZE:-640x480}"; FPS="${FPS:-30}"; PORT="${PORT:-5001}"

command -v ffmpeg >/dev/null || { echo "ffmpeg absent : sudo apt install ffmpeg" >&2; exit 1; }
[[ -e "$DEVICE" ]] || { echo "Caméra $DEVICE introuvable (ls /dev/video*)" >&2; exit 1; }
echo "[camera] $DEVICE ${VIDEO_SIZE}@${FPS} fps -> tcp://0.0.0.0:$PORT (Ctrl-C pour arrêter)"

# ffmpeg sert un seul client puis se termine à sa déconnexion : on le relance aussitôt pour accepter le suivant.
while true; do
  ffmpeg -hide_banner -loglevel warning -fflags nobuffer -flags low_delay \
    -f v4l2 -input_format mjpeg -framerate "$FPS" -video_size "$VIDEO_SIZE" -i "$DEVICE" \
    -c:v copy -f mjpeg -flush_packets 1 "tcp://0.0.0.0:${PORT}?listen=1"
  echo "[camera] client déconnecté ou erreur : relance dans 1 s"
  sleep 1
done
