"""Dessin des résultats de l'IA (cadres, noms, distances) sur une image, pour le flux du tableau de bord."""
from __future__ import annotations

import cv2

GREEN = (0, 255, 0)
RED = (0, 0, 255)
ORANGE = (0, 165, 255)
WHITE = (255, 255, 255)


def _style(status):
    if status == "authorized_person":
        return GREEN, "AUTORISE"
    if status == "unknown_person":
        return RED, "INCONNU"
    if status == "unidentified_person":
        return ORANGE, "NON IDENTIFIABLE"
    return WHITE, "ANALYSE..."


def draw_persons(display, result) -> int:
    """Dessine chaque personne détectée sur `display` (modifié sur place) ; renvoie leur nombre."""
    persons = (result or {}).get("persons", [])
    scale = max(1.0, display.shape[1] / 640.0)
    thick = max(2, round(2 * scale))
    for person in persons:
        bbox = (person.get("detection") or {}).get("bbox")
        if not bbox or len(bbox) != 4:
            continue
        x1, y1, x2, y2 = map(int, bbox)
        color, label = _style(person.get("status"))
        member = person.get("member")
        if member:
            label = f"{label} : {member}"
        cv2.rectangle(display, (x1, y1), (x2, y2), color, thick)
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.6 * scale, thick)
        top = max(th + 8, y1)
        cv2.rectangle(display, (x1, top - th - 8), (x1 + tw + 8, top), color, -1)          # étiquette pleine, lisible sur tout fond
        cv2.putText(display, label, (x1 + 4, top - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.6 * scale, (0, 0, 0), thick)
        distance = person.get("distance")
        if distance is not None:
            cv2.putText(display, f"visage {distance:.2f}", (x1, min(display.shape[0] - 6, y2 + int(20 * scale))),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5 * scale, color, max(1, thick - 1))
    return len(persons)


def draw_hud(display, lines) -> None:
    """Bandeau d'informations (débits, résolution) en bas à gauche, sur fond sombre."""
    scale = max(1.0, display.shape[1] / 640.0)
    h = display.shape[0]
    text = "   ".join(lines)
    (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.45 * scale, 1)
    cv2.rectangle(display, (0, h - th - 12), (tw + 12, h), (0, 0, 0), -1)
    cv2.putText(display, text, (6, h - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.45 * scale, WHITE, 1)
