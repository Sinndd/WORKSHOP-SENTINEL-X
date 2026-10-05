# ARCHITECTURE GLOBALE — NOEUD UNIQUE ESP32 & EXPANSION I2C

## 1. Contexte & Choix Technologique
Pour piloter l'intégralité du banc de surveillance industrielle **SENTINEL-X** au sein d'un boîtier unique tout en gérant de multiples actionneurs (moteurs, sas, alertes) et capteurs (ambiance, présence, RFID), le système utilise :
1. **Un microcontrôleur unique haute performance (ESP32)** :
   - Dual-Core Xtensa LX6 @ 240MHz
   - Multiples interfaces matérielles natives (Bus SPI pour le RFID, Bus I2C pour l'affichage et l'extension, multiples canaux ADC 12 bits et PWM).
   - Pile réseau Wi-Fi 802.11 b/g/n sécurisée avec accélération cryptographique matérielle (TLS/HTTPS/MQTTS).
2. **Un expanseur de GPIO I2C (MCP23017)** :
   - Partage les 2 broches du bus I2C (SDA/SCL) avec l'écran OLED.
   - Fournit **16 sorties logiques indépendantes** pour décharger l'ESP32 et piloter jusqu'à **4 moteurs pas-à-pas** simultanément sans aucune gigue (jitter).
3. **Un lecteur RFID-RC522 (Protocole SPI)** :
   - Assure l'authentification physique des agents de sécurité et techniciens AetherCorp avec journalisation immédiate.

---

## 2. Synoptique du Système Industriel

```
 +---------------------------------------------------------------------------------------+
 |                                  PC SERVEUR LOCAL                                     |
 |                   (Docker-Compose : API FastAPI/Node, Mosquitto, IA)                  |
 +---------------------------------------------------------------------------------------+
                                        ^           |
       Télémétrie & Alertes (Wi-Fi/HTTP/MQTT)       | Commandes Superviseur (MQTT)
                                        |           v
 +---------------------------------------------------------------------------------------+
 |                              MODULE UNIQUE ESP32                                      |
 +---------------------------------------------------------------------------------------+
   |             |                     |                         |
   | Bus SPI     | Bus I2C             | Entrées Directes        | Sorties Directes
   v             v                     v                         v
 [RFID-RC522]  +-------------------+ [Capteur Gaz MH-MQ]       [LED KS RGB]
 (Badges)      | Écran OLED (0x3C) | (Broche ADC GPIO34)       (GPIO 25, 26, 27)
               | Expanseur MCP23017| [Capteur V182 Temp/Hum]   [Buzzer YXDZ]
               +-------------------+ (Broche GPIO 14)          (PWM GPIO 33)
                         |           [Capteur Présence PIR]
                         |           (Broche GPIO 13)
                         v
               [Drivers ULN2003]
               (4 Moteurs Pas-à-Pas 28BYJ-48 : Sas, Barrières, Vannes)
```
