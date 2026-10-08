import time
from collections import Counter, deque

from sentinel_x.ai.face_matcher import FaceMatcher
from sentinel_x.ai.vision import LatestFrameStream


STREAM_URL = "udp://@:5000?fifo_size=50000&overrun_nonfatal=1"

WINDOW_SIZE = 5
MIN_CONFIRMATIONS = 3

stream = LatestFrameStream(STREAM_URL)
matcher = FaceMatcher("data/authorized_faces.json")   # base JSON locale (voir authorized_faces.py)

history = deque(maxlen=WINDOW_SIZE)
last_status = None

stream.start()

print("🎥 Webcam UDP démarrée")
print("🧠 Reconnaissance faciale active")
print("🛡️ Stabilisation temporelle : 3/5")
print("CTRL+C pour arrêter")

try:
    while True:
        frame = stream.get_latest_frame()

        if frame is None:
            time.sleep(0.01)
            continue

        results = matcher.analyze_frame(frame)

        if not results:
            time.sleep(0.05)
            continue

        result = results[0]

        if result["authorized"]:
            history.append(result["member"])
        else:
            history.append("INCONNU")

        counts = Counter(history)

        candidate, count = counts.most_common(1)[0]

        if count >= MIN_CONFIRMATIONS:
            status = candidate
        else:
            status = "EN_ATTENTE"

        # Affichage uniquement quand le statut change
        if status != last_status:
            if status == "EN_ATTENTE":
                print(
                    f"⏳ Stabilisation... "
                    f"{candidate} ({count}/{WINDOW_SIZE})"
                )
            elif status == "INCONNU":
                print("🚨 INCONNU confirmé")
            else:
                print(f"✅ AUTORISÉ | {status}")

            last_status = status

        time.sleep(0.05)

except KeyboardInterrupt:
    print("\n🛑 Arrêt")

finally:
    stream.stop()
