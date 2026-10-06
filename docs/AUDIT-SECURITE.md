# Rapport d'audit de sécurité — SENTINEL-X

Audit défensif de notre propre prototype (stack serveur, firmware ESP8266, câblage), réalisé avant le gel du code.
Preuves reproductibles : `./scripts/audit-security.sh` (30 contrôles automatiques sur la stack qui tourne) et
`python -m unittest` dans `api/` (23 tests). Ce document complète la matrice de sécurité du dossier technique.

**Périmètre** : API + dashboard (derrière le proxy HTTPS `:443`), broker Mosquitto (`:8883`), PostgreSQL, ingestor, conteneurs, dépôt Git,
firmware `firmware/sentinel_core`, schéma `hardware/kicad`, notes de câblage.
**Hors périmètre** : attaques de déni de service volumétriques et MitM actifs (réservés au pentest croisé du jeudi,
cf. checklist en fin de document), script de vision IA (hors dépôt), sécurité physique du local.

## 1. Synthèse

| # | Gravité | Constat | Statut |
|---|---|---|---|
| F1 | **Critique** | Mot de passe MQTT, jeton d'appareil et mot de passe Wi-Fi **en clair dans Git** (`firmware/sentinel_core/config.h`, `src/config.h`) | Corrigé dans l'arbre de travail (`secrets.h` ignoré) ; **reste dans l'historique** → voir §3 |
| F2 | Haute | Mot de passe Wi-Fi faible (`123456789`, partage de connexion d'un téléphone) | À faire : WPA2/3, 16+ caractères |
| F3 | Haute | Aucun moyen d'authentifier les personnes (mot de passe unique partagé, jeton réutilisable) | **Corrigé** : comptes personnels, rôles, 2FA, verrouillage, blocage d'IP (`docs/SECURITE.md`) |
| F4 | Haute | Firmware : le handshake TLS dépend de l'heure (NTP). Sans Internet et sans serveur NTP sur le Pi, **le MQTTS ne démarre jamais** ; chaque tentative bloque la boucle (capteurs, alarme locale) | Partiellement corrigé (attente de l'heure + délai croissant) ; serveur NTP à configurer sur le Pi (§4) |
| F5 | Moyenne | Envoi de snapshot webcam sans limite de taille ni contrôle du format (épuisement mémoire du conteneur, 128 Mo) | **Corrigé** : 2 Mio max, JPEG exigé, plafond 64 Kio sur tout JSON |
| F6 | Moyenne | Alertes `POST /alerts` sans limite de débit (remplissage de la base / usure de la carte SD) | **Corrigé** : 60/min par adresse |
| F7 | Moyenne | Verrouillage de compte : quiconque connaît un identifiant pouvait le verrouiller (déni de service ciblé) | **Atténué** : simple pause de 30 s à 5 min (au lieu de 15 min à 24 h), limite de 10 connexions/min/IP, blocage d'IP optionnel (`IP_BLOCKING=on`) ; ne jamais n'avoir qu'un seul admin |
| F8 | Moyenne | Trafic dashboard en HTTP : mots de passe lisibles par une personne déjà sur le Wi-Fi | Atténué (Wi-Fi WPA2/3 isolé) ; HTTPS avec la CA interne possible |
| F9 | Moyenne | Clés et secrets de l'ESP8266 extractibles par accès physique (flash non chiffré) | Atténué : compte MQTT dédié à ACL minimale, révocable (§4) |
| F10 | Basse | `node_id` non validé (injection dans le nom de fichier CSV) | **Corrigé** : motif strict |
| F11 | Basse | Injection de fausses lignes dans les journaux via identifiant/User-Agent | **Corrigé** : caractères de contrôle neutralisés |
| F12 | Basse | Bannière `Server: uvicorn`, en-têtes COOP/CORP/Permissions-Policy absents, `/docs` public | **Corrigé** (`API_DOCS=off` en production) |
| F13 | Basse | Broker sans plafond de connexions ni de QoS | **Corrigé** : `max_connections 20`, `max_qos 1` |
| F14 | Basse | Sessions conservées après un redémarrage (saut d'horloge sans RTC) | **Corrigé** : toutes les sessions sont fermées au démarrage de l'API |
| F15 | Info | Génération des certificats avec une horloge fausse = certificats invalides | **Corrigé** : `gen-certs.sh` refuse si l'année < 2025 |

## 2. Résultats des vérifications (stack réelle)

Exécution de `./scripts/audit-security.sh` : **30 réussis, 0 en échec**.

- **Surface** : seuls `443`/`80` (proxy), `123/udp` (NTP) et `8883` sont publiés (l'API `8000` ne l'est pas) ; PostgreSQL et le MQTT en clair ne le sont pas ; chaque conteneur
  est en lecture seule, sans capacité Linux, `no-new-privileges`, hors root, avec limite mémoire ; pas de socket Docker montée.
- **Authentification** : les 41 routes de données refusent l'accès sans jeton ; le jeton de service ne peut pas administrer ;
  jeton en URL, schéma Basic, jetons `null`/vides refusés ; même réponse pour un compte inconnu et un mauvais mot de passe.
- **Entrées** : 8 familles de charges (SQL, traversée de chemin, XSS, log4shell, octet nul, 5 000 caractères…) sur 5 routes :
  aucune erreur 500 ni fuite ; `limit` borné ; corps > 64 Kio refusés ; snapshot > 2 Mio ou non JPEG refusés ; TRACE refusé.
- **Navigateur** : CSP `script-src 'self'`, `frame-ancestors 'none'`, `nosniff`, `no-store`, CORS fermé, aucun jeton dans le JavaScript.
- **MQTT** : anonyme, mauvais mot de passe, TLS 1.1 et client sans vérification de la CA refusés ; TLS 1.2/1.3 + identifiants
  valides acceptés (contrôle positif) ; l'ESP ne peut ni publier sur `sentinel/commands` ni espionner via `#` ; paquet > 4 Kio rejeté.
- **Brute force / intrusion** (tests unitaires et scénario de bout en bout) : verrouillage au 5ᵉ échec, blocage d'IP (20 échecs
  ou 6 identifiants différents), alerte `INTRUSION_DETECTED` dans le dashboard, rejeu de code TOTP refusé, réponse 429 sur toute l'API.

