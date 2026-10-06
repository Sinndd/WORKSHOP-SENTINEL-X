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

// ==========================================
// PINOUT VALIDÉ SUR TON ESP8266
// ==========================================
#define PIN_I2C_SDA       4   // D2 (GPIO4)
#define PIN_I2C_SCL       5   // D1 (GPIO5)
#define OLED_ADDR         0x3C

#define PIN_GAS_MQ        A0  // A0 (ADC0)
#define PIN_DHT           2   // D4 (GPIO2)
#define PIN_PIR           16  // D0 (GPIO16) : libre, aucun rôle au boot (GPIO0/D3 = mode flash si LOW)

#define PIN_RGB_B         14  // D5 (GPIO14)
#define PIN_RGB_G         12  // D6 (GPIO12)
#define PIN_RGB_R         13  // D7 (GPIO13)
#define PIN_BUZZER        15  // D8 (GPIO15)

#endif // CONFIG_H
