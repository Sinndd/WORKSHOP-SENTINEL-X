import unittest
from unittest.mock import patch

from sentinel_x.ai.anomaly import AnomalyConfig, SensorAnomalyDetector


class SensorAnomalyDetectorTests(unittest.TestCase):
    def test_detects_gas_spike(self):
        detector = SensorAnomalyDetector(AnomalyConfig(zone="lab", sensor_name="mq2", threshold=0.6))
        event = detector.detect_threshold_exceeded([0.1, 0.4, 0.82])

        self.assertIsNotNone(event)
        self.assertEqual(event["type"], "gas_spike")
        self.assertEqual(event["zone"], "lab")
        self.assertEqual(event["sensor"], "mq2")

    def test_detects_motion_anomaly(self):
        detector = SensorAnomalyDetector(AnomalyConfig(zone="entry", sensor_name="pir"))
        event = detector.detect_motion_anomaly([0.25, 0.72, 0.9], threshold=0.8)

        self.assertIsNotNone(event)
        self.assertEqual(event["type"], "motion_anomaly")
        self.assertEqual(event["zone"], "entry")

    @staticmethod
    def normal_history():
        return [
            [0.198 + (index % 3) * 0.001, 0.200 + (index % 4) * 0.001, 0.202 + (index % 2) * 0.001]
            for index in range(40)
        ]

    def test_isolation_forest_predicts_normal_data(self):
        detector = SensorAnomalyDetector(AnomalyConfig(min_train_samples=8))
        detector.train(self.normal_history())

        result = detector.predict([0.199, 0.201, 0.202])

        self.assertEqual(result["prediction"], 1)

    def test_isolation_forest_predicts_extreme_outlier(self):
        detector = SensorAnomalyDetector(AnomalyConfig(min_train_samples=8))
        detector.train(self.normal_history())

        with patch.object(detector._model, "predict", wraps=detector._model.predict) as predict:
            result = detector.predict([0.2, 0.2, 0.2, 50.0])

        predict.assert_called_once()
        self.assertEqual(result["prediction"], -1)
        event = detector.detect([0.2, 0.2, 0.2, 50.0])
        self.assertEqual(event["type"], "ml_anomaly_detected")

    def test_insufficient_history_has_explicit_status(self):
        detector = SensorAnomalyDetector(AnomalyConfig(min_train_samples=8))

        result = detector.detect([0.2, 0.21], history=[0.2, 0.21, 0.22])

        self.assertEqual(result["status"], "insufficient_data")

    def test_detect_reuses_trained_model(self):
        detector = SensorAnomalyDetector(AnomalyConfig(min_train_samples=8))
        detector.train(self.normal_history())

        with patch.object(detector._model, "fit", wraps=detector._model.fit) as fit:
            detector.detect([0.2, 0.201, 0.202], history=self.normal_history())

        fit.assert_not_called()


if __name__ == "__main__":
    unittest.main()
