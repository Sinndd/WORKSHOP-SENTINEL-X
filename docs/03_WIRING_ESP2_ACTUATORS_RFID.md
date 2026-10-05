# PLAN DE CÂBLAGE : ESP #2 (SENTINEL-ACCESS)

Ce document décrit le câblage du second microcontrôleur ESP8266 dédié à la motorisation du sas physique et au filtrage d'accès par radio-identification (RFID).

---

## 1. Schéma Visuel de la Breadboard

```
        ESP8266 (NodeMCU #2)                       Actionneurs & Périphériques
      +----------------------+
      |         (GPIO5)  D1  |---------------------> [IN1] Contrôleur Moteur ULN2003
      |         (GPIO4)  D2  |---------------------> [IN2] Contrôleur Moteur ULN2003
      |         (GPIO14) D5  |---------------------> [IN3] Contrôleur Moteur ULN2003
      |         (GPIO12) D6  |---------------------> [IN4] Contrôleur Moteur ULN2003
      |                      |
      |         (GPIO13) D7  |---------------------> [MOSI] Module RFID-RC522
      |         (GPIO12) D6* |---------------------> [MISO] Module RFID-RC522 (ou partagé)
      |         (GPIO15) D8  |---------------------> [SDA/SS] Module RFID-RC522
      |         (GPIO0)  D3  |---------------------> [RST] Module RFID-RC522
      |                      |
      |                  3V3 |=====================> VCC Module RFID (ATTENTION : STRICTEMENT 3.3V)
      |                  GND |=====================> Rail Bleu (-) Masse Commune
      |             VIN (5V) |=====================> VCC Contrôleur ULN2003 (Moteur 5V)
      +----------------------+
```

---

## 2. Câblage du Moteur Pas-à-Pas 28BYJ-48 via Driver ULN2003

Le moteur 28BYJ-48 consommant environ 250 à 300 mA, son alimentation doit impérativement provenir de la broche **VIN (5V de l'USB)** pour disposer d'un couple suffisant :

| Broche Contrôleur ULN2003 | Broche ESP8266 | Rôle |
| :--- | :--- | :--- |
| **IN1** | **D1** (GPIO5) | Bobine 1 (Fil Bleu du moteur) |
| **IN2** | **D2** (GPIO4) | Bobine 2 (Fil Rose du moteur) |
| **IN3** | **D5** (GPIO14) | Bobine 3 (Fil Jaune du moteur) |
| **IN4** | **D6** (GPIO12) | Bobine 4 (Fil Orange du moteur) |
| **+ (5V)** | **VIN** (5V) | Alimentation de puissance commune (Fil Rouge) |
| **- (GND)** | **GND** | Masse |

### Correspondance des 5 fils du moteur 28BYJ-48 :
* **Rouge** : Alimentation commune (+5V)
* **Bleu** : Phase A ➔ IN1
* **Rose** : Phase B ➔ IN2
* **Jaune** : Phase C ➔ IN3
* **Orange** : Phase D ➔ IN4

---

## 3. Câblage du Lecteur de Badges RFID-RC522 (SPI)

> [!CAUTION]
> **Le module RC522 fonctionne STRICTEMENT sous 3.3V !**  
> Ne jamais le brancher sur le 5V/VIN sous peine de détruire irrémédiablement la puce RFID.

| Broche RC522 | Broche ESP8266 | Rôle SPI |
| :--- | :--- | :--- |
| **3.3V** | **3V3** | Alimentation logique 3.3V |
| **GND** | **GND** | Masse commune |
| **RST** | **D3** (GPIO0) | Reset du module RFID |
| **SDA (SS)** | **D8** (GPIO15) | Sélecteur d'esclave SPI (Slave Select) |
| **MOSI** | **D7** (GPIO13) | Master Out Slave In |
| **MISO** | **D6** (GPIO12) | Master In Slave Out |
| **SCK** | **D5** (GPIO14) | Horloge SPI (Clock) |
