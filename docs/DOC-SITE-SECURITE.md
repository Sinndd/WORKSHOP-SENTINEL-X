# SENTINEL-X — Documentation du site et revue de sécurité

Document de synthèse : comment le site est construit, qui peut faire quoi, quelles protections existent, et
**les failles trouvées lors de la relecture du code** (8 oct. 2026). Il complète `docs/SECURITE.md` (comptes et
sessions) et `docs/AUDIT-SECURITE.md` (audit précédent, dont certains points sont **en réalité à nouveau ouverts**, voir §6).

> Méthode : relecture statique du dépôt (API, proxy, broker, base, firmware, scripts, historique Git). Rien n'a été
> exécuté contre la stack ni contre le matériel. Les valeurs de secrets ne sont volontairement pas recopiées ici.

---

## 1. Architecture

```
 Navigateur ──HTTPS 443──► Caddy (proxy) ──► API FastAPI :8000 ──► PostgreSQL 17
 (dashboard React)         TLS, HSTS         (+ sert /dashboard)       ▲
                                                 │ MQTT (client "api") │
 ESP32 ──MQTTS 8883──► Mosquitto ◄───────────────┘                     │
        (HTTPS alertes)      │ MQTT (client "ingestor") ──► ingestor ──┘
 Caméra ─TCP 5001─► script vision (PC/Pi) ──HTTPS + API_TOKEN──► API  /api/v1/vision/snapshot
 NTP (chrony, 123/udp) ─► ESP32 (heure pour valider les certificats TLS)
```

