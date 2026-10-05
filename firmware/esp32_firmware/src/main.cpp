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
Adafruit_SSD1306 display(128, 64, &Wire, -1);
DHT dht(PIN_DHT, DHT22);
WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);

// Variables capteurs
float temperature = NAN;
float humidity = NAN;
int gasRaw = 0;
bool presenceDetected = false;
bool lastPresenceState = false;

// Variables actionneurs
bool airlockOpen = false;
bool alarmActive = false;

// Timers
unsigned long lastTelemetryTime = 0;
unsigned long lastSensorReadTime = 0;
unsigned long lastDisplayTime = 0;
unsigned long lastMqttRetry = 0;

// Compteurs & diagnostics pour l'écran OLED
unsigned long telemetrySuccessCount = 0;
int lastHttpAlertCode = 0;

// Prototypes
void connectWiFi();
void connectMQTT();
void onMqttMessage(char* topic, byte* payload, unsigned int length);
void readSensors();
void updateDisplay();
void sendTelemetry();
void sendHttpAlert(const char* event_type, const char* severity, const char* source, float val, const char* details);
void setRGB(bool r, bool g, bool b);

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println(F("\n========================================"));
  Serial.println(F("  SENTINEL-X CORE - FIRMWARE PRODUCTION"));
  Serial.println(F("========================================"));

  pinMode(PIN_PIR, INPUT);
  pinMode(PIN_RGB_R, OUTPUT);
  pinMode(PIN_RGB_G, OUTPUT);
  pinMode(PIN_RGB_B, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);

  setRGB(false, false, false);
  digitalWrite(PIN_BUZZER, LOW);

  // Initialisation I2C & Écran OLED (D1/D2)
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  if (display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(10, 15);
    display.println("SENTINEL-X CORE");
    display.setCursor(10, 30);
    display.println("Initialisation...");
    display.display();
  }

  dht.begin();
  connectWiFi();

  // NTP
  configTime(0, 0, SERVER_HOST, "pool.ntp.org");

  // Configuration MQTT (Tampon à 1024 octets selon CONTRAT-MQTT § 6)
  mqttClient.setServer(SERVER_HOST, MQTT_PORT);
  mqttClient.setBufferSize(1024);
  mqttClient.setCallback(onMqttMessage);
}

void loop() {
  // Maintien Wi-Fi & MQTT
  if (WiFi.status() == WL_CONNECTED) {
    if (!mqttClient.connected()) {
      if (millis() - lastMqttRetry > 4000) {
        lastMqttRetry = millis();
        connectMQTT();
      }
    } else {
      mqttClient.loop();
    }
  }

  // Lecture cadencée des capteurs (toutes les 2 sec strictes)
  unsigned long now = millis();
  if (now - lastSensorReadTime >= 2000) {
    lastSensorReadTime = now;
    readSensors();
  }

  // Envoi de la télémétrie vers le broker Mosquitto (toutes les 2 sec selon CONTRAT-MQTT § 4.1)
  if (now - lastTelemetryTime >= 2000) {
    lastTelemetryTime = now;
    sendTelemetry();
  }

  // Rafraîchissement de l'écran avec panneau de diagnostic
  if (now - lastDisplayTime >= 500) {
    lastDisplayTime = now;
    updateDisplay();
  }
}

// ----------------------------------------------------
// CONNEXION RÉSEAU & MQTT
// ----------------------------------------------------
void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 15) {
    delay(400);
    setRGB(false, false, (tries % 2 == 0)); // Clignotement bleu
    tries++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    setRGB(false, true, false); // Vert
  }
}

void connectMQTT() {
  if (mqttClient.connect(NODE_ID, MQTT_USER, MQTT_PASS)) {
    mqttClient.subscribe(TOPIC_COMMANDS, 1);
    mqttClient.subscribe(TOPIC_RESPONSE, 1);
  }
}

void onMqttMessage(char* topic, byte* payload, unsigned int length) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, length)) return; // Silencieusement ignoré selon contrat

  if (strcmp(topic, TOPIC_COMMANDS) == 0) {
    const char* action = doc["action"] | "";
    if (strcmp(action, "EMERGENCY_STOP_ALL") == 0) {
      alarmActive = false;
      digitalWrite(PIN_BUZZER, LOW);
      setRGB(false, true, false);
    } else if (strcmp(action, "OPERATE_MOTOR") == 0) {
      const char* command = doc["command"] | "";
      airlockOpen = (strcmp(command, "OPEN") == 0);
    } else if (strcmp(action, "TRIGGER_ALARM") == 0) {
      alarmActive = doc["state"] | false;
      if (alarmActive) {
        setRGB(true, false, false);
        tone(PIN_BUZZER, 2400, 250);
      } else {
        setRGB(false, true, false);
        noTone(PIN_BUZZER);
      }
    }
  } else if (strcmp(topic, TOPIC_RESPONSE) == 0) {
    bool accessGranted = doc["access_granted"] | false;
    bool autoUnlock = doc["auto_unlock_door"] | false;
    if (accessGranted) {
      setRGB(false, true, false);
      if (autoUnlock) airlockOpen = true;
    } else {
      setRGB(true, false, false);
      tone(PIN_BUZZER, 1000, 300);
    }
  }
}

