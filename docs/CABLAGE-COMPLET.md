# SENTINEL-X — câblage complet (ESP32 DevKit + MCP23017)

## 1. Rails d'alimentation
| Rail | Source | Alimente |
|---|---|---|
| **5 V puissance** | bloc externe 5 V, 3 A mini | 3 servos, ULN2003, MQ-2, HC-SR501, buzzer, VIN de l'ESP32 |
| **3V3** | régulateur de l'ESP32 | OLED, DHT22, RC522, MCP23017, RESET du MCP |
| **GND commun** | tout est relié ensemble | bloc 5 V, ESP32, MCP, RC522, capteurs, servos, ULN2003 |

- Condensateur 470–1000 µF entre 5 V et GND, près des servos. Condensateur 100 µF près du RC522.
- Ne jamais alimenter les servos depuis l'ESP32 ou l'USB. Pas d'USB branché en même temps que le VIN.
- Le RC522 est **3,3 V uniquement** : le 5 V le détruit.

## 2. Bus I2C (D21 = SDA, D22 = SCL), partagé
| Module | Adresse | VCC | Notes |
|---|---|---|---|
| OLED SSD1306 | 0x3C | 3V3 | |
| MCP23017 | 0x20 | 3V3 | RESET → 3V3, A0 A1 A2 → GND |

## 3. Table des broches ESP32
| GPIO | Fonction | Composant |
|---|---|---|
| D21 / D22 | SDA / SCL | OLED + MCP23017 |
| D14 | DHT22 data | + résistance 10 kΩ vers 3V3 |
| D13 | PIR OUT | HC-SR501 (sortie 3,3 V, alim 5 V) |
| D34 | MQ-2 AO | via pont diviseur (voir §5), entrée seule |
| D25 / D26 / D27 | LED RGB R / G / B | 220 Ω en série par couleur, cathode commune → GND |
| D33 | Buzzer | via transistor NPN (base 1 kΩ), buzzer sur le 5 V |
| D5 / D4 | RC522 SDA(SS) / RST | |
| D18 / D19 / D23 | RC522 SCK / MISO / MOSI | |
| D32 | Servo bras gauche (signal) | 220 Ω en série |
| D15 | Servo bras droit (signal) | 220 Ω en série |
| D2 | Servo trappe arrière (signal) | 220 Ω en série |
| D0 | Bouton BOOT | déjà sur la carte |
| D12 | libre | |
| D35, D36, D39 | libres (entrées seules) | |

## 4. MCP23017 — moteur de la tête
Sur beaucoup de modules, GPA0..GPA7 sont sérigraphiés **A0..A7** et GPB0..GPB7 **B0..B7** : "A1" = GPA1. Attention : ne pas confondre avec les 3 broches d'adresse (aussi nommées A0 A1 A2, souvent à part, avec cavaliers/pastilles) qui restent à la masse.

| MCP23017 | ULN2003 (28BYJ-48) |
|---|---|
| GPA0 | IN1 |
| GPA1 | IN2 |
| GPA2 | IN3 |
| GPA3 | IN4 |
| GPA4..7, GPB0..7 | libres (extension) |

ULN2003 : + → 5 V puissance, − → GND commun. Moteur sur le connecteur blanc.

## 5. Détail des capteurs
- **MQ-2** : VCC 5 V, GND. AO peut monter à 5 V mais l'ADC de l'ESP32 supporte 3,3 V max : pont diviseur AO → 10 kΩ → D34 → 15 kΩ → GND. Chauffe ~60 s au démarrage. Ne pas utiliser la sortie DO.
- **HC-SR501** : VCC 5 V, GND, OUT → D13. Chauffe ~60 s. Régler les potentiomètres (sensibilité / délai) au mini pour les tests.
- **DHT22** : VCC 3V3, GND, DATA → D14, 10 kΩ entre DATA et 3V3.
- **RC522** : 3V3, GND, SDA → D5, SCK → D18, MOSI → D23, MISO → D19, RST → D4. IRQ non connecté.
- **Servos MS18** : orange → signal (via 220 Ω), rouge → 5 V puissance, marron → GND commun.
- **Buzzer** : + au 5 V, − au collecteur d'un NPN (2N2222), émetteur → GND, base → D33 via 1 kΩ. Buzzer magnétique : diode 1N4148 en inverse en parallèle.

## 6. Ordre de montage conseillé
1. Alimentation + GND commun + condensateurs, sans rien d'autre.
2. I2C : OLED, puis MCP23017 (test `firmware/test_mcp23017`).
3. Capteurs : DHT22, MQ-2, PIR.
4. RC522, LED RGB, buzzer (test `firmware/test_banc_esp32`).
5. Servos en dernier, un par un, et le 28BYJ-48.
