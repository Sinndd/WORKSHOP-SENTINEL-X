from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from numbers import Real
from typing import Any, Sequence

import numpy as np
from sklearn.ensemble import IsolationForest


@dataclass
class AnomalyConfig:
    zone: str = "lab"
    sensor_name: str = "generic"
    threshold: float = 0.7
    severity: str = "high"
    contamination: float = 0.1
    min_train_samples: int = 8


class SensorAnomalyDetector:
    """ML-first anomaly detector for sensor time-series using IsolationForest."""

    def __init__(self, config: AnomalyConfig | None = None) -> None:
        self.config = config or AnomalyConfig()
        self._model: IsolationForest | None = None
        self._training_samples = 0

    def _feature_vector(self, values: Sequence[float]) -> list[float]:
        arr = np.asarray(values, dtype=float)
        if arr.size == 0:
            raise ValueError("values must contain at least one observation")

        latest = float(arr[-1])
        mean = float(np.mean(arr))
        std = float(np.std(arr, ddof=0))
        minimum = float(np.min(arr))
        maximum = float(np.max(arr))
        variation = float(latest - mean)
        relative_variation = float(variation / max(abs(mean), 1e-6))
        trend = float(arr[-1] - arr[0]) if arr.size > 1 else 0.0

        return [latest, mean, std, minimum, maximum, variation, relative_variation, trend]

    def train(self, history: Sequence[Sequence[float]] | Sequence[float]) -> IsolationForest:
        if len(history) == 0:
            raise ValueError("insufficient_data")

        first = history[0]
        if isinstance(first, Real):
            series = np.asarray(history, dtype=float)
            window_size = min(5, series.size)
            if window_size < 2:
                raise ValueError("insufficient_data")
            training_vectors = [
                self._feature_vector(series[index - window_size:index].tolist())
                for index in range(window_size, series.size + 1)
            ]
        else:
            trajectories = [list(values) for values in history if len(values) >= 2]
            training_vectors = [self._feature_vector(values) for values in trajectories]

        if len(training_vectors) < self.config.min_train_samples:
            raise ValueError("insufficient_data")

        features = np.asarray(training_vectors, dtype=float)
        model = IsolationForest(contamination=self.config.contamination, random_state=42)
        model.fit(features)
        self._model = model
        self._training_samples = len(training_vectors)
        return model

    def predict(self, values: Sequence[float]) -> dict[str, Any]:
        if self._model is None:
            raise ValueError("Model is not trained yet. Call train(...) before predict(...).")
        feature = np.asarray([self._feature_vector(values)], dtype=float)
        prediction = int(self._model.predict(feature)[0])
        raw_score = float(self._model.score_samples(feature)[0])
        confidence = min(1.0, max(0.0, abs(raw_score) / (abs(raw_score) + 1.0)))
        return {
            "prediction": prediction,
            "score": round(float(raw_score), 6),
            "confidence": round(confidence, 3),
        }

    def predict_label(self, values: Sequence[float]) -> int:
        return int(self.predict(values)["prediction"])

    def score(self, values: Sequence[float]) -> float:
        if self._model is None:
            raise ValueError("Model is not trained yet. Call train(...) before score(...).")
        feature = np.asarray([self._feature_vector(values)], dtype=float)
        raw_score = float(self._model.score_samples(feature)[0])
        return raw_score

    def detect(self, values: Sequence[float], *, history: Sequence[Sequence[float]] | Sequence[float] | None = None) -> dict[str, Any] | None:
        if not values:
            return {"status": "insufficient_data", "message": "Provide sensor values before detection."}

        if history is not None and len(history) > 0 and self._model is None:
            try:
                self.train(history)
            except ValueError:
                return {"status": "insufficient_data", "message": "Not enough historical data to train the anomaly model."}

        if self._model is None:
            return {"status": "insufficient_data", "message": "Model has not been trained; provide history before detection."}

        prediction_result = self.predict(values)
        prediction = int(prediction_result["prediction"])
        raw_score = float(prediction_result["score"])
        confidence = float(prediction_result["confidence"])
        if prediction == 1:
            return {"status": "normal", "score": raw_score, "confidence": confidence, "type": "normal"}

        latest = float(np.asarray(values, dtype=float)[-1])
        event = {
            "event_id": f"anomaly-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S%f')}",
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "type": "ml_anomaly_detected",
            "zone": self.config.zone,
            "sensor": self.config.sensor_name,
            "value": latest,
            "severity": self.config.severity,
            "confidence": confidence,
            "model": "IsolationForest",
            "details": {
                "feature_vector": self._feature_vector(values),
                "status": "anomaly_detected",
                "raw_score": raw_score,
                "normalization": "confidence = abs(score_samples) / (abs(score_samples) + 1)",
            },
        }
        return event

    def detect_threshold_exceeded(
        self,
        values: Sequence[float],
        *,
        threshold: float | None = None,
        sensor_name: str | None = None,
        zone: str | None = None,
    ) -> dict[str, Any] | None:
        if not values:
            return None

        threshold_value = float(threshold if threshold is not None else self.config.threshold)
        latest = float(values[-1])
        if latest <= threshold_value:
            return None

        sensor = sensor_name or self.config.sensor_name
        target_zone = zone or self.config.zone
        return {
            "event_id": f"threshold-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S%f')}",
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "type": "gas_spike" if sensor == "mq2" else "temperature_above_threshold",
            "zone": target_zone,
            "sensor": sensor,
            "value": latest,
            "threshold": threshold_value,
            "severity": self.config.severity,
            "confidence": round(min(1.0, max(0.0, latest / max(threshold_value, 1.0))), 3),
            "model": "threshold_alert",
            "details": {"status": "threshold_exceeded"},
        }

    def detect_motion_anomaly(
        self,
        motion_history: Sequence[float],
        *,
        zone: str | None = None,
        threshold: float | None = None,
    ) -> dict[str, Any] | None:
        if len(motion_history) < 2:
            return {"status": "insufficient_data", "message": "Need at least two motion samples."}

        latest = float(motion_history[-1])
        mean_value = float(np.mean(motion_history))
        threshold_value = float(threshold if threshold is not None else 0.8)
        target_zone = zone or self.config.zone

        if latest < threshold_value and mean_value < threshold_value:
            return None

        return {
            "event_id": f"anomaly-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S%f')}",
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "type": "motion_anomaly",
            "zone": target_zone,
            "sensor": "pir",
            "value": latest,
            "threshold": threshold_value,
            "severity": "medium",
            "confidence": round(min(1.0, max(0.0, latest / max(threshold_value, 0.1))), 3),
            "model": "threshold_alert",
            "details": {"status": "motion_anomaly_detected"},
        }
