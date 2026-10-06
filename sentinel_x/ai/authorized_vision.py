from __future__ import annotations

from collections import Counter, deque

from sentinel_x.ai.face_matcher import FaceMatcher
from sentinel_x.ai.vision import YoloVisionDetector


class AuthorizedVisionPipeline:
    def __init__(
        self,
        *,
        model_name: str = "yolov8n.pt",
        confidence_threshold: float = 0.5,
        image_size: int = 320,
        face_tolerance: float = 0.55,
        window_size: int = 5,
        min_confirmations: int = 3,
    ) -> None:
        self.yolo = YoloVisionDetector(
            model_name=model_name,
            confidence_threshold=confidence_threshold,
            image_size=image_size,
        )

        self.face_matcher = FaceMatcher(
            tolerance=face_tolerance,
        )

        self.window_size = window_size
        self.min_confirmations = min_confirmations

        # Historique indépendant par personne YOLO.
        self.histories: dict[int, deque[str]] = {}

    @staticmethod
    def _center(box):
        x1, y1, x2, y2 = box
        return (
            (x1 + x2) / 2,
            (y1 + y2) / 2,
        )

    @staticmethod
    def _point_in_box(point, box):
        px, py = point
        x1, y1, x2, y2 = box

        return (
            x1 <= px <= x2
            and y1 <= py <= y2
        )

    def _stable_candidate(self, history):
        if not history:
            return None, 0

        candidate, count = Counter(
            history
        ).most_common(1)[0]

        if count < self.min_confirmations:
            return None, count

        return candidate, count

    def _get_person_history(self, person_id):
        if person_id not in self.histories:
            self.histories[person_id] = deque(
                maxlen=self.window_size
            )

        return self.histories[person_id]

    def process_frame(self, frame):
        if frame is None:
            return None

        # ---------------------------------------------------------
        # 1. YOLO : toutes les personnes
        # ---------------------------------------------------------

        detections = self.yolo.detect(frame)

        persons = [
            d
            for d in detections
            if str(d.get("class_name", "")).lower()
            in {"person", "human", "people"}
        ]

        if not persons:
            self.histories.clear()

            return {
                "status": "no_person",
                "persons": [],
                "detection_count": 0,
            }

        # ---------------------------------------------------------
        # 2. Dlib : tous les visages
        # ---------------------------------------------------------

        matches = self.face_matcher.analyze_frame(frame)

        persons_result = []

        for person_id, person in enumerate(persons):
            bbox = person.get("bbox")

            if not bbox or len(bbox) != 4:
                continue

            person_box = [
                float(v)
                for v in bbox
            ]

            person_center = self._center(person_box)

            # Cherche le visage correspondant à cette personne.
            person_match = None

            for match in matches:
                location = match.get("location")

                if not location or len(location) != 4:
                    continue

                top, right, bottom, left = location

                face_center = (
                    (left + right) / 2,
                    (top + bottom) / 2,
                )

                if self._point_in_box(
                    face_center,
                    person_box,
                ):
                    person_match = match
                    break

            # -----------------------------------------------------
            # 3. Classification de chaque personne
            # -----------------------------------------------------

            if person_match is None:
                # YOLO voit la personne mais aucun visage
                # exploitable n'est associé.
                status = "unidentified_person"
                member = None
                distance = None

                # Pas de stabilisation pour le cas non identifiable.
                confirmations = 0
                stable = True

            else:
                distance = person_match.get("distance")

                if person_match.get("authorized"):
                    current = person_match.get("member")
                else:
                    current = "INCONNU"

                history = self._get_person_history(
                    person_id
                )

                history.append(current)

                candidate, confirmations = (
                    self._stable_candidate(history)
                )

                if candidate is None:
                    status = "pending"
                    member = None
                    stable = False

                elif candidate == "INCONNU":
                    status = "unknown_person"
                    member = None
                    stable = True

                else:
                    status = "authorized_person"
                    member = candidate
                    stable = True

            persons_result.append(
                {
                    "person_id": person_id,
                    "status": status,
                    "member": member,
                    "distance": distance,
                    "stable": stable,
                    "confirmations": confirmations,
                    "detection": person,
                }
            )

        # Nettoyage des historiques des personnes disparues.
        active_ids = {
            item["person_id"]
            for item in persons_result
        }

        self.histories = {
            person_id: history
            for person_id, history in self.histories.items()
            if person_id in active_ids
        }

        return {
            "status": "persons_detected",
            "persons": persons_result,
            "detection_count": len(persons_result),
        }

    def reset(self):
        self.histories.clear()