# Visages autorisés — ajout depuis le tableau de bord

Onglet **Visages** (administrateurs). Plus besoin de fichier ni de commande : on ajoute, désactive ou supprime
une personne depuis l'interface, et la reconnaissance se met à jour toute seule en quelques secondes.

## Ajouter quelqu'un

1. Onglet **Visages** → nom de la personne, case de **consentement**, méthode :
   - **Caméra** (recommandé) : la personne se place devant la caméra ; le direct s'affiche dans la page, 5 échantillons sont
     pris à ≥ 0,8 s d'écart (tourner très légèrement la tête entre deux). Fenêtre de 90 s.
   - **Photo** : envoi d'une image JPEG/PNG (de face, **un seul** visage ; réduite automatiquement à 1600 px). Fenêtre de 60 s.
2. Pour **améliorer la fiabilité**, retapez le nom d'une personne existante : de nouveaux échantillons s'ajoutent
   (3 minimum conseillés, avec des lumières/angles différents).
3. Autres actions : renommer, **désactiver** (n'est plus reconnu, données conservées), **supprimer** (effacement réel).

Prérequis : le script de vision tourne (`./scripts/run-vision.sh`) avec l'IA activée (pas `--no-ai`). Mise à jour de la base :
`./scripts/migrate-db.sh` (fait par `start.sh`) pour créer les tables de `db/init/05-faces.sql`.

## Comment ça marche

```
Dashboard ──(admin)──► API  POST /api/v1/faces/enrollments[/photo]   → demande « PENDING » en base
Script de vision ──(jeton de service, 1 fois/s)──► GET /faces/enrollments → capte la caméra / décode la photo (dlib)
                  └─► POST /faces/enrollments/{id}/embeddings  (vecteurs de 128 nombres)
Script de vision ──(toutes les 5 s)──► GET /faces/version → si changé : GET /faces/embeddings → IA mise à jour
```

Le modèle dlib n'existe que sur la machine de vision : l'API ne reçoit et ne stocke **que des vecteurs**.

## Sécurité et vie privée

- Gestion (ajout/renommage/désactivation/suppression) : **admin** uniquement ; liste en lecture : operator+.
- Lecture des vecteurs et dépôt des résultats : **jeton de service uniquement** (script de vision), refusé aux sessions humaines et au rôle `sentinel_ro` (accès SQL retiré).
- Les photos ne sont jamais conservées : effacées (`photo = NULL`) dès la fin du traitement, annulation ou expiration.
- Consentement obligatoire (case à cocher, stocké). Suppression = effacement réel (`ON DELETE CASCADE`).
- Chaque action est tracée dans le journal de sécurité : `FACE_ENROLL_REQUESTED`, `FACE_ENROLLED`, `FACE_UPDATED`, `FACE_DELETED`.
- Plus aucun `pickle` : la base n'est plus un fichier exécutable. `data/authorized_faces.pkl` est retiré de l'index Git
  (**toujours présent dans l'historique d'un dépôt public** : voir `docs/DOC-SITE-SECURITE.md` S2 pour la purge).
- Hors ligne / essais : `python -m sentinel_x.ai.authorized_faces` produit `data/authorized_faces.json` (ignoré par Git).

## Limites connues

- Un visage n'est pas un secret : une photo imprimée ou un écran peut tromper dlib (pas de détection de vivacité). À ne pas
  utiliser seul pour une décision d'accès physique.
- Les anciens vecteurs du `.pkl` ne sont pas migrés : ré-enrôler les personnes (1 minute chacune).
- La reconnaissance convertit maintenant les images OpenCV de BGR en RGB avant dlib (correction : avant, les couleurs étaient inversées).
