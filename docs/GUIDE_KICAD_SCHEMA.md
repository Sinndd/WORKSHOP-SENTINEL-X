# GUIDE DE CONCEPTION DU SCHÉMA ÉLECTRIQUE SOUS KICAD — SENTINEL-X

> **Schéma v3.0** : `hardware/kicad/SENTINEL-X.kicad_sch` est généré par `node hardware/kicad/gen_schematic.cjs` (symboles dans `SENTINEL.kicad_sym`, déclarés par `sym-lib-table`). Modifier le montage = modifier ce script puis le relancer ; ERC : `kicad-cli sch erc`. Les exports `docs/schema_electrique_kicad.svg/.pdf` sont à jour. Ce guide décrit la méthode manuelle d'origine ; en cas d'écart, le fichier KiCad fait foi (PIR sur **D0**, alimenté en **5 V**).

Ce document sert de feuille de route pas-à-pas pour dessiner le schéma électronique officiel dans **KiCad Schematic Editor (Eeschema)** pour le dossier technique du Workshop.

---

## 1. Liste des composants (Symbols) à ajouter dans KiCad

Appuie sur la touche **`A`** (Add Symbol) dans l'éditeur de schéma et cherche les composants suivants :

| Composant Réel | Symbole KiCad recommandé | Libellé / Valeur dans le schéma |
| :--- | :--- | :--- |
| **Microcontrôleur** | `NodeMCU1.0(ESP-12E)` ou `ESP8266-NodeMCU` ou `Conn_02x15_Odd_Even` | **U1 : ESP8266 NodeMCU** |
| **Écran OLED HW-416A** | `Conn_01x04_Pin` ou `Display_Graphic:SSD1306` | **DISP1 : OLED 0.96" I2C (128x64)** |
| **Capteur Gaz MH-MQ** | `Conn_01x04_Pin` ou `Sensor_Gas` | **SEN1 : MH-MQ Sensor** |
| **Capteur Temp/Hum V182** | `Sensor:DHT22` ou `Conn_01x03_Pin` | **SEN2 : V182 (DHT22)** |
| **Capteur Présence PIR** | `Conn_01x03_Pin` ou `Sensor_Motion:HC-SR501` | **SEN3 : PIR Presence** |
| **Module LED KS RGB** | `LED_RGB_KCOM` ou `Conn_01x04_Pin` | **D1 : KS RGB Module** |
| **Buzzer YXDZ** | `Device:Buzzer` | **BZ1 : Buzzer YXDZ 5V** |
| **Driver Moteur ULN2003**| `Interface_Expansion:ULN2003A` ou `Conn_01x06_Pin` | **U2 : ULN2003 Driver** |
| **Moteur Pas-à-Pas** | `Motor:Stepper_Motor_bipolar` ou `Conn_01x05_Pin` | **M1 : 28BYJ-48 5V DC** |
| **Alimentation** | Symboles d'alimentation globaux : `+3V3`, `+5V` (ou `VBUS`), `GND` | Rails d'alimentation |

---

## 2. Tableau d'Interconnexion des Fils (Netlist / Wiring)

Utilise l'outil fil (**touche `W`**) ou des **Net Labels (touche `L`)** pour relier les broches proprement :

### A. Alimentation & Masses (Power Symbols)
* Relie toutes les masses ensemble au symbole **`GND`** (ESP8266, OLED, MQ, V182, PIR, LED RGB, Buzzer, ULN2003).
* Relie les composants 3.3V au symbole **`+3V3`** :
  - Broche `3V3` de l'ESP8266
  - Broche `VCC` de l'OLED HW-416A
  - Broche `VCC` du V182
* Relie les composants de puissance au symbole **`+5V`** :
  - Broche `VIN` de l'ESP8266 (Alimentation 5V USB)
  - Broche `VCC` du Capteur MH-MQ (pour chauffer la résistance)
  - Broche `+` / `VCC` du Driver Moteur ULN2003

---

### B. Connexions des Signaux vers l'ESP8266 (U1)

| Broche ESP8266 | Nom Net Label (Touche L) | Destination |
| :--- | :--- | :--- |
| **D1** (GPIO5) | `I2C_SCL` | Broche **SCL** de l'écran OLED HW-416A |
| **D2** (GPIO4) | `I2C_SDA` | Broche **SDA** de l'écran OLED HW-416A |
| **D0** (GPIO16) | `PIR_SIG` | Broche **OUT** du Capteur de Présence PIR |
| **D4** (GPIO2) | `DHT_DATA` | Broche **DATA** du Capteur V182 (DHT22) |
| **D5** (GPIO14) | `RGB_BLUE` | Broche **B** du Module LED KS RGB |
| **D6** (GPIO12) | `RGB_GREEN` | Broche **G** du Module LED KS RGB |
| **D7** (GPIO13) | `RGB_RED` | Broche **R** du Module LED KS RGB |
| **D8** (GPIO15) | `BUZZER_SIG` | Broche **+** du Buzzer YXDZ |
| **A0** (ADC0) | `GAS_ANALOG` | Broche **AO** du Capteur de Gaz MH-MQ |

---

### C. Connexions Moteur (Option Sas de Sécurité)

| Broche Driver ULN2003 (U2) | Connexion |
| :--- | :--- |
| **IN1, IN2, IN3, IN4** | Reliés aux signaux de commande moteur |
| **Sorties 1 à 4** | Reliées au connecteur 5 broches du moteur 28BYJ-48 (Bleu, Rose, Jaune, Orange) |
| **COM / VCC** | Au rail **`+5V`** (Fil Rouge du moteur) |
| **GND** | Au **`GND`** |

---

## 3. Bonnes pratiques KiCad pour un rendu jury parfait

1. **Utiliser des Net Labels (`L`)** :
   Plutôt que de faire traverser des fils partout sur la feuille, place des étiquettes (ex: `I2C_SDA`, `GAS_ANALOG`). Le schéma sera aéré, lisible et ultra professionnel.
2. **Ajouter un cartouche (Title Block)** :
   En bas à droite du schéma, double-clique sur le cartouche pour renseigner :
   - Titre : `SENTINEL-X - Avant-Poste Industriel - Module Edge IoT`
   - Société : `AetherCorp Industrial Solutions / EPSI Workshop 2026`
   - Révision : `v2.0`
3. **Exportation pour le Dossier Technique** :
   Dans KiCad : **Fichier** ➔ **Exporter** ➔ **PDF** ou **SVG/PNG**. Tu obtiendras un schéma vectoriel net à insérer directement dans votre rapport PDF final !
