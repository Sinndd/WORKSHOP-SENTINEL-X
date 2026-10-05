#ifndef CONFIG_H
#define CONFIG_H

#include <Arduino.h>

// ==========================================
// CONFIGURATION RESEAU & WI-FI (Table EPSI)
// ==========================================
const char* const WIFI_SSID     = "SENTINEL_AP";
const char* const WIFI_PASSWORD = "AetherCorp2050Secure!";

// ==========================================
// CONFIGURATION SERVEUR LOCAL (PC ou RPi 5)
// ==========================================
const char* const SERVER_HOST        = "192.168.10.1"; 
const uint16_t    SERVER_PORT        = 8000;          // Port de l'API REST
const char* const ALERT_ENDPOINT     = "/api/v1/alerts";
const char* const TELEMETRY_ENDPOINT = "/api/v1/telemetry";

// Option MQTT (Broker Mosquitto)
const char* const MQTT_BROKER        = "192.168.10.1";
const uint16_t    MQTT_PORT          = 1883;          // 8883 si MQTTS
const char* const MQTT_TOPIC_TELEMETRY = "sentinel/telemetry";
const char* const MQTT_TOPIC_ALERTS    = "sentinel/alerts";
const char* const MQTT_TOPIC_COMMANDS  = "sentinel/commands";

// ==========================================
// PINOUT HARDWARE (ESP8266 / NODEMCU)
// ==========================================
// 1. Écran OLED HW-416A (I2C SSD1306)
#define PIN_OLED_SCL        D1   // GPIO5 (SCL)
#define PIN_OLED_SDA        D2   // GPIO4 (SDA)
#define OLED_SCREEN_WIDTH   128
#define OLED_SCREEN_HEIGHT  64
#define OLED_RESET          -1
#define OLED_I2C_ADDRESS    0x3C

// 2. Capteur Température & Humidité V182 (DHT11/DHT22)
#define PIN_DHT             D5   // GPIO14
#define DHT_TYPE            DHT11 // Changer en DHT22 si le module est blanc

// 3. Capteur de Gaz MH-MQ (Sortie Analogique sur A0)
#define PIN_MQ_ANALOG       A0   // ADC0 (0 - 1023)

// 4. Capteur d'eau HOYA (Détection inondation liquide)
#define PIN_WATER_SENSOR    D6   // GPIO12 (Entrée numérique)

// 5. Actionneurs physiques (Buzzer YXDZ + 4 LEDs d'état)
#define PIN_LED_GREEN       D4   // GPIO2 (Statut Nominal)
#define PIN_LED_BLUE        D3   // GPIO0 (Statut Wi-Fi / Réseau)
#define PIN_LED_RED         D7   // GPIO13 (Alerte Critique Gaz/Inondation)
#define PIN_BUZZER          D8   // GPIO15 (Buzzer YXDZ actif)

// ==========================================
// CADENCEMENT & SEUILS
// ==========================================
const unsigned long TELEMETRY_INTERVAL_MS = 2000;
const unsigned long DISPLAY_REFRESH_MS   = 500;

// Seuils d'alerte locale
const float TEMP_ALERT_THRESHOLD   = 40.0; // °C
const int   GAS_ALERT_RAW_THRESHOLD = 500; // À ajuster selon calibration du MQ

#endif // CONFIG_H
