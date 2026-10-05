#ifndef CONFIG_H
#define CONFIG_H

#include <Arduino.h>

// ==========================================
// IDENTIFIANTS RÉSEAU EXACTS DU PC
// ==========================================
#define WIFI_SSID         "Google pixel 10 pro "
#define WIFI_PASS         "123456789"

#define SERVER_HOST       "10.69.127.207"
#define HTTP_PORT         8000
#define MQTT_PORT         8883            // MQTTS chiffré TLS selon CONTRAT-MQTT § 1
#define MQTT_USER         "esp32"
#define MQTT_PASS         "RUDk4PxTwqcENuCaPpisErfQKKQDAuw2"
#define API_DEVICE_TOKEN  "9BBpI8YAGq35AxpNe0b4WMiMQcqgbwiH"

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
#define PIN_PIR           0   // D3 (GPIO0)

#define PIN_RGB_B         14  // D5 (GPIO14)
#define PIN_RGB_G         12  // D6 (GPIO12)
#define PIN_RGB_R         13  // D7 (GPIO13)
#define PIN_BUZZER        15  // D8 (GPIO15)

#endif // CONFIG_H
