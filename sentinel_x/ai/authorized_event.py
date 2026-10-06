from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sentinel_x.ai.authorized_vision import AuthorizedVisionPipeline


class AuthorizedVisionEventGenerator:
    """
    Converts authorized-vision results into SENTINEL-X AI events.

    No API/backend dependency.
    """

    def __init__(
        self,
        pipeline: AuthorizedVisionPipeline | None = None,
    ) -> None:
        self.pipeline = pipeline or AuthorizedVisionPipeline()

    def analyze_frame(self, frame: Any) -> dict[str, Any] | None:
        result = self.pipeline.process_frame(frame)

        if result is None:
            return None

        status = result.get("status")

        # No person -> no security event.
        if status == "no_person":
            return None

        detection = result.get("detection") or {}
        confidence = float(
            detection.get("confidence", 0.0)
        )

        if status == "authorized_person":
            event_type = "authorized_person_detected"
            severity = "low"

        elif status == "unknown_person":
            event_type = "unknown_person_detected"
            severity = "high"

        else:
            event_type = "human_presence_detected"
            severity = "medium"

        now = datetime.now(timezone.utc)

        return {
            "event_id": (
                f"vision-{now.strftime('%Y%m%d%H%M%S%f')}"
            ),
            "timestamp": (
                now.isoformat().replace("+00:00", "Z")
            ),
            "type": event_type,
            "zone": "lab",
            "source": "webcam-usb",
            "severity": severity,
            "confidence": round(confidence, 3),
            "model": "yolov8n+face-matcher",
            "details": {
                "status": status,
                "member": result.get("member"),
                "face_distance": result.get("distance"),
                "stable": result.get("stable"),
                "confirmations": result.get(
                    "confirmations"
                ),
                "history_size": result.get(
                    "history_size"
                ),
                "class_name": detection.get(
                    "class_name"
                ),
                "bbox": detection.get("bbox"),
                "detection_count": result.get(
                    "detection_count"
                ),
            },
        }
