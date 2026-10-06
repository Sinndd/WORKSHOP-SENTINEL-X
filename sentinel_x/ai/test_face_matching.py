from pathlib import Path
import pickle

import face_recognition


DB = Path("data/authorized_faces.pkl")


def main():
    with DB.open("rb") as f:
        database = pickle.load(f)

    print(f"Membres chargés : {list(database)}")

    for member, encodings in database.items():
        for i, known_encoding in enumerate(encodings, 1):
            # On compare une référence avec elle-même.
            distance = face_recognition.face_distance(
                [known_encoding],
                known_encoding,
            )[0]

            print(
                f"{member} / référence {i}: "
                f"distance={distance:.4f}"
            )


if __name__ == "__main__":
    main()
