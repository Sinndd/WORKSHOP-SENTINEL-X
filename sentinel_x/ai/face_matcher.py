from __future__ import annotations

import json
import threading
from pathlib import Path

import dlib
import face_recognition_models
import numpy as np

MEMBER_NAMES: dict[str, str] = {}   # alias optionnel « clé de la base -> nom affiché » (les noms viennent désormais de l'API)


class FaceMatcher:
    """Compare les visages d'une image à la base des visages autorisés.

    La base vient de l'API (dashboard_stream.FaceSync, onglet « Visages » du tableau de bord) via set_database(), ou d'un
    fichier JSON {"nom": [[128 nombres], ...]} pour les essais hors ligne. Plus de pickle : charger un fichier
    ne peut plus exécuter de code.
    """

    def __init__(self, database_path: str | None = None, tolerance: float = 0.55):
        self.tolerance = tolerance
        self.database: dict[str, list] = {}
        self._lock = threading.Lock()          # dlib n'est pas prévu pour des appels simultanés (IA + enrôlement)

        self.face_detector = dlib.get_frontal_face_detector()
        self.shape_predictor = dlib.shape_predictor(face_recognition_models.pose_predictor_five_point_model_location())
        self.face_encoder = dlib.face_recognition_model_v1(face_recognition_models.face_recognition_model_location())

        if database_path:
            self.load_json(database_path)

    # --- Base de visages --------------------------------------------------------------
    def set_database(self, members: dict[str, list]) -> None:
        """Remplace toute la base (affectation atomique : l'IA qui tourne n'est jamais interrompue)."""
        self.database = {name: [np.asarray(v, dtype=np.float64) for v in vecs] for name, vecs in members.items() if vecs}
        print(f"✅ {self.count} embeddings chargés ({len(self.database)} personne(s))")

    def load_json(self, path: str) -> None:
        with open(Path(path), encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            raise ValueError("format attendu : {\"nom\": [[128 nombres], ...]}")
        self.set_database(data)

    @property
    def count(self) -> int:
        return sum(len(v) for v in self.database.values())

    # --- Encodage ---------------------------------------------------------------------------
    @staticmethod
    def _to_rgb(frame) -> np.ndarray:
        """Les images OpenCV sont en BGR ; dlib attend du RGB (sinon la reconnaissance perd en précision)."""
        return np.ascontiguousarray(frame[:, :, 2::-1] if frame.shape[2] >= 3 else frame, dtype=np.uint8)

    def _encode_face(self, rgb_frame, rect):
        shape = self.shape_predictor(rgb_frame, rect)
        descriptor = self.face_encoder.compute_face_descriptor(rgb_frame, shape, 1)
        return np.asarray(descriptor, dtype=np.float64)

    def encode_faces(self, frame, upsample: int = 0) -> list[np.ndarray]:
        """Vecteurs de tous les visages de l'image BGR (enrôlement : on exige exactement un visage)."""
        rgb = self._to_rgb(frame)
        with self._lock:
            return [self._encode_face(rgb, rect) for rect in self.face_detector(rgb, upsample)]

    def _match(self, encoding):
        best_member = None
        best_distance = float("inf")
        for member, embeddings in list(self.database.items()):
            for reference in embeddings:
                distance = np.linalg.norm(np.asarray(reference, dtype=np.float64) - encoding)
                if distance < best_distance:
                    best_distance = distance
                    best_member = member
        authorized = best_distance <= self.tolerance
        return {
            "authorized": authorized,
            "member": MEMBER_NAMES.get(best_member, best_member) if authorized else None,
            "distance": float(best_distance),
        }

    def analyze_frame(self, frame):
        rgb_frame = self._to_rgb(frame)
        results = []
        with self._lock:
            for rect in self.face_detector(rgb_frame, 0):
                result = self._match(self._encode_face(rgb_frame, rect))
                result["location"] = (rect.top(), rect.right(), rect.bottom(), rect.left())
                results.append(result)
        return results
