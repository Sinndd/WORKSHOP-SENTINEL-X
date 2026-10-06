from __future__ import annotations

from pathlib import Path
import pickle

import dlib
import face_recognition_models
import numpy as np

MEMBER_NAMES = {
    "membre 1": "Lucas",
    "membre 2": "DH",
    "membre 3": "Mattis",
    "membre 4": "Nathan",
}

class FaceMatcher:
    def __init__(
        self,
        database_path: str = "data/authorized_faces.pkl",
        tolerance: float = 0.55,
    ):
        self.database_path = Path(database_path)
        self.tolerance = tolerance

        with open(self.database_path, "rb") as f:
            self.database = pickle.load(f)

        self.face_detector = dlib.get_frontal_face_detector()

        self.shape_predictor = dlib.shape_predictor(
            face_recognition_models.pose_predictor_five_point_model_location()
        )

        self.face_encoder = dlib.face_recognition_model_v1(
            face_recognition_models.face_recognition_model_location()
        )

        count = sum(len(v) for v in self.database.values())
        print(f"✅ {count} embeddings chargés")

    def _encode_face(self, rgb_frame, rect):
        shape = self.shape_predictor(rgb_frame, rect)

        descriptor = self.face_encoder.compute_face_descriptor(
            rgb_frame,
            shape,
            1,
        )

        return np.asarray(descriptor, dtype=np.float64)

    def _match(self, encoding):
        best_member = None
        best_distance = float("inf")

        for member, embeddings in self.database.items():
            for reference in embeddings:
                distance = np.linalg.norm(
                    np.asarray(reference, dtype=np.float64) - encoding
                )

                if distance < best_distance:
                    best_distance = distance
                    best_member = member

        return {
            "authorized": best_distance <= self.tolerance,
            "member": (
    MEMBER_NAMES.get(best_member, best_member)
    if best_distance <= self.tolerance
    else None
),
            "distance": float(best_distance),
        }

    def analyze_frame(self, frame):
        rgb_frame = np.ascontiguousarray(
            frame[:, :, :3],
            dtype=np.uint8,
        )

        detections = self.face_detector(rgb_frame, 0)

        results = []

        for rect in detections:
            encoding = self._encode_face(rgb_frame, rect)
            result = self._match(encoding)

            result["location"] = (
                rect.top(),
                rect.right(),
                rect.bottom(),
                rect.left(),
            )

            results.append(result)

        return results