## 3. Secrets dans Git (F1) — à traiter avant le rendu

Le sujet exige « aucun secret ni clé d'authentification en clair » dans l'archive du code.

1. Fait : les secrets du firmware sont dans `firmware/sentinel_core/secrets.h` (ignoré ; modèle `secrets.h.example`) ;
   le mot de passe Wi-Fi de l'ancien firmware `src/config.h` est remplacé.
2. Les anciennes valeurs MQTT/jeton **ne sont plus valides** (le `.env` a été régénéré) mais restent dans l'historique, ainsi que
   `sentinel2026` et un ancien jeton par défaut. Pour purger l'historique avant le rendu (réécriture : coordonner l'équipe) :
   `git filter-repo --path firmware/sentinel_core/config.h --path src/config.h --invert-paths` puis recréer ces fichiers, ou
   simplement rendre l'archive à partir d'un dépôt neuf. **Changer le mot de passe du Wi-Fi** dans tous les cas.
3. Après `gen-env.sh --force`, régénérer `secrets.h` et **reflasher l'ESP** (nouveaux mot de passe MQTT et jeton).
   Après un changement de CA, recopier `mosquitto/certs/ca_cert.h` vers `firmware/sentinel_core/ca_cert.h`.

## 4. Audit du matériel (`hardware/`, câblage, firmware)

