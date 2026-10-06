import time
import cv2

from sentinel_x.ai.authorized_vision import AuthorizedVisionPipeline
from sentinel_x.ai.vision import LatestFrameStream, VisionConfig


GREEN = (0, 255, 0)
RED = (0, 0, 255)
ORANGE = (0, 165, 255)
WHITE = (255, 255, 255)


config = VisionConfig(
    stream_url="udp://@:5000?fifo_size=50000&overrun_nonfatal=1",
    image_size=320,
    fps_limit=5,
)

stream = LatestFrameStream(
    config.stream_url
)

pipeline = AuthorizedVisionPipeline(
    image_size=320,
    face_tolerance=0.55,
    window_size=5,
    min_confirmations=3,
)

stream.start()

try:
    while True:
        frame = stream.get_latest_frame()

        if frame is None:
            time.sleep(0.01)
            continue

        result = pipeline.process_frame(frame)

        display = frame.copy()

        if result:
            persons = result.get(
                "persons",
                [],
            )

            for person in persons:
                status = person.get("status")
                member = person.get("member")
                distance = person.get("distance")

                detection = (
                    person.get("detection")
                    or {}
                )

                bbox = detection.get("bbox")

                if not bbox or len(bbox) != 4:
                    continue

                x1, y1, x2, y2 = map(
                    int,
                    bbox,
                )

                # -----------------------------
                # Couleur + label
                # -----------------------------

                if status == "authorized_person":
                    color = GREEN
                    label = (
                        f"AUTORISE : {member}"
                    )

                elif status == "unknown_person":
                    color = RED
                    label = "INCONNU"

                elif status == "unidentified_person":
                    color = ORANGE
                    label = "NON IDENTIFIABLE"

                else:
                    color = WHITE
                    label = "ANALYSE..."

                # -----------------------------
                # Bounding box
                # -----------------------------

                cv2.rectangle(
                    display,
                    (x1, y1),
                    (x2, y2),
                    color,
                    3,
                )

                cv2.putText(
                    display,
                    label,
                    (
                        x1,
                        max(30, y1 - 10),
                    ),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.7,
                    color,
                    2,
                )

                # -----------------------------
                # Distance visage
                # -----------------------------

                if distance is not None:
                    cv2.putText(
                        display,
                        f"FACE: {distance:.3f}",
                        (
                            x1,
                            min(
                                display.shape[0] - 10,
                                y2 + 25,
                            ),
                        ),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.55,
                        color,
                        2,
                    )

                # -----------------------------
                # Confiance YOLO
                # -----------------------------

                confidence = detection.get(
                    "confidence"
                )

                if confidence is not None:
                    cv2.putText(
                        display,
                        f"YOLO: {confidence:.2f}",
                        (
                            x1,
                            min(
                                display.shape[0] - 10,
                                y2 + 47,
                            ),
                        ),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.5,
                        WHITE,
                        2,
                    )

            # Compteur global
            count = len(persons)

            cv2.putText(
                display,
                f"PERSONNES: {count}",
                (20, 35),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.7,
                WHITE,
                2,
            )

        cv2.imshow(
            "SENTINEL-X | AI VISION",
            display,
        )

        key = cv2.waitKey(1) & 0xFF

        if key in (ord("q"), 27):
            break

finally:
    stream.stop()
    cv2.destroyAllWindows()