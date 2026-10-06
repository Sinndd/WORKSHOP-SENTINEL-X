import unittest
from unittest.mock import Mock, patch

from sentinel_x.ai.vision import (
    MockVisionDetector,
    VisionConfig,
    VisionEventGenerator,
    YoloVisionDetector,
)


class VisionEventGeneratorTests(unittest.TestCase):
    def test_generates_human_presence_event(self):
        detector = VisionEventGenerator(
            VisionConfig(zone="entry", confidence_threshold=0.2, intrusion_threshold=0.7),
            detector=MockVisionDetector(),
        )
        event = detector.analyze_frame(b"\x00\x01\x02\x03\x04\x05\x06\x07" * 32, force=True)

        self.assertIsNotNone(event)
        self.assertIn(event["type"], {"human_presence_detected", "intrusion_detected"})
        self.assertEqual(event["zone"], "entry")
        self.assertIn(event["severity"], {"medium", "high"})
        self.assertEqual(event["details"]["detector_mode"], "MOCK")

    def test_mock_is_only_used_when_explicitly_injected(self):
        generator = VisionEventGenerator(
            VisionConfig(zone="entry"),
            detector=MockVisionDetector(),
        )
        self.assertIsInstance(generator.detector, MockVisionDetector)

    def test_production_does_not_fallback_when_yolo_is_unavailable(self):
        with patch("sentinel_x.ai.vision.YOLO", None):
            with self.assertRaisesRegex(RuntimeError, "ultralytics is required"):
                VisionEventGenerator()

    def test_yolo_model_is_loaded_once_and_config_model_is_used(self):
        predictor = Mock()
        predictor.predict.return_value = []
        loader = Mock(return_value=predictor)
        config = VisionConfig(model_name="yolov8n.pt", image_size=320)

        with patch("sentinel_x.ai.vision.YOLO", loader):
            detector = YoloVisionDetector(
                model_name=config.model_name,
                confidence_threshold=config.confidence_threshold,
                image_size=config.image_size,
            )
            generator = VisionEventGenerator(config, detector=detector)
            generator.detect(b"frame-1")
            generator.detect(b"frame-2")

        loader.assert_called_once_with(config.model_name)
        self.assertEqual(predictor.predict.call_count, 2)
        self.assertEqual(predictor.predict.call_args.kwargs["imgsz"], 320)

    def test_confidence_threshold_is_not_bypassed_by_force(self):
        generator = VisionEventGenerator(
            VisionConfig(confidence_threshold=0.95),
            detector=MockVisionDetector(),
        )

        self.assertIsNone(generator.analyze_frame(b"frame", force=True))

    def test_inference_metrics_are_reported_for_real_analysis(self):
        generator = VisionEventGenerator(
            VisionConfig(zone="entry", confidence_threshold=0.2),
            detector=MockVisionDetector(),
        )

        event = generator.analyze_frame(b"frame", force=True)

        self.assertIsNotNone(event)
        self.assertIn("inference_seconds", event["details"])
        self.assertIn("fps_estimate", event["details"])
        self.assertGreaterEqual(event["details"]["inference_seconds"], 0.0)
        self.assertGreaterEqual(event["details"]["fps_estimate"], 0.0)


if __name__ == "__main__":
    unittest.main()
