# ARCHITECTURE MATÉRIELLE & DISTRIBUÉE (DUAL-ESP8266)

## 1. Contexte du Sujet Sentinel-X
Conformément aux spécifications du cahier des charges (page 4 du sujet national) :
> *Module Microcontrôleur (ESP8266) : Catégorie IoT (1 à 2).*  
> *Usage : Centralise la collecte complète des données environnementales de la table et pilote les alertes physiques locales.*

Pour éviter les congestions de broches (GPIO) et séparer proprement les domaines de sécurité, l'infrastructure embarquée Sentinel-X est découpée en **2 nœuds Edge spécialisés**.

```
                           +-------------------------------------+
                           |         PC SERVEUR LOCAL            |
                           |   (API REST / MQTT Mosquitto / IA)  |
                           +-------------------------------------+
                                      ^                 ^
                                      | Wi-Fi (HTTP)    | Wi-Fi (MQTT)
                                      v                 v
            +---------------------------------+   +---------------------------------+
            |       ESP8266 NOEUD #1          |   |       ESP8266 NOEUD #2          |
            |     [SENTINEL-X-ENV]            |   |     [SENTINEL-X-ACCESS]         |
            +---------------------------------+   +---------------------------------+
            | - Écran OLED HW-416A (I2C)      |   | - Moteur Pas-à-Pas 28BYJ-48     |
            | - Capteur de Gaz MH-MQ (Analog) |   | - Contrôleur de Puissance ULN   |
            | - Capteur V182 Temp/Hum (DHT)   |   | - Lecteur de Badges RFID-RC522  |
            | - Module LED KS RGB (Statuts)   |   | - Fin de course / Sas physique  |
            | - Buzzer d'Alarme YXDZ          |   |                                 |
            +---------------------------------+   +---------------------------------+
```

---

## 2. Rôles et Responsabilités des Nœuds

### A. ESP #1 — "Sentinel-Env" (Surveillance Environnementale)
* **Captation fine** : Lit la température, l'humidité et les concentrations de gaz/fumées en continu.
* **Affichage Local** : Présente l'adresse IP locale attribuée, le statut réseau et les métriques d'usine sur l'écran OLED.
* **Alertes Physiques Immédiates** : Déclenche localement le buzzer et la LED KS RGB en cas de dépassement de seuil d'urgence.
* **Flux Données** : Transmet la télémétrie horodatée vers le serveur pour alimenter l'algorithme d'IA prédictive (Scikit-Learn).

### B. ESP #2 — "Sentinel-Access" (Contrôle d'Accès & Actionneurs Lourds)
* **Filtrage Physique** : Authentifie les badges des agents via le module RFID-RC522.
* **Motorisation Industrielle** : Actionne le moteur pas-à-pas 28BYJ-48 pour simuler l'ouverture/fermeture sécurisée d'un sas d'évacuation ou d'une barrière d'accès.
* **Réaction aux Ordres Serveur** : Capable de verrouiller immédiatement le sas physique sur instruction d'urgence émise par le PC Serveur.