// ----------------------------------------------------
// LECTURE DES CAPTEURS & ALERTES
// ----------------------------------------------------
void readSensors() {
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  temperature = isnan(t) ? NAN : t;
  humidity = isnan(h) ? NAN : h;

  // Lecture Analogique A0 (0 à 1023 sur ESP8266, mappé sur 0-4095 pour conformité contrat)
  int rawA0 = analogRead(PIN_GAS_MQ);
  gasRaw = map(rawA0, 0, 1023, 0, 4095);

  // Présence PIR sur D3
  presenceDetected = (digitalRead(PIN_PIR) == HIGH);

  // Alertes immédiates
  if (presenceDetected && !lastPresenceState) {
    sendHttpAlert("INTRUSION_DETECTED", "CRITICAL", "PIR_MOTION", 1.0, "Mouvement anormal detecte");
  }
  lastPresenceState = presenceDetected;

  if (!isnan(temperature) && temperature >= 45.0) {
    sendHttpAlert("THERMAL_RUNAWAY", "CRITICAL", "DHT22", temperature, "Surchauffe critique");
  }
  if (gasRaw >= 1500) {
    sendHttpAlert("GAS_LEAK_WARNING", "WARNING", "MQ2", (float)gasRaw, "Concentration suspecte");
  }
}

// ----------------------------------------------------
// TÉLÉMÉTRIE (CONTRAT-MQTT § 4.1)
// ----------------------------------------------------
void sendTelemetry() {
  if (!mqttClient.connected()) return;

  JsonDocument doc;
  doc["node_id"] = NODE_ID;

  time_t nowSec;
  time(&nowSec);
  doc["timestamp"] = (nowSec > 100000) ? (long)nowSec : (long)millis();
  doc["uptime_ms"] = millis();

  JsonObject metrics = doc["metrics"].to<JsonObject>();
  if (isnan(temperature)) metrics["temperature_celsius"] = nullptr;
  else metrics["temperature_celsius"] = serialized(String(temperature, 1));

  if (isnan(humidity)) metrics["humidity_percent"] = nullptr;
  else metrics["humidity_percent"] = serialized(String(humidity, 1));

  metrics["gas_raw_ppm"] = gasRaw;
  metrics["presence_detected"] = presenceDetected;

  JsonObject actuators = doc["actuators_state"].to<JsonObject>();
  actuators["airlock_open"] = airlockOpen;
  actuators["alarm_active"] = alarmActive;

  JsonObject sys = doc["system"].to<JsonObject>();
  sys["wifi_rssi_dbm"] = WiFi.RSSI();
  sys["free_heap_bytes"] = ESP.getFreeHeap();

  char buffer[1024];
  size_t bytesWritten = serializeJson(doc, buffer, sizeof(buffer));
  if (mqttClient.publish(TOPIC_TELEMETRY, buffer, bytesWritten)) {
    telemetrySuccessCount++;
  }
}

// ----------------------------------------------------
// ALERTE POST /api/v1/alerts (API.MD § 4)
// ----------------------------------------------------
void sendHttpAlert(const char* event_type, const char* severity, const char* source, float val, const char* details) {
  if (WiFi.status() != WL_CONNECTED) return;

  WiFiClient client;
  HTTPClient http;
  String url = String("http://") + SERVER_HOST + ":" + String(HTTP_PORT) + "/api/v1/alerts";
  if (http.begin(client, url)) {
    http.addHeader("Content-Type", "application/json");
    http.addHeader("Authorization", String("Bearer ") + API_DEVICE_TOKEN);

    JsonDocument doc;
    doc["node_id"] = NODE_ID;
    time_t nowSec; time(&nowSec);
    doc["timestamp"] = (nowSec > 100000) ? (long)nowSec : (long)millis();
    doc["event_type"] = event_type;
    doc["severity"] = severity;
    doc["source_sensor"] = source;
    doc["value"] = val;
    doc["details"] = details;

    String body;
    serializeJson(doc, body);
    lastHttpAlertCode = http.POST(body);
    http.end();
  }
}

void setRGB(bool r, bool g, bool b) {
  digitalWrite(PIN_RGB_R, r ? HIGH : LOW);
  digitalWrite(PIN_RGB_G, g ? HIGH : LOW);
  digitalWrite(PIN_RGB_B, b ? HIGH : LOW);
}

// ----------------------------------------------------
// AFFICHAGE OLED & DIAGNOSTIC ERREURS EN TEMPS RÉEL
// ----------------------------------------------------
void updateDisplay() {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  // Ligne 1 : Titre & Statut Wi-Fi / MQTT
  display.setCursor(0, 0);
  display.printf("SENTINEL [%s|%s]", 
    WiFi.status() == WL_CONNECTED ? "W:OK" : "W:KO",
    mqttClient.connected() ? "M:OK" : "M:KO");
  display.drawLine(0, 9, 127, 9, SSD1306_WHITE);

  // Ligne 2 : IP ou recherche réseau
  display.setCursor(0, 12);
  if (WiFi.status() == WL_CONNECTED) {
    display.printf("IP: %s", WiFi.localIP().toString().c_str());
  } else {
    display.print("WiFi: Connexion AP...");
  }

  // Ligne 3 : Diagnostic Capteurs Temp & Hum
  display.setCursor(0, 24);
  if (isnan(temperature) || isnan(humidity)) {
    display.print("DHT: [ERREUR D4]");
  } else {
    display.printf("T:%.1fC  H:%.0f%%", temperature, humidity);
  }

  // Ligne 4 : Gaz & Mouvement
  display.setCursor(0, 36);
  display.printf("Gaz:%4d  PIR:%s", gasRaw, presenceDetected ? "!MVT!" : "OK");

  // Ligne 5 : Flux et alertes
  display.setCursor(0, 48);
  display.printf("MQTT:%lu | HTTP:%d", telemetrySuccessCount, lastHttpAlertCode);

  display.display();
}
