"""Pont caméra -> IA -> tableau de bord : vidéo à 30 images/s avec les résultats de l'IA superposés.

  caméra (Raspberry en TCP, ou webcam locale)  ->  lecture continue (30 fps)  ->  JPEG  ->  POST /api/v1/vision/snapshot
                                                          \\-> thread IA (YOLO + visages, à son rythme) : cadres et noms

La vidéo n'attend jamais l'IA : chaque image part immédiatement avec les derniers cadres calculés (un peu en retard sur
l'image, de l'ordre de la durée d'une inférence). L'API relaie les images en direct (GET /api/v1/vision/stream).

Usage (depuis la racine du dépôt, via scripts/run-vision.sh) :
  python -m sentinel_x.ai.dashboard_stream --source tcp://10.42.0.2:5001      # caméra du Raspberry
  python -m sentinel_x.ai.dashboard_stream --source 0                         # webcam du PC (essais)
"""
from __future__ import annotations

import argparse
import os
import queue
import sys
import threading
import time
from pathlib import Path

import cv2
import numpy as np
import requests


def log(msg: str) -> None:
    print(f"[vision {time.strftime('%H:%M:%S')}] {msg}", flush=True)


class CameraSource:
    """Lit la caméra en continu dans un thread (reconnexion automatique) et expose la dernière image."""

    def __init__(self, source: str, width: int, height: int, fps: int, fmt: str | None = "mjpeg") -> None:
        self.source, self.width, self.height, self.fps, self.fmt = source, width, height, fps, fmt
        self._cond = threading.Condition()
        self._frame: np.ndarray | None = None
        self._seq = 0
        self._running = False
        self._thread: threading.Thread | None = None
        self.read_fps = 0.0

    def start(self) -> None:
        self._running = True
        self._thread = threading.Thread(target=self._run, name="camera", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._running = False

    def _publish(self, frame: np.ndarray) -> None:
        with self._cond:
            self._frame = frame
            self._seq += 1
            self._cond.notify_all()

    def latest(self) -> tuple[np.ndarray | None, int]:
        with self._cond:
            return self._frame, self._seq

    def wait_new(self, last_seq: int, timeout: float) -> tuple[np.ndarray | None, int]:
        with self._cond:
            self._cond.wait_for(lambda: self._seq != last_seq or not self._running, timeout)
            return self._frame, self._seq

    def _run(self) -> None:
        while self._running:
            try:
                (self._run_test if self.source == "test" else self._run_webcam if self.source.isdigit() else self._run_stream)()
            except Exception as exc:                                  # caméra absente, flux coupé : on réessaie
                log(f"caméra : {exc} — nouvelle tentative dans 2 s")
            time.sleep(2)

    def _count(self, t0: list[float], n: list[int]) -> None:
        n[0] += 1
        if time.monotonic() - t0[0] >= 2:
            self.read_fps = n[0] / (time.monotonic() - t0[0])
            t0[0], n[0] = time.monotonic(), 0

    def _run_test(self) -> None:
        """Source synthétique : image animée à la cadence demandée (essais du circuit sans caméra)."""
        log(f"source de test : {self.width}x{self.height} à {self.fps} fps")
        period, nxt, k = 1.0 / self.fps, time.monotonic(), 0
        t0, n = [time.monotonic()], [0]
        while self._running:
            frame = np.zeros((self.height, self.width, 3), np.uint8)
            frame[:] = (40 + (k % 120), 30, 60)
            x = int((np.sin(k / 15.0) + 1) / 2 * (self.width - 120))
            cv2.rectangle(frame, (x, 150), (x + 120, 330), (0, 220, 120), -1)
            cv2.putText(frame, f"TEST {k:06d}", (20, 60), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (255, 255, 255), 2)
            self._publish(frame)
            self._count(t0, n)
            k += 1
            nxt += period
            time.sleep(max(0.0, nxt - time.monotonic()))

    def _run_webcam(self) -> None:
        cap = cv2.VideoCapture(int(self.source), cv2.CAP_V4L2)
        cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))   # MJPEG : 30 fps à 640x480 sans effort
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
        cap.set(cv2.CAP_PROP_FPS, self.fps)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        if not cap.isOpened():
            raise RuntimeError(f"webcam {self.source} introuvable")
        log(f"webcam {self.source} ouverte : {int(cap.get(3))}x{int(cap.get(4))} à {cap.get(cv2.CAP_PROP_FPS):.0f} fps")
        t0, n = [time.monotonic()], [0]
        try:
            while self._running:
                ok, frame = cap.read()
                if not ok:
                    raise RuntimeError("lecture webcam interrompue")
                self._publish(frame)
                self._count(t0, n)
        finally:
            cap.release()

    def _run_stream(self) -> None:
        import av
        # Analyse un peu plus large que pour un flux continu : le MJPEG dans un conteneur mpegts n'annonce ses dimensions
        # qu'après quelques images ; le coût n'est payé qu'au démarrage de la connexion.
        container = av.open(self.source, format=self.fmt, options={"fflags": "nobuffer", "flags": "low_delay", "probesize": "2000000",
                                                  "analyzeduration": "1500000", "rw_timeout": "8000000"}, timeout=10)
        if not container.streams.video:
            container.close()
            raise RuntimeError("aucun flux vidéo dans la connexion (la caméra du Pi démarre-t-elle ?)")
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        log(f"flux {self.source} ouvert : {stream.codec_context.width}x{stream.codec_context.height}")
        t0, n = [time.monotonic()], [0]
        try:
            for packet_frame in container.decode(stream):
                if not self._running:
                    break
                self._publish(packet_frame.to_ndarray(format="bgr24"))
                self._count(t0, n)
        finally:
            container.close()


