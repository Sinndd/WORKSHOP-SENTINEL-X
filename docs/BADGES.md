# Badges RFID : enrôlement, ouverture de la trappe, résistance à la copie

Firmware : `firmware/sentinel_core` (ESP32 + RC522). Badges : MIFARE Classic 1K.

## Fonctionnement

**Enrôlement depuis le tableau de bord** (page **Badges**, rôles opérateur et administrateur) : saisir l'utilisateur (titulaire), le niveau d'accès et
l'ouverture automatique de la trappe, puis « Lancer l'enrôlement ». L'API envoie l'ordre `ENROLL_BADGE` à l'ESP32, qui passe en **mode écriture**
(écran « MODE ECRITURE », LED bleue clignotante, 30 à 120 s) : poser un badge **vierge** (clés d'usine) ou un badge déjà enrôlé par cet appareil.
Le firmware écrit dans le secteur 1 du badge un contenu signé et protège le secteur avec des clés propres à ce badge ; **deux bips = écrit**.
L'ESP32 renvoie l'UID sur `sentinel/enroll` et l'API **rattache automatiquement le badge à l'utilisateur** (il est actif tout de suite).
Le même écran permet de **changer le titulaire**, le niveau ou l'ouverture automatique d'un badge, de le **révoquer** ou de le réactiver.
Le bouton BOOT sert seulement à annuler (appui court) ; `ENROLL_FROM_BUTTON 1` dans `config.h` rétablit l'appui long (3 s) comme déclencheur local.

En ligne de commande : `POST /api/v1/enrollments` (`{"user_name":"...","clearance_level":"LEVEL_2","auto_unlock_door":true,"duration_s":30}`), suivi par
`GET /api/v1/enrollments/{id}`, annulation par `DELETE`.

**Mode normal** : à chaque passage, l'ESP32 vérifie le badge (clé, signature, compteur), l'envoie au serveur (`sentinel/access`), et **la trappe ne s'ouvre
que si le serveur accepte ET que la vérification locale est valide**. Le moteur ouvre la trappe (`TRAP_STEPS`), la maintient `TRAP_HOLD_MS`, puis la referme.
Sans serveur (hors ligne), la trappe ne s'ouvre pas.

## Ce que contient un badge enrôlé

| Bloc | Contenu |
|---|---|
| 4 | `"SX"`, compteur (4 octets), signature HMAC-SHA256 tronquée (10 octets), écrits en une seule opération |
| 5 | nonce aléatoire de 16 octets, propre au badge |
| 7 | clé A, droits d'accès `78 77 88 C1`, clé B (lecture par A ou B, écriture par B seule ; clés jamais lisibles) |

Les clés A et B sont dérivées de `CARD_MASTER_KEY` (`secrets.h`) et de l'UID du badge. La signature couvre l'UID, le nonce et le compteur.

## Ce que cela empêche, et ce que cela n'empêche pas

| Attaque | Résultat |
|---|---|
| Badge inconnu, vierge, ou badge d'un autre système | refusé (« non enrôlé ») |
| Copie de l'UID seul (carte « magic ») | refusée : le contenu signé et les clés manquent |
| Contenu modifié à la main | refusé : signature invalide |
| **Copie complète du badge** (clés récupérées, par exemple en espionnant la lecture avec un Proxmark) utilisée **après** un passage du vrai badge | **détectée** : compteur trop ancien, alerte `UNAUTHORIZED_ACCESS` (`RFID_CLONE`), copie refusée |
| Copie complète utilisée **avant** que le vrai badge ne repasse | **acceptée une fois**, puis le vrai badge est refusé et l'alerte se déclenche : la fraude est détectée après coup |

**Un badge MIFARE Classic n'est pas infalsifiable** : son chiffrement (Crypto1) est cassé. Le compteur tournant rend la copie détectable, pas impossible.
Pour une vraie résistance à la copie, il faut un badge avec authentification cryptographique **AES** (NTAG 424 DNA, MIFARE DESFire EV2/EV3) et un lecteur PN532
(le RC522 ne sait pas les lire).

## Précautions

- **Sauvegarder `CARD_MASTER_KEY`** (hors Git). Sans elle, les badges enrôlés sont définitivement verrouillés : leurs clés ne sont dérivables que depuis elle.
- Changer cette clé invalide tous les badges enrôlés.
- Le compteur est conservé dans la mémoire de l'ESP32 : reflasher la carte avec « effacer la flash » le remet à zéro (un badge au compteur plus avancé est alors refusé).
- La clé maîtresse est dans la flash de l'ESP32, non chiffrée par défaut : quelqu'un qui a la carte en main peut la lire (chiffrement de flash ESP32 possible).
