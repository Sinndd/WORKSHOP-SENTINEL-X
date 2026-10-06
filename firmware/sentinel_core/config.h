#ifndef CONFIG_H
#define CONFIG_H

#include <Arduino.h>

// =========================================================
// SECRETS (Wi-Fi, mot de passe MQTT, jeton d'appareil) : secrets.h, ignoré par Git
// (modèle : secrets.h.example)
// =========================================================
#include "secrets.h"

#define SERVER_HOST       "10.69.127.115"
#define HTTP_PORT         8000
#define MQTT_PORT         8883            // MQTTS chiffré TLS selon CONTRAT-MQTT § 1
#define MQTT_USER         "esp32"

#define NODE_ID           "SENTINEL-X-CORE"

#define TOPIC_TELEMETRY   "sentinel/telemetry"
#define TOPIC_ALERTS      "sentinel/alerts"
#define TOPIC_ACCESS      "sentinel/access"
#define TOPIC_COMMANDS    "sentinel/commands"
#define TOPIC_RESPONSE    "sentinel/access/response"
#define TOPIC_ENROLL      "sentinel/enroll"        // résultat d'un enrôlement de badge (ESP32 -> API)

#define DOOR_ID           "AIRLOCK_MAIN"

#if defined(ESP32)
// ==========================================
// PINOUT ESP32 DevKit (noms sérigraphiés = numéros GPIO) — docs/esp32_centralise/02_PINOUT_ET_CABALAGE.md
// ==========================================
#define PIN_I2C_SDA       21  // D21
#define PIN_I2C_SCL       22  // D22
#define OLED_ADDR         0x3C

#define PIN_GAS_MQ        34  // D34 (ADC1, entrée seule) : jamais ADC2, inutilisable avec le Wi-Fi
#define GAS_ALARM_RAW     600 // seuil d'alarme gaz sur 0-4095 (équivalent du 150/1023 de l'ESP8266)
#define PIN_DHT           14  // D14
#define PIN_PIR           13  // D13

#define PIN_RGB_R         25  // D25
#define PIN_RGB_G         26  // D26
#define PIN_RGB_B         27  // D27
#define PIN_BUZZER        33  // D33 (via le transistor du schéma v3.0)

// Lecteur RFID RC522 (SPI, 3,3 V uniquement)
#define PIN_RFID_SS       5   // D5  (SDA)
#define PIN_RFID_RST      4   // D4
#define PIN_RFID_SCK      18  // D18
#define PIN_RFID_MISO     19  // D19
#define PIN_RFID_MOSI     23  // D23

// Moteur de la trappe : 28BYJ-48 + ULN2003 (demi-pas). Les 4 fils IN1..IN4 dans cet ordre.
#define PIN_MOTOR_IN1     32  // D32
#define PIN_MOTOR_IN2     15  // D15
#define PIN_MOTOR_IN3     2   // D2
#define PIN_MOTOR_IN4     12  // D12
#define TRAP_STEPS        1024      // demi-pas pour ouvrir la trappe (4096 = 1 tour ; 1024 ~ 90 degres) : à ajuster
#define TRAP_STEP_US      3000      // délai entre deux demi-pas (3 ms : fiable pour un 28BYJ-48)
#define TRAP_HOLD_MS      5000      // trappe ouverte après un badge accepté, puis refermée
#define TRAP_REMOTE_HOLD_MS 30000   // ouverture ordonnée par le serveur sans durée : refermée au bout de ce délai

// Mode écriture (enrôlement d'un badge) : déclenché depuis le tableau de bord (ordre ENROLL_BADGE du serveur).
// Le bouton BOOT sert seulement à l'annuler ; ENROLL_FROM_BUTTON 1 réactive l'appui long (3 s) comme déclencheur local.
#define PIN_BOOT          0
#define ENROLL_FROM_BUTTON 0
#define ENROLL_HOLD_MS    3000      // durée de l'appui (si ENROLL_FROM_BUTTON)
#define ENROLL_WINDOW_MS  30000     // durée par défaut de la fenêtre d'écriture
#else
// ==========================================
// PINOUT VALIDÉ SUR TON ESP8266
// ==========================================
#define PIN_I2C_SDA       4   // D2 (GPIO4)
#define PIN_I2C_SCL       5   // D1 (GPIO5)
#define OLED_ADDR         0x3C

#define PIN_GAS_MQ        A0  // A0 (ADC0)
#define GAS_ALARM_RAW     150 // seuil d'alarme gaz sur 0-1023
#define PIN_DHT           2   // D4 (GPIO2)
#define PIN_PIR           16  // D0 (GPIO16) : libre, aucun rôle au boot (GPIO0/D3 = mode flash si LOW)

#define PIN_RGB_B         14  // D5 (GPIO14)
#define PIN_RGB_G         12  // D6 (GPIO12)
#define PIN_RGB_R         13  // D7 (GPIO13)
#define PIN_BUZZER        15  // D8 (GPIO15)
#endif

#endif // CONFIG_H
