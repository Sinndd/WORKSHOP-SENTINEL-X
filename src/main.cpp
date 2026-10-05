#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <DHT.h>
#include <ArduinoJson.h>

#include "config.h"

// Instances
Adafruit_SSD1306 display(OLED_SCREEN_WIDTH, OLED_SCREEN_HEIGHT, &Wire, OLED_RESET);
DHT dht(PIN_DHT, DHT_TYPE);
WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);

// Variables capteurs
float currentTemp = 0.0;
float currentHumidity = 0.0;
int   currentGasRaw = 0;
bool  waterDetected = false;
bool  lastWaterState = false;

// Alertes
bool alertGas = false;
bool alertTemp = false;
bool remoteAlarm = false;
bool buzzerState = false;
unsigned long lastBuzzerToggle = 0;

// Chronomètres
unsigned long lastTelemetry = 0;
unsigned long lastDisplay = 0;

// Prototypes
void connectWiFi();
void connectMQTT();
void mqttCallback(char* topic, byte* payload, unsigned int length);
void readSensors();
void updateDisplay();
void sendHttpAlert(const char* eventType, const char* details, float val);
void sendTelemetry();
void handleIndicators();

void setup() {
  Serial.begin(115200);
  delay(200);

  // Configuration des broches
  pinMode(PIN_WATER_SENSOR, INPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_LED_GREEN, OUTPUT);
  pinMode(PIN_LED_BLUE, OUTPUT);
  pinMode(PIN_LED_RED, OUTPUT);

  digitalWrite(PIN_BUZZER, LOW);
  digitalWrite(PIN_LED_GREEN, LOW);
  digitalWrite(PIN_LED_BLUE, LOW);
  digitalWrite(PIN_LED_RED, LOW);

  // Initialisation I2C et écran HW-416A (OLED)
  Wire.begin(PIN_OLED_SDA, PIN_OLED_SCL);
  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_I2C_ADDRESS)) {
    Serial.println(F("[ERREUR] Écran HW-416A non détecté sur 0x3C !"));
  } else {
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(5, 10);
    display.println("AETHERCORP INDUSTRIAL");
    display.setCursor(15, 25);
    display.println("SENTINEL-X v1.0");
    display.display();
  }

  // Initialisation capteur V182 (DHT)
  dht.begin();

  // Connexion Wi-Fi
  connectWiFi();

  // Initialisation MQTT
  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
}

void loop() {
  // Maintien Wi-Fi
  if (WiFi.status() != WL_CONNECTED) {
    digitalWrite(PIN_LED_BLUE, LOW);
    connectWiFi();
  } else {
    digitalWrite(PIN_LED_BLUE, HIGH);
  }

  // Maintien MQTT
  if (!mqttClient.connected()) {
    connectMQTT();
  }
  mqttClient.loop();

  // Lecture des capteurs
  readSensors();

  // Gestion des LEDs et du Buzzer YXDZ
  handleIndicators();

  // Envoi de la télémétrie vers le serveur
  unsigned long now = millis();
  if (now - lastTelemetry >= TELEMETRY_INTERVAL_MS) {
    lastTelemetry = now;
    sendTelemetry();
  }

  // Rafraîchissement de l'écran HW-416A
  if (now - lastDisplay >= DISPLAY_REFRESH_MS) {
    lastDisplay = now;
    updateDisplay();
  }
}

// ----------------------------------------------------
// CONNEXION RÉSEAU WI-FI
// ----------------------------------------------------
void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 15) {
    delay(500);
    digitalWrite(PIN_LED_BLUE, !digitalRead(PIN_LED_BLUE));
    tries++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    digitalWrite(PIN_LED_BLUE, HIGH);
  }
}

void connectMQTT() {
  static unsigned long lastRetry = 0;
  if (millis() - lastRetry > 4000) {
    lastRetry = millis();
    String clientId = "SentinelX-" + String(ESP.getChipId(), HEX);
    if (mqttClient.connect(clientId.c_str())) {
      mqttClient.subscribe(MQTT_TOPIC_COMMANDS);
    }
  }
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String msg = "";
  for (unsigned int i = 0; i < length; i++) msg += (char)payload[i];

  StaticJsonDocument<256> doc;
  if (!deserializeJson(doc, msg)) {
    const char* action = doc["action"];
    if (action && strcmp(action, "ALARM_ON") == 0) {
      remoteAlarm = true;
    } else if (action && strcmp(action, "ALARM_OFF") == 0) {
      remoteAlarm = false;
    }
  }
}