| Composant | Rôle | Réseau |
|---|---|---|
| `proxy` (Caddy 2.10) | Seul point d'entrée web. TLS 1.2/1.3 avec la CA interne, 80 → 443, HSTS, corps ≤ 3 Mo | publie 80/443 |
| `api` (FastAPI) | REST `/api/v1`, comptes/sessions, pont MQTT (décision d'accès RFID, commandes), sert le dashboard compilé | interne (`backend`), **non publié** |
| `mosquitto` | Broker MQTTS uniquement, ACL par compte, pas d'anonyme | publie 8883 |
| `postgres` | Données, comptes, sessions, journal de sécurité | interne, **non publié** |
| `ingestor` | MQTT → PostgreSQL (télémétrie, alertes, événements vision) | interne |
| `ntp` (chrony) | Heure pour l'ESP32 sans Internet | publie 123/udp |
| `dashboard/` | SPA React (thèmes, Wall-E 3D, flux vidéo MJPEG), compilée dans l'image API | via l'API |
| `firmware/sentinel_core` | ESP32 : capteurs, RFID MIFARE, moteurs/servos, MQTTS | Wi-Fi |
| `sentinel_x/ai`, `scripts/*vision*` | Reconnaissance YOLO/visages, envoi d'images à l'API | hôte |

Le réseau `backend` est `internal: true` (aucune sortie). Tous les conteneurs : `read_only`, `cap_drop: ALL`,
`no-new-privileges`, utilisateur non root, limites mémoire/PID.

## 2. Qui peut faire quoi (API)

Authentification : `Authorization: Bearer <jeton>`. Trois sortes de jetons :

| Jeton | Origine | Droits |
|---|---|---|
| Session `sx_…` | `POST /auth/login` (+ TOTP) | rôle du compte : viewer < operator < admin |
| `API_TOKEN` | `.env`, statique | **operator** permanent, sans 2FA ni expiration (scripts, IA, smoke-test) |
| `API_DEVICE_TOKEN` | `.env`, statique | ESP32 : `POST /alerts` uniquement |

| Niveau | Routes |
|---|---|
| Public | `POST /auth/login`, `/health`, `/ready`, `/dashboard/*` (fichiers statiques), `/docs` `/redoc` `/openapi.json` (si `API_DOCS=on`, **valeur par défaut**) |
| viewer | lecture : alertes, devices, télémétrie (+ CSV, agrégats), accès RFID, commandes, vision (flux, snapshot, événements) |
| operator | acquitter alerte, badges (créer/modifier/révoquer), enrôlement, `POST /commands`, `/actuators/*` (sas, bras, tête, trappe, alarme, **arrêt d'urgence**), `POST /vision/snapshot` |
| device ou operator | `POST /alerts` |
| admin | `/users*`, `/security*` (journal, sessions, IP bloquées) |

Les `must_change_password` bloquent tout sauf `/auth/me`, changement de mot de passe, déconnexion.

## 3. Protections en place (vérifiées dans le code)

- **Mots de passe** : scrypt (n=2¹⁴, sel 16 o), politique 12 car./3 classes, hash factice pour les comptes inconnus (pas d'énumération).
- **Sessions** : 256 bits, seul le SHA-256 est stocké ; inactivité 30 min, durée max 12 h, 10 sessions max, révocation au changement de mot de passe / rôle / désactivation, toutes fermées au redémarrage de l'API.
- **Anti brute force** : pause progressive par compte (5 échecs → 30 s … 5 min), 10 logins/min/IP, blocage d'IP optionnel, alerte `INTRUSION_DETECTED`.
- **TOTP** RFC 6238 avec anti-rejeu du pas de temps.
- **Journal de sécurité** append-only pour l'appli (`sentinel_app` n'a pas DELETE), caractères de contrôle neutralisés.
- **Base** : rôles séparés (`sentinel_app` SELECT/INSERT/UPDATE, `sentinel_ro` lecture seule sans accès à `users`/`sessions`), requêtes toutes paramétrées (aucune injection SQL repérée), `statement_timeout`.
- **Entrées** : modèles Pydantic stricts, corps JSON ≤ 64 Kio, snapshot ≤ 2 Mio et JPEG obligatoire, `limit` borné, alertes 60/min/IP.
- **Navigateur** : CSP `script-src 'self'`, `frame-ancestors 'none'`, `nosniff`, `no-store` sur `/api`, `Referrer-Policy: no-referrer`, pas de CORS, jeton en `sessionStorage`, pas de `innerHTML`/`eval` dans le dashboard.
- **MQTT** : TLS 1.2+ avec suites ECDHE/AEAD, ACL minimale par compte, `max_connections 20`, `max_packet_size 4096`, `max_qos 1`.
- **Badges RFID** : clés A/B dérivées (HMAC-SHA256) de `CARD_MASTER_KEY` + UID, contenu signé, compteur anti-clonage (limite connue du MIFARE Classic, voir `docs/BADGES.md`).
- **Hôte** : UFW + chaîne `DOCKER-USER` limitant les ports publiés au Wi-Fi de la table, SSH par clés, root interdit.
- **X-Forwarded-For** : pris en compte uniquement depuis le proxy à IP fixe (`172.30.0.10`).

## 4. Failles et faiblesses trouvées

Gravité : 🔴 critique · 🟠 haute · 🟡 moyenne · 🟢 basse.

### 🔴 S1 — Le `.env` en place utilise des secrets par défaut publiés dans Git (dépôt PUBLIC)

Le dépôt `Sinndd/WORKSHOP-SENTINEL-X` est **public**. Dans l'historique figurent les anciennes valeurs par défaut du code
(`fc1974e`, corrigées dans `d8ea0eb`). Comparaison exacte (sans afficher les valeurs) avec le `.env` actuel de cette machine :

| Variable du `.env` | Valeur retrouvée dans l'historique Git ? |
|---|---|
| `API_TOKEN` | **oui** |
| `API_DEVICE_TOKEN` | **oui** |
| `MQTT_PASS_ESP32` | **oui** |
| `DASHBOARD_PASS` | **oui** |

Le `.env` n'est pas versionné, mais il a manifestement été rempli avec ces valeurs de démonstration. Conséquences si ce `.env`
(ou un équivalent) tourne sur le Pi ou sur le réseau de démo :

- `API_TOKEN` connu = rôle **operator** sans mot de passe ni 2FA : ouvrir le sas, déclencher/couper l'alarme, **créer un badge valide** (accès physique), voir la vidéo, acquitter les alertes.
- `MQTT_PASS_ESP32` connu = publier de fausses télémétries/alertes, forger `sentinel/access` et `sentinel/enroll` (voir S6).
- `DASHBOARD_PASS` = mot de passe initial de l'admin : à tester, il ne protège que si le compte n'a jamais été créé avec lui ou si le mot de passe a été changé (changement imposé, mais à vérifier dans `security_events`).

**Correctif** : traiter ces valeurs comme compromises. `./scripts/gen-env.sh --force` → `./scripts/start.sh` → reflasher l'ESP32
(`secrets.h`) → vérifier `users`/`sessions`/`security_events` → changer tous les mots de passe de comptes. Réécrire l'historique
(`git filter-repo`) ou republier dans un dépôt neuf, et passer le dépôt en privé le temps du nettoyage. Ajouter un garde-fou :
`gen-env.sh`/`start.sh` doivent refuser de démarrer si un secret est dans une liste de valeurs connues.

### 🟠 S2 — Données biométriques et `pickle` dans le dépôt public (partiellement corrigé : plus de pickle, fichier retiré de l’index ; reste l’historique Git)

`data/authorized_faces.pkl` (embeddings des visages autorisés) est **suivi par Git** (commit `49d2013`) malgré `data/` dans
`.gitignore` (l'ignore ne s'applique pas aux fichiers déjà suivis). Deux problèmes :

1. Donnée biométrique de personnes physiques, publique : RGPD (art. 9) et risque d'usage détourné.
2. `sentinel_x/ai/face_matcher.py:27` fait `pickle.load()` : **tout fichier `.pkl` modifié = exécution de code** sur la machine vision
   (un `git pull` ou un fichier substitué suffit).

**Correctif** : `git rm --cached data/authorized_faces.pkl` + purge de l'historique ; stocker les embeddings en `.npz`/JSON avec signature
HMAC vérifiée avant chargement (ou `numpy.load(allow_pickle=False)`), fichier hors dépôt, droits 600 ; obtenir le consentement des personnes enregistrées.

### 🟠 S3 — `API_TOKEN` : jeton opérateur statique, trop puissant et trop répandu

Le script de vision (sur un autre poste, voir `scripts/sentinel-vision.service`) n'a besoin que d'envoyer des images, mais reçoit un
jeton qui **commande les moteurs et les badges**. Ce jeton ne expire jamais, contourne la 2FA, n'est lié à aucune personne dans le
journal (`service`), et n'est pas limité en débit hors du login.

**Correctif** : un jeton dédié par usage (`VISION_TOKEN` → uniquement `POST /vision/snapshot`), rotation documentée, comparaison déjà en temps constant (bien),
journaliser chaque usage de jeton de service, et idéalement restreindre par IP source côté Caddy.

### 🟡 S4 — Protections anti-intrusion désactivées par défaut

`IP_BLOCKING=off` par défaut ; les essais de jetons inconnus ne sont comptés que si le blocage est actif. Le limiteur de login est
en mémoire et par IP (contourné par plusieurs adresses ; remis à zéro à chaque redémarrage de l'API).
**Correctif** : `IP_BLOCKING=on` dans `.env.example` (documenté comme pour le Pi) ; limite globale par IP sur tout `/api` côté Caddy (ou plugin rate-limit).

### 🟡 S5 — Flux caméra non authentifié, non chiffré

`scripts/pi-camera-stream.sh` écoute `tcp://0.0.0.0:5001` (MJPEG brut). Seul UFW (`CAM_NET`) le protège ; sans le script
`harden-host.sh` appliqué (poste de dev, panne de règle), n'importe qui sur le réseau voit la caméra.
**Correctif** : écouter sur l'IP du câble point-à-point (`10.42.0.x`) plutôt que `0.0.0.0`, ou passer par SSH/WireGuard.

### 🟡 S6 — Identité MQTT unique de l'ESP32, messages non signés

Tous les messages de l'ESP32 partagent un seul compte. Qui le possède (flash non chiffré, ou S1) peut :
publier de fausses mesures/alertes (`node_id` libre) ; pendant une fenêtre d'enrôlement, publier un faux `SUCCESS` sur `sentinel/enroll`
et **enregistrer un UID choisi** comme badge actif (`mqtt_bridge.py:handle_enroll`). Les commandes de l'API vers l'ESP32 ne sont pas signées non plus.
**Correctif** : activer flash encryption + secure boot sur l'ESP32, certificat client par appareil (`require_certificate true`),
imposer que `node_id` du message == identité MQTT, signer (HMAC) les commandes sensibles avec un compteur anti-rejeu.

### 🟡 S7 — Clé privée de la CA stockée sur le serveur

`mosquitto/certs/ca.key` est sur l'hôte à côté de `server.key` (le script le rappelle : « à sortir du Pi »). Compromission de l'hôte = pouvoir émettre
des certificats pour usurper le broker et le dashboard.
**Correctif** : déplacer `ca.key` hors ligne après `gen-certs.sh`, durée de vie des certificats serveur raccourcie.

### 🟢 S8 — Surface d'information

`/docs`, `/redoc`, `/openapi.json` sont **publics par défaut** (`API_DOCS=on`) et servis sans CSP ; `/ready` expose l'état DB/MQTT sans authentification.
**Correctif** : `API_DOCS=off` en production, `/ready` limité au réseau interne (Caddy).

### 🟢 S9 — Secrets TOTP en clair en base

`users.totp_secret` est stocké en base32 lisible par `sentinel_app`. Une fuite de la base permet de régénérer les codes.
**Correctif** : chiffrer avec une clé d'application (`TOTP_ENC_KEY` dans `.env`, AES-GCM / Fernet).

### 🟢 S10 — CSP et jeton côté navigateur

`style-src 'unsafe-inline'` ; le jeton de session est dans `sessionStorage` (lisible par un XSS, atténué par la CSP stricte `script-src 'self'`). Pas de CSP sur les réponses hors `/dashboard`.
**Correctif** : nonces/hash pour les styles, cookie `HttpOnly; Secure; SameSite=Strict` à la place du Bearer si l'architecture le permet (ajouter alors une protection CSRF).

### 🟢 S11 — Chaîne d'approvisionnement et hygiène du dépôt

Images Docker référencées par tag, pas par digest ; pas de scan automatique des dépendances (pip/npm) ni de CI ; dossiers en `drwxrwxrwx` (`firmware/`, `hardware/`, `sketches/`, `src/`) ;
fichier vide parasite `236881` à la racine ; archive hors-ligne de 322 Mo et `yolov8n.pt` dans le répertoire (ignorés par Git, à ne pas publier).
**Correctif** : digests, `pip-audit`/`npm audit` en CI, `chmod 755`, nettoyage.

### 🟢 S12 — NTP non authentifié

Qui est sur le Wi-Fi peut fausser l'heure de l'ESP32 et ainsi perturber la validation des certificats (déni de service). `chrony.conf` autorise tous les réseaux privés.
**Correctif** : restreindre `allow` au sous-réseau Wi-Fi de la table ; RTC DS3231 pour ne plus dépendre du réseau.

## 5. Plan de correction proposé (ordre)

1. **S1** — rotation de tous les secrets, vérification des comptes, purge de l'historique / dépôt privé.
2. **S2** — retrait de `authorized_faces.pkl` et abandon de `pickle`.
3. **S3** — jeton dédié à la vision.
4. S4, S5, S8 — petites modifications de configuration (`IP_BLOCKING=on`, `API_DOCS=off`, bind du flux caméra).
5. S6, S7, S9 — durcissement plus lourd (certificats clients, flash encryption, chiffrement TOTP).
6. S10–S12 — hygiène.

## 6. Écart avec l'audit précédent

`AUDIT-SECURITE.md` (F1) indique que « le `.env` a été régénéré » et que les anciennes valeurs « ne sont plus valides ». Le `.env` présent
dans cet environnement contient pourtant encore quatre valeurs de l'historique (S1). Soit c'est un `.env` de test local distinct de celui du Pi
(auquel cas il faut le confirmer et le régénérer quand même), soit F1 n'est pas réellement clos.

## 7. Vérifier / rejouer

- `./scripts/audit-security.sh` — contrôles automatiques sur la stack qui tourne.
- `cd api && python -m unittest` — tests de l'API.
- Après correctif de S1 : se connecter avec l'ancien `API_TOKEN` doit renvoyer 401 ; `mosquitto_pub` avec l'ancien mot de passe ESP32 doit être refusé.
- Journal : onglet Sécurité du dashboard, ou `GET /api/v1/security/events` (admin).
