"""Mesure le flux vidéo vu par un navigateur : se connecte à GET /api/v1/vision/stream et compte les images par seconde.
Usage : ./scripts/run-vision.sh est inutile ici ; lancer :  .venv-vision/bin/python scripts/measure-stream.py [secondes]
Lit API_TOKEN dans l'environnement (set -a; . ./.env). Affiche débit d'images, taille moyenne, débit réseau, gigue."""
import os, re, ssl, sys, time
import requests

secs = float(sys.argv[1]) if len(sys.argv) > 1 else 10
url = os.environ.get("SENTINEL_API_URL", "https://127.0.0.1:8443").rstrip("/") + "/api/v1/vision/stream"
ca = "mosquitto/certs/ca.crt" if os.path.exists("mosquitto/certs/ca.crt") else True
r = requests.get(url, headers={"Authorization": f"Bearer {os.environ['API_TOKEN']}"}, stream=True, verify=ca, timeout=10)
print("HTTP", r.status_code, r.headers.get("content-type"))
buf = b""; frames = []; total = 0; t0 = time.monotonic()
for chunk in r.iter_content(chunk_size=65536):
    buf += chunk; total += len(chunk)
    while True:
        h = buf.find(b"\r\n\r\n")
        if h < 0: break
        m = re.search(rb"Content-Length:\s*(\d+)", buf[:h], re.I)
        if not m: buf = buf[h + 4:]; continue
        n = int(m.group(1)); s = h + 4
        if len(buf) < s + n: break
        frames.append(time.monotonic()); buf = buf[s + n:]
    if time.monotonic() - t0 >= secs: break
dt = time.monotonic() - t0
gaps = [(b - a) * 1000 for a, b in zip(frames, frames[1:])]
print(f"{len(frames)} images en {dt:.1f} s = {len(frames)/dt:.1f} images/s ; {total/dt/1e6:.2f} Mo/s ; taille moyenne {total/max(1,len(frames))/1024:.0f} Ko")
if gaps: print(f"intervalle entre images : moyen {sum(gaps)/len(gaps):.1f} ms, max {max(gaps):.0f} ms")