// ----------------------------------------------------
// LECTURE DES CAPTEURS
// ----------------------------------------------------
void readSensors() {
  // 1. Température / Humidité (V182)
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  if (!isnan(t)) currentTemp = t;
  if (!isnan(h)) currentHumidity = h;

  // 2. Capteur de Gaz (MH-MQ sur A0)
  currentGasRaw = analogRead(PIN_MQ_ANALOG);

  // 3. Capteur d'eau HOYA (D6)
  waterDetected = (digitalRead(PIN_WATER_SENSOR) == HIGH);

  // Détection des seuils
  alertTemp = (currentTemp >= TEMP_ALERT_THRESHOLD);
  alertGas  = (currentGasRaw >= GAS_ALERT_RAW_THRESHOLD);

  // Envoi alerte immédiate lors d'un nouveau front d'inondation
  if (waterDetected && !lastWaterState) {
    sendHttpAlert("WATER_LEAK", "Capteur HOYA immerge !", 1.0);
  }
  lastWaterState = waterDetected;

  // Envoi alerte gaz si dépassement critique
  static unsigned long lastGasAlertTime = 0;
  if (alertGas && (millis() - lastGasAlertTime > 5000)) {
    lastGasAlertTime = millis();
    sendHttpAlert("GAS_LEAK", "Concentration suspecte detectee par MH-MQ", (float)currentGasRaw);
  }
}

// ----------------------------------------------------
// INDICATEURS VISUELS ET SONORES
// ----------------------------------------------------
void handleIndicators() {
  bool inAlert = (alertGas || alertTemp || waterDetected || remoteAlarm);

  if (inAlert) {
    digitalWrite(PIN_LED_GREEN, LOW); // Éteint nominal

    // Clignotement Buzzer YXDZ et LED Rouge d'urgence
    if (millis() - lastBuzzerToggle >= 150) {
      lastBuzzerToggle = millis();
      buzzerState = !buzzerState;
      digitalWrite(PIN_BUZZER, buzzerState ? HIGH : LOW);
      digitalWrite(PIN_LED_RED, buzzerState ? HIGH : LOW);
    }
  } else {
    // Mode Nominal : LED Verte allumée, silence radio
    digitalWrite(PIN_LED_GREEN, HIGH);
    digitalWrite(PIN_LED_RED, LOW);
    digitalWrite(PIN_BUZZER, LOW);
  }
}

// ----------------------------------------------------
// AFFICHAGE OLED HW-416A
// ----------------------------------------------------
void updateDisplay() {
  display.clearDisplay();

  // En-tête
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.print("SENTINEL-X  ");
  display.print(WiFi.status() == WL_CONNECTED ? "[WiFi OK]" : "[WiFi ..]");
  display.drawLine(0, 10, 127, 10, SSD1306_WHITE);

  // IP Locale pour la démo jury
  display.setCursor(0, 13);
  display.print("IP: ");
  display.print(WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : "Connexion...");

  // Métriques V182
  display.setCursor(0, 25);
  display.printf("Temp: %.1fC  Hum: %.0f%%", currentTemp, currentHumidity);

  // Gaz MQ & Eau HOYA
  display.setCursor(0, 37);
  display.printf("Gaz: %-4d  Eau: %s", currentGasRaw, waterDetected ? "!FUITE!" : "SEC");

  // Bannière d'état
  display.setCursor(0, 51);
  if (alertGas || alertTemp || waterDetected || remoteAlarm) {
    display.print(">> ALERTE CRITIQUE <<");
  } else {
    display.print("STATUT: NOMINAL");
  }

  display.display();
}

// ----------------------------------------------------
// ENVOIS RÉSEAU (REST POST OBLIGATOIRE & MQTT)
// ----------------------------------------------------
void sendHttpAlert(const char* eventType, const char* details, float val) {
  if (WiFi.status() != WL_CONNECTED) return;

  WiFiClient client;
  HTTPClient http;
  String url = String("http://") + SERVER_HOST + ":" + String(SERVER_PORT) + ALERT_ENDPOINT;

  if (http.begin(client, url)) {
    http.addHeader("Content-Type", "application/json");

    StaticJsonDocument<256> doc;
    doc["node_id"] = "SENTINEL-X-01";
    doc["timestamp"] = millis();
    doc["event_type"] = eventType;
    doc["value"] = val;
    doc["details"] = details;

    String body;
    serializeJson(doc, body);
    http.POST(body);
    http.end();
  }
}

void sendTelemetry() {
  if (WiFi.status() != WL_CONNECTED) return;

  StaticJsonDocument<256> doc;
  doc["node_id"] = "SENTINEL-X-01";
  doc["temperature"] = currentTemp;
  doc["humidity"] = currentHumidity;
  doc["gas_raw"] = currentGasRaw;
  doc["water_leak"] = waterDetected ? 1 : 0;
  doc["timestamp"] = millis();

  String payload;
  serializeJson(doc, payload);

  // MQTT Mosquitto
  if (mqttClient.connected()) {
    mqttClient.publish(MQTT_TOPIC_TELEMETRY, payload.c_str());
  }

  // REST POST
  WiFiClient client;
  HTTPClient http;
  String url = String("http://") + SERVER_HOST + ":" + String(SERVER_PORT) + TELEMETRY_ENDPOINT;
  if (http.begin(client, url)) {
    http.addHeader("Content-Type", "application/json");
    http.POST(payload);
    http.end();
  }
}