class AiWorker(threading.Thread):
    """Exécute le pipeline IA sur la dernière image, indépendamment de la cadence vidéo."""

    def __init__(self, source: CameraSource, max_fps: float) -> None:
        super().__init__(name="ia", daemon=True)
        self.source, self.max_fps = source, max_fps
        self.result: dict | None = None
        self.result_at = 0.0
        self.fps = 0.0
        self.loading = True
        self.pipeline = None          # renseigné une fois les modèles chargés (utilisé par FaceSync)

    def run(self) -> None:
        from sentinel_x.ai.authorized_vision import AuthorizedVisionPipeline   # import lourd (torch) : hors du chemin vidéo
        import torch
        # L'IA ne doit pas affamer la vidéo : par défaut torch utiliserait tous les cœurs du PC.
        torch.set_num_threads(int(os.environ.get("VISION_AI_THREADS", "3")))
        cv2.setNumThreads(2)
        log("IA : chargement des modèles (YOLO, visages)...")
        pipeline = AuthorizedVisionPipeline(image_size=320, face_tolerance=0.55, window_size=5, min_confirmations=3)
        self.pipeline = pipeline
        self.loading = False
        log("IA : prête")
        last_seq, t0, n = 0, time.monotonic(), 0
        while True:
            frame, seq = self.source.wait_new(last_seq, 1.0)
            if frame is None or seq == last_seq:
                continue
            last_seq = seq
            started = time.monotonic()
            try:
                result = pipeline.process_frame(frame)
            except Exception as exc:
                log(f"IA : erreur sur une image ({exc})")
                continue
            self.result, self.result_at = result, time.monotonic()
            n += 1
            if time.monotonic() - t0 >= 2:
                self.fps, t0, n = n / (time.monotonic() - t0), time.monotonic(), 0
            spare = 1.0 / self.max_fps - (time.monotonic() - started)    # plafond de cadence : laisse du CPU à la vidéo
            if spare > 0:
                time.sleep(spare)


