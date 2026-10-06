import av
import cv2
import threading
import time
from ultralytics import YOLO

latest_frame = None
lock = threading.Lock()
running = True

def reader():
    global latest_frame, running

    container = av.open(
        "udp://@:5000?fifo_size=50000&overrun_nonfatal=1",
        options={
            "fflags": "nobuffer",
            "flags": "low_delay",
            "probesize": "32",
            "analyzeduration": "0",
            "flush_packets": "1",
        },
    )

    for frame in container.decode(video=0):
        img = frame.to_ndarray(format="bgr24")

        with lock:
            latest_frame = img

        if not running:
            break

    container.close()


thread = threading.Thread(target=reader, daemon=True)
thread.start()

model = YOLO("yolov8n.pt")

while True:
    with lock:
        if latest_frame is None:
            continue
        frame = latest_frame.copy()

    start = time.perf_counter()

    results = model(
        frame,
        verbose=False,
        classes=[0],  # uniquement personne
    )

    inference_ms = (time.perf_counter() - start) * 1000

    annotated = results[0].plot()

    cv2.putText(
        annotated,
        f"YOLO: {inference_ms:.0f} ms",
        (10, 25),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.7,
        (0, 255, 0),
        2,
    )

    cv2.imshow("SENTINEL-X YOLO - LIVE", annotated)

    if cv2.waitKey(1) & 0xFF == ord("q"):
        running = False
        break

cv2.destroyAllWindows()
