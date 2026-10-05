#ifndef CONFIG_H
#define CONFIG_H

#include <Arduino.h>

// ==========================================
// IDENTIFIANTS RÉSEAU & SERVEUR (PI / AP)
// ==========================================
#define WIFI_SSID         "Google pixel 10 pro "
#define WIFI_PASS         "123456789"

#define SERVER_HOST       "10.69.127.207"
#define HTTP_PORT         8000
#define MQTT_PORT         1883            // Port standard MQTT (ou 8883)
#define MQTT_USER         "esp32"
#define MQTT_PASS         "esp32_secret"
#define API_DEVICE_TOKEN  "9BBpI8YAGq35AxpNe0b4WMiMQcqgbwiH"

#define NODE_ID           "SENTINEL-X-CORE"

// Topics MQTT officiels (cf CONTRAT-MQTT.md)
#define TOPIC_TELEMETRY   "sentinel/telemetry"
#define TOPIC_ALERTS      "sentinel/alerts"
#define TOPIC_ACCESS      "sentinel/access"
#define TOPIC_COMMANDS    "sentinel/commands"
#define TOPIC_RESPONSE    "sentinel/access/response"

// ==========================================
// PINOUT EXACT VALIDÉ SUR TON ESP8266
// ==========================================
// 1. Bus I2C (Écran OLED HW-416A SSD1306)
#define PIN_I2C_SDA       4   // D2 (GPIO4)
#define PIN_I2C_SCL       5   // D1 (GPIO5)
#define OLED_ADDR         0x3C

// 2. Capteurs
#define PIN_GAS_MQ        A0  // Entrée analogique A0 (ADC0)
#define PIN_DHT           2   // D4 (GPIO2) Capteur V182
#define PIN_PIR           0   // D3 (GPIO0) Capteur Présence PIR

// 3. Actionneurs d'alerte physiques
#define PIN_RGB_B         14  // D5 (GPIO14) LED KS Bleu
#define PIN_RGB_G         12  // D6 (GPIO12) LED KS Vert
#define PIN_RGB_R         13  // D7 (GPIO13) LED KS Rouge
#define PIN_BUZZER        15  // D8 (GPIO15) Buzzer Actif YXDZ

// 4. Moteur Pas-à-Pas 28BYJ-48 (sur Driver ULN2003)
#define MOTOR_PIN_IN1     5   // D1
#define MOTOR_PIN_IN2     4   // D2
#define MOTOR_PIN_IN3     14  // D5
#define MOTOR_PIN_IN4     12  // D6

#endif // CONFIG_H
