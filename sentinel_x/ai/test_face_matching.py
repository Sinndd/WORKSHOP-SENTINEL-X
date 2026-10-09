import json
from pathlib import Path

import face_recognition

DB = Path("data/authorized_faces.json")


def main():
    database = json.loads(DB.read_text(encoding="utf-8"))
    print(f"Membres chargés : {list(database)}")
    for member, encodings in database.items():
        for i, known_encoding in enumerate(encodings, 1):
            # On compare une référence avec elle-même.
            distance = face_recognition.face_distance([known_encoding], known_encoding)[0]
            print(f"{member} / référence {i}: distance={distance:.4f}")


if __name__ == "__main__":
    main()
