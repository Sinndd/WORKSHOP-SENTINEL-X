# Comptes, accès et détection d'intrusion

Depuis la version 2.2.0, le dashboard n'utilise plus un mot de passe partagé : chaque personne a **son propre compte**,
avec un rôle, des sessions révocables et un journal de sécurité.

## Premier démarrage

`./scripts/start.sh` applique les migrations (`db/init/03-auth.sql`) puis crée le premier compte **admin** :

- identifiant : `DASHBOARD_USER` (par défaut `admin`) ;
- mot de passe **temporaire** : `DASHBOARD_PASS` dans `.env` (aléatoire si `.env` a été généré par `gen-env.sh`) ;
- à la première connexion, le changement de mot de passe est **obligatoire**.

Ensuite, onglet **Utilisateurs** : créez un compte par personne. Une même personne peut avoir plusieurs comptes
(même « nom complet », identifiants différents), par exemple un compte opérateur et un compte lecteur.

## Rôles

| Rôle | Peut faire |
|---|---|
| `viewer` (lecteur) | Consulter télémétrie, alertes, accès, vidéo. Aucune commande. |
| `operator` (opérateur) | Idem + sas, alarme, arrêt d'urgence, acquitter les alertes, badges RFID, commandes. |
| `admin` (administrateur) | Idem + comptes, sessions, journal de sécurité, IP bloquées. |

Le jeton `API_TOKEN` reste utilisable par les automates et scripts (script IA, `smoke-test.sh`) avec le rôle
**operator** : il ne peut ni administrer les comptes ni lire le journal de sécurité. `API_DEVICE_TOKEN` (ESP32)
ne sert qu'à `POST /api/v1/alerts`. L'ancienne connexion « jeton collé dans le mot de passe » a été supprimée.

## Protections en place

- **Mots de passe** : hachés en scrypt (sel aléatoire). Politique : 12 caractères minimum, 3 types sur 4
  (ou 20+ caractères), pas de mot courant, pas l'identifiant. Mot de passe temporaire à changer à la 1re connexion.
- **Sessions** : jeton aléatoire de 256 bits, **seul son SHA-256 est stocké**. Expiration après 30 min d'inactivité
  ou 12 h au total, 10 sessions simultanées maximum par compte, fermeture de toutes les autres sessions à
  chaque changement de mot de passe, déconnexion immédiate si le compte est désactivé ou son rôle réduit.
- **Double authentification (TOTP)** facultative, par compte (Mon compte). Un code ne peut pas être rejoué.
- **Pause après échecs** (pas un bannissement) : 5 échecs consécutifs → le compte attend 30 s, puis 60 s, 120 s… (plafond 5 min). Une connexion réussie remet tout à zéro ; un admin peut lever la pause.
- **Limite de débit** : 10 tentatives de connexion par minute et par adresse IP, au-delà HTTP 429 jusqu'à la minute suivante (aucun ban, aucune alerte).
- **Pas d'énumération** : même message et même durée de réponse que le compte existe ou non.
- **Blocage d'IP** (option, **désactivé par défaut** : `IP_BLOCKING=on`) : 20 échecs ou 6 identifiants différents en 10 min → adresse bloquée 15 min (HTTP 429 sur toute l'API). À activer sur le Raspberry Pi, où chaque appareil a sa propre IP.
  alerte `INTRUSION_DETECTED` (canal `server`, capteur `AUTH`) dans le journal des alertes du dashboard.
- **Journal de sécurité append-only** : l'application n'a pas le droit `DELETE` sur la base ; les comptes ne sont
  donc jamais supprimés, seulement désactivés. Le rôle de lecture seule (`sentinel_ro`) ne voit ni les comptes ni les sessions.
- Garde-fous : on ne peut pas désactiver ni rétrograder le dernier administrateur, ni modifier son propre rôle.

## Réglages (`.env`)

| Variable | Défaut | Rôle |
|---|---|---|
| `SESSION_IDLE_MIN` / `SESSION_ABSOLUTE_H` | 30 / 12 | Inactivité / durée de vie maximale d'une session |
| `LOGIN_MAX_FAILS` / `LOCK_BASE_S` / `LOCK_MAX_S` | 5 / 30 / 300 | Échecs avant pause / durée initiale (doublée à chaque fois) / plafond, en secondes |
| `LOGIN_RATE_PER_MIN` | 10 | Tentatives de connexion par minute et par IP (0 n'est pas permis : mettre une valeur élevée pour assouplir) |
| `IP_BLOCKING` | `off` | `on` active le blocage d'adresses IP |
| `IP_FAIL_THRESHOLD` / `IP_BLOCK_MIN` | 20 / 15 | Échecs par IP en 10 min / durée du blocage |
| `TRUSTED_PROXIES` | vide | Reverse proxys autorisés à fournir `X-Forwarded-For` |

## À savoir

- **Docker Desktop (Windows/macOS)** : les connexions locales arrivent toutes avec l'IP de la passerelle Docker (`172.x.0.1`). C'est pourquoi le blocage d'IP est désactivé par défaut : il bloquerait tout le poste. Si tu es quand même bloqué : `docker compose restart api` (les blocages sont en mémoire).
- **Débloquer un compte en pause** (aucun autre admin) : attendre la fin de la pause (≤ 5 min) ou
  `docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "UPDATE users SET locked_until=NULL, failed_attempts=0, lockouts=0"'`.
- **Compte admin perdu / verrouillé** (aucun autre admin) : `docker compose restart api` n'y change rien (le
  verrouillage est en base). Débloquer avec :
  `docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "UPDATE users SET locked_until=NULL, failed_attempts=0 WHERE username='"'"'admin'"'"'"'`
- **HTTP en clair** : le dashboard est servi en HTTP. Sur un réseau non maîtrisé, placer l'API derrière un reverse
  proxy HTTPS (Caddy, nginx) et renseigner `TRUSTED_PROXIES`. Ne pas exposer le port 8000 sur Internet tel quel.
- **Secret TOTP** : stocké en clair en base (accessible au seul rôle `sentinel_app`). Chiffrer la base/le disque si
  le Pi peut être volé.
- **Mise à jour d'une base existante** : `./scripts/migrate-db.sh` (idempotent ; `start.sh` l'appelle déjà).

## Endpoints

`POST /api/v1/auth/login` · `POST /auth/logout` · `GET /auth/me` · `POST /auth/password` · `GET|DELETE /auth/sessions` ·
`POST /auth/2fa/{setup,enable,disable}` · `GET|POST /users` · `PATCH /users/{id}` ·
`POST /users/{id}/{reset-password,unlock,reset-2fa,revoke-sessions}` ·
`GET /security/{summary,events,sessions,blocked-ips}` · `DELETE /security/{sessions/{id},blocked-ips/{ip}}`.
Détail interactif : `/docs`.