class FaceSync(threading.Thread):
    """Visages autorisés, gérés depuis l'onglet « Visages » du tableau de bord (API /api/v1/faces).

      - recharge la base de visages dans l'IA dès qu'elle change (empreinte /faces/version, sondée toutes les 5 s) ;
      - exécute les demandes d'enrôlement : « caméra » (échantillons pris sur le flux en direct) ou « photo » (image envoyée).
    Le modèle de reconnaissance n'existe que sur cette machine : l'API ne reçoit que des vecteurs de 128 nombres."""

    def __init__(self, ai: AiWorker, camera: CameraSource, api: str, token: str, verify: str | bool) -> None:
        super().__init__(name="visages", daemon=True)
        self.ai, self.camera, self.base, self.verify = ai, camera, api.rstrip("/") + "/api/v1/faces", verify
        self.http = requests.Session()
        self.http.headers.update({"Authorization": f"Bearer {token}"})
        self.version: str | None = None
        self.errors = 0

    def _call(self, method: str, path: str, **kw):
        r = self.http.request(method, self.base + path, timeout=5, verify=self.verify, **kw)
        return r

    def run(self) -> None:
        while self.ai.pipeline is None:
            time.sleep(1)
        matcher = self.ai.pipeline.face_matcher
        log("visages : synchronisation avec l'API activée")
        last_sync = 0.0
        while True:
            try:
                jobs = self._call("GET", "/enrollments")
                jobs.raise_for_status()
                for job in jobs.json():
                    self._enroll(matcher, job)
                    last_sync = 0.0                                    # recharge la base tout de suite après
                if time.monotonic() - last_sync >= 5:
                    last_sync = time.monotonic()
                    self._sync(matcher)
                self.errors = 0
            except Exception as exc:
                self.errors += 1
                if self.errors in (1, 10) or self.errors % 60 == 0:
                    log(f"visages : API injoignable ou refus ({exc})")
            time.sleep(1)

    def _sync(self, matcher) -> None:
        v = self._call("GET", "/version")
        v.raise_for_status()
        version = v.json()["version"]
        if version == self.version:
            return
        r = self._call("GET", "/embeddings")
        r.raise_for_status()
        matcher.set_database(r.json()["members"])
        self.version = version

    def _post(self, job_id: int, path: str, payload: dict) -> dict | None:
        r = self._call("POST", f"/enrollments/{job_id}/{path}", json=payload)
        if r.status_code == 409:                                       # annulé, expiré ou terminé côté tableau de bord
            return None
        r.raise_for_status()
        return r.json()

    def _enroll(self, matcher, job: dict) -> None:
        log(f"enrôlement de « {job['name']} » ({job['mode']}, {job['samples_target']} échantillon(s))")
        if job["mode"] == "photo":
            self._enroll_photo(matcher, job)
        else:
            self._enroll_camera(matcher, job)

    def _enroll_photo(self, matcher, job: dict) -> None:
        import base64
        img = cv2.imdecode(np.frombuffer(base64.b64decode(job["photo_b64"] or ""), np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            self._post(job["id"], "fail", {"error": "image illisible"})
            return
        h, w = img.shape[:2]
        if max(h, w) > 1600:                                           # photo d'appareil : on réduit (détection plus rapide)
            k = 1600 / max(h, w)
            img = cv2.resize(img, (int(w * k), int(h * k)), interpolation=cv2.INTER_AREA)
        faces = matcher.encode_faces(img, upsample=1)
        if len(faces) != 1:
            msg = "aucun visage détecté sur la photo" if not faces else f"{len(faces)} visages sur la photo : une seule personne attendue"
            self._post(job["id"], "fail", {"error": msg})
            return
        self._post(job["id"], "embeddings", {"embeddings": [faces[0].tolist()]})

    def _enroll_camera(self, matcher, job: dict) -> None:
        deadline = time.monotonic() + 85
        last_seq, last_sample, last_hint = 0, 0.0, 0.0
        while time.monotonic() < deadline:
            frame, seq = self.camera.wait_new(last_seq, 1.0)
            if frame is None or seq == last_seq:
                continue
            last_seq = seq
            now = time.monotonic()
            if now - last_sample < 0.8:                                # échantillons espacés : le visage a le temps de bouger
                continue
            faces = matcher.encode_faces(frame, upsample=0)
            if len(faces) != 1:
                if now - last_hint > 2:
                    last_hint = now
                    hint = "Aucun visage devant la caméra" if not faces else "Plusieurs visages : une seule personne devant la caméra"
                    if self._post(job["id"], "progress", {"error": hint}) is None:
                        return
                continue
            last_sample = now
            res = self._post(job["id"], "embeddings", {"embeddings": [faces[0].tolist()]})
            if res is None or res["status"] != "PENDING":
                return
            log(f"  échantillon {res['samples_done']}/{res['samples_target']}")
        self._post(job["id"], "fail", {"error": "délai écoulé : visage non vu assez longtemps"})


class Sender:
    """Envoie les JPEG à l'API par plusieurs connexions persistantes en parallèle (chaque requête attend sa réponse : une seule
    connexion plafonne à environ 1/latence images/s). Chaque image porte un numéro de séquence : l'API ignore les retardataires."""

    def __init__(self, url: str, token: str, verify: str | bool, workers: int = 3) -> None:
        self.url, self.verify = url, verify
        self.q: queue.Queue[tuple[int, bytes]] = queue.Queue(maxsize=workers)
        self.seq = 0
        self.sent = 0
        self.sent_fps = 0.0
        self.errors = 0
        self._lock = threading.Lock()
        self._token = token
        self._workers = [threading.Thread(target=self._run, name=f"envoi{i}", daemon=True) for i in range(workers)]

    def start(self) -> None:
        for w in self._workers:
            w.start()
        threading.Thread(target=self._stats, name="envoi-stats", daemon=True).start()

    def push(self, jpeg: bytes) -> None:
        with self._lock:
            self.seq = max(self.seq + 1, time.time_ns() // 1000)    # horloge en microsecondes : ne revient jamais en arrière, même après un redémarrage
            item = (self.seq, jpeg)
        while True:
            try:
                self.q.put_nowait(item)
                return
            except queue.Full:
                try:
                    self.q.get_nowait()                              # jamais de retard cumulé : on jette la plus ancienne
                except queue.Empty:
                    pass

    def _stats(self) -> None:
        last, t0 = 0, time.monotonic()
        while True:
            time.sleep(2)
            now = time.monotonic()
            self.sent_fps, last, t0 = (self.sent - last) / (now - t0), self.sent, now

    def _run(self) -> None:
        session = requests.Session()
        session.headers.update({"Authorization": f"Bearer {self._token}", "Content-Type": "image/jpeg"})
        while True:
            seq, jpeg = self.q.get()
            try:
                r = session.post(self.url, data=jpeg, headers={"X-Frame-Seq": str(seq)}, timeout=3, verify=self.verify)
                if r.status_code != 200:
                    raise RuntimeError(f"HTTP {r.status_code}")
                self.sent += 1
            except Exception as exc:
                self.errors += 1
                if self.errors in (1, 10) or self.errors % 100 == 0:
                    log(f"envoi vers l'API : {exc}")
                time.sleep(0.5)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", default=os.environ.get("CAMERA_SOURCE", "0"),
                    help="numéro de webcam locale (0), URL du flux du Raspberry (tcp://IP:5001) ou « test » (image synthétique)")
    ap.add_argument("--format", default="mjpeg", help="format du flux réseau : mjpeg (scripts/pi-camera-stream.sh) ou auto (mpegts, ex. flux UDP de l'ancien montage)")
    ap.add_argument("--api", default=os.environ.get("SENTINEL_API_URL", "https://127.0.0.1:8443"))
    ap.add_argument("--cafile", default=str(Path("mosquitto/certs/ca.crt")) if Path("mosquitto/certs/ca.crt").exists() else None)
    ap.add_argument("--token", default=os.environ.get("API_TOKEN", ""), help="jeton opérateur (variable API_TOKEN du .env)")
    ap.add_argument("--fps", type=int, default=30, help="cadence maximale d'envoi vers le tableau de bord")
    ap.add_argument("--ai-fps", type=float, default=5.0, help="cadence maximale de l'IA")
    ap.add_argument("--quality", type=int, default=75, help="qualité JPEG (1-100)")
    ap.add_argument("--width", type=int, default=640)
    ap.add_argument("--height", type=int, default=480)
    ap.add_argument("--no-ai", action="store_true", help="vidéo seule, sans YOLO ni visages")
    ap.add_argument("--no-hud", action="store_true", help="n'affiche pas le bandeau de débits sur l'image")
    args = ap.parse_args()
    if not args.token:
        print("Jeton absent : définir API_TOKEN (scripts/run-vision.sh le lit dans .env).", file=sys.stderr)
        return 2

    camera = CameraSource(args.source, args.width, args.height, args.fps, None if args.format == "auto" else args.format)
    camera.start()
    ai = None
    if not args.no_ai:
        ai = AiWorker(camera, args.ai_fps)
        ai.start()
    if ai is not None:
        FaceSync(ai, camera, args.api, args.token, args.cafile or True).start()
    sender = Sender(args.api.rstrip("/") + "/api/v1/vision/snapshot", args.token, args.cafile or True)
    sender.start()
    from sentinel_x.ai.overlay import draw_hud, draw_persons

    log(f"flux vers {args.api} (cible {args.fps} fps, JPEG q{args.quality}) ; source : {args.source}")
    encode_params = [cv2.IMWRITE_JPEG_QUALITY, args.quality]
    min_interval = 1.0 / args.fps
    last_seq, last_sent, last_report = 0, 0.0, time.monotonic()
    try:
        while True:
            frame, seq = camera.wait_new(last_seq, 1.0)
            if frame is None or seq == last_seq:
                continue
            last_seq = seq
            now = time.monotonic()
            if now - last_sent < min_interval * 0.9:               # caméra plus rapide que la cible : on saute des images
                continue
            last_sent = now
            display = frame.copy()                                   # l'IA lit `frame` en même temps : ne jamais dessiner dessus
            people = 0
            if ai is not None and ai.result is not None and now - ai.result_at < 1.5:
                people = draw_persons(display, ai.result)
            if not args.no_hud:
                bits = [f"cam {camera.read_fps:.0f} fps", f"envoi {sender.sent_fps:.0f} fps"]
                if ai is not None:
                    bits.append("IA chargement" if ai.loading else f"IA {ai.fps:.1f} fps | {people} pers.")
                draw_hud(display, bits)
            ok, buf = cv2.imencode(".jpg", display, encode_params)
            if ok:
                sender.push(buf.tobytes())
            if now - last_report >= 5:
                last_report = now
                log(f"caméra {camera.read_fps:.1f} fps | envoyées {sender.sent_fps:.1f} fps | "
                    f"IA {'-' if ai is None else f'{ai.fps:.1f}'} fps | erreurs d'envoi {sender.errors}")
    except KeyboardInterrupt:
        pass
    finally:
        camera.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
