# PLAN DE CÂBLAGE COMPLET & SÉCURISÉ — ESP32 CENTRALISÉ

## 1. Broches Réparties sur l'ESP32

| Composant | Rôle | Broche ESP32 | Nom / Type de Broche |
| :--- | :--- | :--- | :--- |
| **Bus I2C** (Écran OLED + MCP23017) | SCL (Horloge)<br>SDA (Données) | **GPIO 22**<br>**GPIO 21** | I2C Standard ESP32 |
| **Lecteur RFID-RC522** (SPI) | 3.3V & GND<br>RST (Reset)<br>SDA (SS / Chip Select)<br>MOSI<br>MISO<br>SCK | **3V3** & **GND**<br>**GPIO 4**<br>**GPIO 5**<br>**GPIO 23**<br>**GPIO 19**<br>**GPIO 18** | SPI VSPI Standard ESP32 |
| **Capteur de Gaz MH-MQ** | AO (Sortie Analogique) | **GPIO 34** | ADC1_CH6 (Entrée analogique propre) |
| **Capteur V182 Temp/Hum (DHT)** | DATA | **GPIO 14** | GPIO Digital bidirectionnel |
| **Capteur de Présence (PIR)** | OUT (Signal Présence) | **GPIO 13** | GPIO Digital avec interruption |
| **Module LED KS RGB** | Rouge (R)<br>Vert (G)<br>Bleu (B) | **GPIO 25**<br>**GPIO 26**<br>**GPIO 27** | Sorties PWM DAC / LEDC |
| **Buzzer d'Alarme YXDZ** | + (Signal d'alarme) | **GPIO 33** | Sortie PWM LEDC |

---

## 2. Broches du MCP23017 pour les Moteurs Pas-à-Pas (ULN2003)

L'expanseur MCP23017 fournit 16 broches (Port A et Port B). Chaque moteur pas-à-pas 28BYJ-48 consomme 4 broches :

| Périphérique | Rôle Mécanique | Broches MCP23017 | Entrées Drivers ULN2003 |
| :--- | :--- | :--- | :--- |
| **Moteur #1** | **Sas d'Accès Principal** (Ouverture/Fermeture) | **GPA0, GPA1, GPA2, GPA3** | IN1, IN2, IN3, IN4 (Driver 1) |
| **Moteur #2** | **Vanne de Coupure Gaz d'Urgence** | **GPA4, GPA5, GPA6, GPA7** | IN1, IN2, IN3, IN4 (Driver 2) |
| **Moteur #3** | **Barrière Véhicule / Périmètre** | **GPB0, GPB1, GPB2, GPB3** | IN1, IN2, IN3, IN4 (Driver 3) |
| **Moteur #4** | **Trappe de Ventilation / Désenfumage** | **GPB4, GPB5, GPB6, GPB7** | IN1, IN2, IN3, IN4 (Driver 4) |

---

## 3. Schéma des Alimentations & Rails Électriques

```
 [ALIMENTATION EXTERNE 5V 2A-3A] 
               |
               +=====================> Rail 5V Puissance (Drivers ULN2003, Capteur MQ)
               |
 [ESP32 VIN] <-+ (Reçoit le 5V propre)
      |
   [3.3V ESP32] =====================> Rail 3.3V Logique (OLED, RFID-RC522, V182, MCP23017)
      |
    [GND] ===========================> MASSE COMMUNE (Relier toutes les masses ensemble)
```

> [!CAUTION]
> **Règle absolue pour le RFID-RC522** : Ce module doit TOUJOURS être alimenté sur le rail **3.3V**. Une alimentation 5V détruit immédiatement la puce RC522.
