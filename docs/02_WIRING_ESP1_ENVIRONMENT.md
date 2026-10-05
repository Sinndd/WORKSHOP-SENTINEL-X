# PLAN DE CÂBLAGE : ESP #1 (SENTINEL-ENV)

Ce document décrit le câblage complet et validé pour le premier microcontrôleur ESP8266 dédié à la collecte environnementale et aux alertes de table.

---

## 1. Schéma Visuel de la Breadboard

```
        ESP8266 (NodeMCU)                          Périphériques & Capteurs
      +-------------------+
      |                A0 |<------------------------- [AO] Capteur de Gaz MH-MQ
      |                   |
      |          (GPIO5)  | D1 ---------------------> [SCL] Écran OLED HW-416A (SSD1306)
      |          (GPIO4)  | D2 ---------------------> [SDA] Écran OLED HW-416A (SSD1306)
      |          (GPIO0)  | D3 <--------------------- [OUT] Capteur de Présence PIR
      |          (GPIO2)  | D4 <--------------------- [DATA] Capteur Temp/Hum V182 (DHT)
      |          (GPIO14) | D5 ---------------------> [B]   LED KS RGB (Canal Bleu)
      |          (GPIO12) | D6 ---------------------> [G]   LED KS RGB (Canal Vert)
      |          (GPIO13) | D7 ---------------------> [R]   LED KS RGB (Canal Rouge)
      |          (GPIO15) | D8 ---------------------> [+]   Buzzer Actif YXDZ
      |                   |
      |               3V3 |=========================> Rail Rouge (+) 3.3V (OLED, V182, RGB)
      |               GND |=========================> Rail Bleu (-) Masse Commune
      |          VIN (5V) |=========================> VCC Capteur MQ & Buzzer
      +-------------------+
```

---

## 2. Tableau Broche par Broche

| Composant | Broche Composant | Broche ESP8266 | Alimentation requise | Remarque technique |
| :--- | :--- | :--- | :--- | :--- |
| **Écran OLED HW-416A** | **VCC**<br>**GND**<br>**SCL**<br>**SDA** | **3V3**<br>**GND**<br>**D1** (GPIO5)<br>**D2** (GPIO4) | 3.3V | Adresse I2C : `0x3C`. Affiche l'adresse IP et les valeurs de capteurs. |
| **Capteur Gaz MH-MQ** | **VCC**<br>**GND**<br>**AO** (Analog Out)<br>*DO* | **VIN (5V)** (ou 3V3)<br>**GND**<br>**A0** (ADC0)<br>*Non connecté* | 5V recommandé | La résistance interne a besoin d'énergie pour chauffer et réagir au gaz. |
| **Capteur V182 (DHT)** | **+ / VCC**<br>**- / GND**<br>**S / DATA** | **3V3**<br>**GND**<br>**D4** (GPIO2) | 3.3V | Lecture cadencée toutes les 2 secondes. |
| **Capteur de Présence** | **VCC**<br>**GND**<br>**OUT** | **3V3** ou **VIN**<br>**GND**<br>**D3** (GPIO0) | 3.3V / 5V | Détection infrarouge / intrusion dans la zone critique. |
| **Module LED KS RGB** | **- (GND)**<br>**B (Blue)**<br>**G (Green)**<br>**R (Red)** | **GND**<br>**D5** (GPIO14)<br>**D6** (GPIO12)<br>**D7** (GPIO13) | 3.3V | Cathode commune. Permet d'afficher l'état nominal (Vert), réseau (Bleu) et incident (Rouge). |
| **Buzzer YXDZ** | **+ (Signal)**<br>**- (GND)** | **D8** (GPIO15)<br>**GND** | 3.3V / 5V | Bip d'alerte cadencé ou mélodie d'alarme d'usine. |

---

## 3. Matrice des Couleurs d'État (Module KS RGB)

* **Vert permanent** : Statut nominal, aucune fuite ni anomalie détectée.
* **Bleu** : Établissement de la connexion Wi-Fi / Échange avec le PC Serveur.
* **Jaune / Orange (Vert + Rouge)** : Pré-alerte fuite lente (Maintenance prédictive IA).
* **Rouge clignotant + Buzzer strident** : Alarme critique immédiate (Gaz toxique / Intrusion).
