from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import threading
import time
from typing import Any

import av


@dataclass
class VisionConfig:
    zone: str = "lab"
    source: str = "webcam-usb"
    confidence_threshold: float = 0.75
    intrusion_threshold: float = 0.85
    fps_limit: int = 5
    model_name: str = "yolov8n.pt"
    image_size: int = 320
    stream_url: str = "udp://@:5000?fifo_size=50000&overrun_nonfatal=1"


class BaseVisionDetector:
    mode = "CUSTOM"

    def detect(self, frame: Any) -> list[dict[str, Any]]:
        raise NotImplementedError


class MockVisionDetector(BaseVisionDetector):
    mode = "MOCK"

    def detect(self, frame: Any) -> list[dict[str, Any]]:
        if frame is None:
            return []

        return [{
            "class_name": "person",
            "confidence": 0.91,
            "bbox": [0, 0, 10, 10],
        }]


try:
    from ultralytics import YOLO  # type: ignore
except Exception:  # pragma: no cover
    YOLO = None


class YoloVisionDetector(BaseVisionDetector):
    mode = "REAL YOLO"

    def __init__(
        self,
        model_name: str = "yolov8n.pt",
        confidence_threshold: float = 0.5,
        image_size: int = 320,
    ) -> None:
        if YOLO is None:
            raise RuntimeError(
                "ultralytics is required for YoloVisionDetector."
            )

        self.model_name = model_name
        self.confidence_threshold = confidence_threshold
        self.image_size = image_size
        self._model = YOLO(model_name)

    def detect(self, frame: Any) -> list[dict[str, Any]]:
        results = self._model.predict(
            source=frame,
            imgsz=self.image_size,
            device="cpu",
            verbose=False,
        )

        detections: list[dict[str, Any]] = []

        for result in results:
            names = result.names

            for box in result.boxes:
                confidence = float(box.conf[0])

                if confidence < self.confidence_threshold:
                    continue

                cls_id = int(box.cls[0])
                class_name = names.get(cls_id, "unknown")
                xyxy = box.xyxy[0].tolist()

                detections.append({
                    "class_name": class_name,
                    "confidence": confidence,
                    "bbox": [float(v) for v in xyxy],
                })

        return detections


class LatestFrameStream:
    """
    UDP video reader that always keeps only the newest frame.

    Old frames are intentionally discarded to prevent latency accumulation.
    """

    def __init__(self, stream_url: str) -> None:
        self.stream_url = stream_url
        self._latest_frame: Any | None = None
        self._lock = threading.Lock()
        self._running = False
        self._thread: threading.Thread | None = None
        self._container: Any | None = None

    def start(self) -> None:
        if self._running:
            return

        self._running = True
        self._thread = threading.Thread(
            target=self._reader_loop,
            name="sentinel-video-reader",
            daemon=True,
        )
        self._thread.start()

    def _reader_loop(self) -> None:
        try:
            self._container = av.open(
                self.stream_url,
                options={
                    "fflags": "nobuffer",
                    "flags": "low_delay",
                    "probesize": "32",
                    "analyzeduration": "0",
                    "flush_packets": "1",
                },
            )

            for frame in self._container.decode(video=0):
                if not self._running:
                    break

                image = frame.to_ndarray(format="bgr24")

                with self._lock:
                    self._latest_frame = image

        except Exception as exc:
            if self._running:
                raise RuntimeError(
                    f"Vision stream failed: {exc}"
                ) from exc

        finally:
            if self._container is not None:
                self._container.close()
                self._container = None

    def get_latest_frame(self) -> Any | None:
        with self._lock:
            if self._latest_frame is None:
                return None

            return self._latest_frame.copy()

    def stop(self) -> None:
        self._running = False

        if self._thread is not None:
            self._thread.join(timeout=2)

        self._thread = None


class VisionEventGenerator:
    """
    Generate structured AI vision events.

    Production uses real YOLO unless a detector is explicitly injected
    for testing.
    """

    def __init__(
        self,
        config: VisionConfig | None = None,
        detector: BaseVisionDetector | None = None,
    ) -> None:
        self.config = config or VisionConfig()

        if detector is not None:
            self.detector = detector
        else:
            self.detector = YoloVisionDetector(
                model_name=self.config.model_name,
                confidence_threshold=self.config.confidence_threshold,
                image_size=self.config.image_size,
            )

        self._last_analysis_at: float | None = None
        self._last_inference_seconds: float = 0.0

    def detect(self, frame: Any) -> list[dict[str, Any]]:
        return self.detector.detect(frame)

    def analyze_frame(
        self,
        frame: Any,
        *,
        force: bool = False,
    ) -> dict[str, Any] | None:

        if frame is None:
            return None

        now = time.monotonic()

        if not force and self._last_analysis_at is not None:
            minimum_interval = 1.0 / max(1, self.config.fps_limit)

            if now - self._last_analysis_at < minimum_interval:
                return None

        self._last_analysis_at = now

        start = time.perf_counter()

        detections = self.detect(frame)

        inference_seconds = time.perf_counter() - start
        self._last_inference_seconds = inference_seconds

        if not detections:
            return None

        relevant = [
            detection
            for detection in detections
            if str(detection.get("class_name", "")).lower()
            in {"person", "human", "people"}
        ]

        if not relevant:
            return None

        best_match = max(
            relevant,
            key=lambda item: float(item.get("confidence", 0.0)),
        )

        confidence = float(best_match.get("confidence", 0.0))

        if confidence < self.config.confidence_threshold:
            return None

        event_type = "human_presence_detected"

        if confidence >= self.config.intrusion_threshold:
            event_type = "intrusion_detected"

        fps_estimate = (
            1.0 / inference_seconds
            if inference_seconds > 0
            else 0.0
        )

        return {
            "event_id": (
                f"vision-"
                f"{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S%f')}"
            ),
            "timestamp": (
                datetime.now(timezone.utc)
                .isoformat()
                .replace("+00:00", "Z")
            ),
            "type": event_type,
            "zone": self.config.zone,
            "source": self.config.source,
            "severity": (
                "high"
                if event_type == "intrusion_detected"
                else "medium"
            ),
            "confidence": round(confidence, 3),
            "model": getattr(
                self.detector,
                "model_name",
                self.detector.mode,
            ),
            "details": {
                "fps_limit": self.config.fps_limit,
                "image_size": self.config.image_size,
                "detector_mode": self.detector.mode,
                "class_name": best_match.get("class_name"),
                "bbox": best_match.get("bbox"),
                "detection_count": len(relevant),
                "inference_seconds": round(
                    inference_seconds,
                    6,
                ),
                "fps_estimate": round(
                    fps_estimate,
                    3,
                ),
            },
        }