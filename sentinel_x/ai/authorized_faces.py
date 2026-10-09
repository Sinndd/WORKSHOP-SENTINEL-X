"""Construit un fichier JSON de visages à partir de photos locales (usage hors ligne, essais).

Normalement, les visages s'ajoutent depuis l'onglet « Visages » du tableau de bord (voir docs/VISAGES.md).
Structure attendue : data/<nom de la personne>/*.jpeg  ->  data/authorized_faces.json
(fichier ignoré par Git : ce sont des données biométriques, ne jamais les publier).
"""
import json
from pathlib import Path

import face_recognition

DATA_DIR = Path("data")
OUTPUT_FILE = DATA_DIR / "authorized_faces.json"


def build_database() -> None:
    database = {}

    for member_dir in sorted(DATA_DIR.iterdir()):
        if not member_dir.is_dir() or member_dir.name.startswith("."):
            continue

        encodings = []
        for image_path in sorted(member_dir.glob("*.jpeg")):
            print(f"Analyse : {image_path}")
            image = face_recognition.load_image_file(image_path)
            locations = face_recognition.face_locations(image)
            if len(locations) != 1:
                print(f"  ⚠️ {len(locations)} visage(s) détecté(s), photo ignorée")
                continue
            encodings.append(face_recognition.face_encodings(image, known_face_locations=locations)[0].tolist())
            print("  ✓ visage enregistré")

        if encodings:
            database[member_dir.name] = encodings
            print(f"✓ {member_dir.name}: {len(encodings)} référence(s)")
        else:
            print(f"⚠️ {member_dir.name}: aucune référence valide")

    OUTPUT_FILE.write_text(json.dumps(database), encoding="utf-8")
    print(f"\nBase créée : {OUTPUT_FILE} — {len(database)} membre(s), {sum(len(v) for v in database.values())} photo(s)")


if __name__ == "__main__":
    build_database()
