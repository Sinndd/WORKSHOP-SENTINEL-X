from pathlib import Path
import pickle

import face_recognition


DATA_DIR = Path("data")
OUTPUT_FILE = DATA_DIR / "authorized_faces.pkl"


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
                print(
                    f"  ⚠️ {len(locations)} visage(s) détecté(s), "
                    "photo ignorée"
                )
                continue

            encoding = face_recognition.face_encodings(
                image,
                known_face_locations=locations,
            )[0]

            encodings.append(encoding)
            print("  ✓ visage enregistré")

        if encodings:
            database[member_dir.name] = encodings
            print(f"✓ {member_dir.name}: {len(encodings)} référence(s)")
        else:
            print(f"⚠️ {member_dir.name}: aucune référence valide")

    with OUTPUT_FILE.open("wb") as file:
        pickle.dump(database, file)

    print()
    print(f"Base créée : {OUTPUT_FILE}")
    print(f"Membres : {len(database)}")
    print(f"Photos : {sum(len(v) for v in database.values())}")


if __name__ == "__main__":
    build_database()