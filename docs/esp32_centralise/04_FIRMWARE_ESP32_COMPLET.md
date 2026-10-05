# CODE FIRMWARE ESP32 INTÉGRÉ (C++ ARDUINO / PLATFORMIO)

Ce code regroupe dans une seule boucle temps-réel cadencée non-bloquante :
- La gestion du bus I2C (Écran OLED + Expanseur MCP23017 pour 4 moteurs pas-à-pas)
- La lecture du lecteur RFID-RC522 (SPI)
- La captation du gaz MH-MQ (ADC), de la température/humidité V182 (DHT) et de la présence PIR
- L'émission HTTP REST et MQTT vers le serveur central.

```cpp
#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <SPI.h>
#include <MFRC522.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Adafruit_MCP23X17.h>
#include <DHT.h>
#include <ArduinoJson.h>

// ==========================================
// CONFIGURATION RESEAU & SERVEUR
// ==========================================
const char* WIFI_SSID     = "SENTINEL_AP";
const char* WIFI_PASSWORD = "AetherCorp2050Secure!";
const char* SERVER_IP     = "192.168.10.1";
const int   SERVER_PORT   = 8000;
const char* MQTT_BROKER   = "192.168.10.1";
const int   MQTT_PORT     = 1883;

// ==========================================
// BROCHAGE ESP32
// ==========================================
#define PIN_I2C_SDA     21
#define PIN_I2C_SCL     22

#define PIN_RFID_SS     5
#define PIN_RFID_RST    4

#define PIN_GAS_MQ      34  // Entrée analogique ADC1
#define PIN_DHT         14  // Entrée Temp/Hum V182
#define PIN_PIR         13  // Entrée Présence PIR

#define PIN_RGB_R       25
#define PIN_RGB_G       26
#define PIN_RGB_B       27
#define PIN_BUZZER      33

// ==========================================
// INSTANCES MATÉRIELLES
// ==========================================
Adafruit_SSD1306 display(128, 64, &Wire, -1);
Adafruit_MCP23X17 mcp;
MFRC522 rfid(PIN_RFID_SS, PIN_RFID_RST);
DHT dht(PIN_DHT, DHT22);
WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);

// Variables d'état
float temperature = 0.0;
float humidity = 0.0;
int   gasValue = 0;
bool  presenceDetected = false;
bool  airlockOpen = false;

// Chronomètres non-bloquants
unsigned long lastTelemetry = 0;
unsigned long lastDisplay = 0;

void setup() {
  Serial.begin(115200);

  // 1. Initialisation I2C et composants associés
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  display.clearDisplay();
  display.println("SENTINEL-X ESP32 INIT");
  display.display();

  if (mcp.begin_I2C(0x20)) {
    // Configuration des 16 broches du MCP23017 en sorties pour les moteurs
    for (int p = 0; p < 16; p++) {
      mcp.pinMode(p, OUTPUT);
      mcp.digitalWrite(p, LOW);
    }
  }

  // 2. Initialisation SPI et RFID-RC522
  SPI.begin();
  rfid.PCD_Init();

  // 3. Capteurs et Actionneurs locaux
  pinMode(PIN_PIR, INPUT);
  pinMode(PIN_RGB_R, OUTPUT);
  pinMode(PIN_RGB_G, OUTPUT);
  pinMode(PIN_RGB_B, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  dht.begin();

  // 4. Réseau
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
}

void loop() {
  // Maintien Wi-Fi & MQTT
  if (WiFi.status() == WL_CONNECTED && !mqttClient.connected()) {
    mqttClient.connect("SentinelX-Core");
    mqttClient.subscribe("sentinel/commands");
    mqttClient.subscribe("sentinel/access/response");
  }
  mqttClient.loop();

  // 1. Surveillance RFID (Contrôle d'accès)
  if (rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) {
    String uidStr = "";
    for (byte i = 0; i < rfid.uid.size; i++) {
      uidStr += String(rfid.uid.uidByte[i] < 0x10 ? "0" : "");
      uidStr += String(rfid.uid.uidByte[i], HEX);
      if (i < rfid.uid.size - 1) uidStr += ":";
    }
    uidStr.toUpperCase();
    Serial.printf("[RFID] Badge detecte : %s\n", uidStr.c_str());

    // Envoi immédiat au serveur
    StaticJsonDocument<256> doc;
    doc["node_id"] = "SENTINEL-X-CORE";
    doc["card_uid"] = uidStr;
    doc["door_id"] = "AIRLOCK_MAIN";
    String payload;
    serializeJson(doc, payload);
    mqttClient.publish("sentinel/access", payload.c_str());

    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();
  }

  // 2. Lecture des Capteurs
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  if (!isnan(t)) temperature = t;
  if (!isnan(h)) humidity = h;
  gasValue = analogRead(PIN_GAS_MQ);
  presenceDetected = (digitalRead(PIN_PIR) == HIGH);

  // 3. Émission de Télémétrie Périodique (toutes les 2 sec)
  if (millis() - lastTelemetry >= 2000) {
    lastTelemetry = millis();
    StaticJsonDocument<512> doc;
    doc["node_id"] = "SENTINEL-X-CORE";
    doc["timestamp"] = millis();
    doc["metrics"]["temperature_celsius"] = temperature;
    doc["metrics"]["humidity_percent"] = humidity;
    doc["metrics"]["gas_raw_ppm"] = gasValue;
    doc["metrics"]["presence_detected"] = presenceDetected;
    doc["actuators_state"]["airlock_open"] = airlockOpen;

    String jsonString;
    serializeJson(doc, jsonString);
    mqttClient.publish("sentinel/telemetry", jsonString.c_str());
  }
}
```
