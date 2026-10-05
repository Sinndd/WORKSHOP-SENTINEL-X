# MISSION SENTINEL-X — DOCUMENTATION TECHNIQUE MATÉRIELLE & IOT

Ce dossier regroupe l'ensemble des documentations techniques, des plans de câblage et des spécifications matérielles validés sur banc d'essai pour le projet **SENTINEL-X** (Workshop National EPSI Bac+4).

---

## 📚 Sommaire de la Documentation

1. [**Architecture Matérielle Globale (Dual-ESP8266)**](./01_ARCHITECTURE_IOT.md) :
   - Répartition des rôles entre l'**ESP #1 (Sentinel-Env)** et l'**ESP #2 (Sentinel-Access)**.
   - Respect strict du cahier des charges national (limite de 1 à 2 microcontrôleurs).
2. [**Plan de Câblage ESP #1 — Télémétrie & Alertes Physiques**](./02_WIRING_ESP1_ENVIRONMENT.md) :
   - Schéma broche à broche pour l'Écran OLED HW-416A (SSD1306), le Capteur de Gaz MH-MQ, le Capteur V182 (DHT) et la Détection de présence.
   - Câblage sécurisé du Module LED KS RGB et du Buzzer d'alerte YXDZ (zéro conflit au boot).
3. [**Plan de Câblage ESP #2 — Sas Automatisé & Contrôle d'Accès**](./03_WIRING_ESP2_ACTUATORS_RFID.md) :
   - Pilotage de puissance du Moteur Pas-à-Pas 28BYJ-48 via le contrôleur ULN2003.
   - Intégration du lecteur RFID-RC522 (Protocole SPI).
4. [**Guide de Précautions & Résolution de Pannes (Troubleshooting)**](./04_TROUBLESHOOTING_BOOT_PINS.md) :
   - Explication des broches de strapping ESP8266 (D3/GPIO0, D4/GPIO2, D8/GPIO15).
   - Gestion des tensions (différenciation 3.3V logique vs 5V de puissance).