| # | Gravité | Constat | Recommandation |
|---|---|---|---|
| H1 | Haute | **Sortie analogique du MQ-2 alimenté en 5 V reliée à `A0`** : AO peut dépasser 3,3 V (limite de l'entrée du NodeMCU) | **Corrigé dans le schéma v3.0** : 1 kΩ + zener 3,3 V + 100 nF sur `A0` (la calibration actuelle du firmware reste valable) |
| H2 | Haute | **PIR HC-SR501 sur D3 (GPIO0) et alimenté en 3,3 V.** Sa sortie est *push-pull*, basse au repos : à chaque reset GPIO0 est lu à 0 → mode flash ; et le module exige 4,5-20 V, en 3,3 V la sortie est erratique | **Corrigé (schéma v3.0 + firmware, à valider sur le matériel)** : PIR en 5 V sur **D0 (GPIO16)** via 1 kΩ + pull-down 10 kΩ, découplage 100 µF/100 nF ; firmware avec chauffe de 60 s, filtre (4 lectures consécutives) et délai de 10 s entre alertes |
| H3 | Moyenne | **Aucun arrêt d'urgence physique** : l'arrêt d'urgence n'existe que par commande MQTT | Bouton d'arrêt d'urgence sur une entrée (interruption) coupant moteurs/alarme, indépendant du réseau |
| H4 | Moyenne | **Pas d'état sûr en cas de perte du serveur** : sas et alarme gardent leur dernier état ; pas de watchdog explicite | `ESP.wdtEnable`, fermeture du sas après N s sans nouvelles du serveur ; l'alarme gaz locale fonctionne déjà sans réseau (bien) |
| H5 | Moyenne | **Alimentation** : chauffage du MQ-2 (~150 mA) + 28BYJ-48 (~240 mA) + ESP8266 + OLED depuis l'USB d'un PC (500 mA) | Alimentation 5 V / 2 A dédiée, condensateur 470 µF près du moteur, masses communes |
| H6 | Moyenne | **Sécurité physique du boîtier** : UART/USB accessible = reflashage possible, flash non chiffré (F9) ; aucun contact d'ouverture | Contact d'ouverture (reed/tilt) sur une GPIO qui déclenche `INTRUSION_DETECTED`, vis cachées, mot de passe MQTT propre à l'appareil et révocable (`./scripts/gen-env.sh --force` puis reflash) |
| H7 | Basse | Buzzer 5 V piloté directement par GPIO15 (3,3 V) | **Corrigé dans le schéma v3.0** : transistor 2N2222 + 1 kΩ, pull-down 10 kΩ (D8 reste bas au boot), diode de roue libre |
| H8 | Basse | Schéma KiCad sans résistances ni découplage | **Corrigé** : schéma v3.0 complet, ERC KiCad à 0 violation |
| H9 | Info | Bon point : MQTTS avec CA épinglée, compte `esp32` limité à 3 topics en écriture / 2 en lecture, commandes réservées au compte `api` | — |

### Horloge et réseau isolé (heure non fiable)

- Le Pi n'a ni RTC ni Internet : l'ESP8266 interroge `SERVER_HOST` en NTP, **mais aucun serveur NTP n'est configuré dans le
  dépôt** (le pare-feu ouvre bien `123/udp`). Sans cela, la validation du certificat échoue (F4).
- Configuration `chrony` à ajouter sur le Pi (`/etc/chrony/chrony.conf`) :
  ```
  local stratum 10          # sert l'heure même sans source externe
  allow 192.168.10.0/24     # le Wi-Fi de la table
  makestep 1 3
  ```
  Régler l'heure une fois (`sudo date -s ...`) ou ajouter un module RTC DS3231 (quelques euros) qui la conserve.
- Conséquences d'une heure fausse : dates des certificats (désormais contrôlées par `gen-certs.sh`), codes 2FA (±30 s),
  horodatages du journal de sécurité et des télémétries. Ne pas activer la 2FA tant que l'heure n'est pas fiable.

## 5. Checklist du pentest croisé (jeudi) — ce qu'il faut pouvoir démontrer

À exécuter **sur notre propre table** pour préparer la défense, et à comparer avec le rapport des autres groupes :

1. `nmap -sV -p- 192.168.10.1` : seuls `22` (clé SSH uniquement), `80`, `443`, `8883` visibles.
2. Wireshark sur le Wi-Fi : le trafic MQTT est en *TLS application data* (aucune charge lisible) ; le dashboard est en HTTP
   (limite connue F8, d'où le Wi-Fi WPA2/3 isolé).
3. Tentative de connexion MQTT anonyme / sans CA / en TLS 1.1 : refusée (déjà prouvé par le script).
4. Brute force du dashboard : verrouillage puis blocage d'IP, alerte visible dans l'onglet Sécurité.
5. Flood de messages MQTT : `max_connections`, `max_packet_size`, ACL et limites mémoire des conteneurs ; vérifier que
   l'alarme locale de l'ESP continue de fonctionner (comportement hors réseau).
6. Redémarrer le Pi et l'ESP **à chaud** : le MQTTS se rétablit (NTP) et l'ESP ne reste pas bloqué en mode flash (H2).

## 6. Limites de cet audit

Les tests ont été faits depuis la machine hôte et le conteneur API sur une instance de développement ; ils ne remplacent
ni un pentest externe, ni la validation sur le matériel réel (H1, H2, H5 sont à mesurer au multimètre/oscilloscope).
Le script de vision (YOLO) et le système d'exploitation du Pi (`harden-host.sh` : UFW limité au Wi-Fi de la table, SSH par
clés, `PermitRootLogin no`) n'ont pas été exécutés ici.
