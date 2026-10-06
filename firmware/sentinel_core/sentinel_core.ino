#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <DHT.h>
#include <ArduinoJson.h>

#include "config.h"
#include "ca_cert.h"

Adafruit_SSD1306 display(128, 64, &Wire, -1);
DHT dht(PIN_DHT, DHT22);

WiFiClientSecure tlsClient;
PubSubClient mqttClient(tlsClient);

X509List caCert(SENTINEL_CA_PEM);

float temperature = NAN;
float humidity = NAN;
int gasRaw = 0;
bool presenceDetected = false;
bool lastPresenceState = false;

// --- PIR HC-SR501 : chauffe + filtrage (le brut du module est bruité) ---
const unsigned long PIR_WARMUP_MS = 60000;          // sortie instable ~1 min après la mise sous tension
const uint8_t       PIR_ON_SAMPLES = 4;             // 4 lectures HIGH consécutives (4 x 50 ms) pour valider
const unsigned long PIR_HOLD_LOW_MS = 1500;         // LOW stable 1,5 s avant de repasser à « aucune présence »
const unsigned long PIR_ALERT_COOLDOWN_MS = 10000;  // une alerte INTRUSION au plus toutes les 10 s

bool pirWarmingUp() { return millis() < PIR_WARMUP_MS; }

// Appelée à chaque tour de loop() : met à jour presenceDetected à partir de la sortie brute du module.
void updatePir() {
  static unsigned long lastSample = 0, lowSince = 0;
  static uint8_t highCount = 0;
  unsigned long now = millis();
  if (now - lastSample < 50) return;
  lastSample = now;
  if (pirWarmingUp()) { presenceDetected = false; return; }
  if (digitalRead(PIN_PIR) == HIGH) {
    lowSince = 0;
    if (highCount < 255) highCount++;
    if (highCount >= PIR_ON_SAMPLES) presenceDetected = true;
  } else {
    highCount = 0;
    if (lowSince == 0) lowSince = now;
    if (presenceDetected && now - lowSince >= PIR_HOLD_LOW_MS) presenceDetected = false;
  }
}

bool airlockOpen = false;
bool alarmActive = false;
bool localGasAlarm = false;

unsigned long lastTelemetryTime = 0;
unsigned long lastSensorReadTime = 0;
unsigned long lastDisplayTime = 0;
unsigned long lastMqttRetry = 0;

unsigned long telemetrySuccessCount = 0;

// Gestion sonore / visuelle non-bloquante de l'alarme
unsigned long lastBuzzerToggle = 0;
bool buzzerState = false;

void setRGB(bool r, bool g, bool b) {
  digitalWrite(PIN_RGB_R, r ? HIGH : LOW);
  digitalWrite(PIN_RGB_G, g ? HIGH : LOW);
  digitalWrite(PIN_RGB_B, b ? HIGH : LOW);
}

void connectWiFi() {
  Serial.print(F("\n[WIFI] Connexion a : "));
  Serial.println(WIFI_SSID);

  WiFi.disconnect();
  delay(100);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 25) {
    delay(400);
    Serial.print(".");
    setRGB(false, false, (tries % 2 == 0));
    tries++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WIFI] Connecte ! IP : %s\n", WiFi.localIP().toString().c_str());
    setRGB(false, true, false);
  } else {
    Serial.printf("\n[WIFI] Attente connexion...\n");
  }
}

// BearSSL vérifie les dates du certificat : sans heure valide (NTP du serveur, pas d'Internet sur la table),
// le handshake échoue et bloque la boucle. On attend donc l'heure avant de tenter le TLS.
static bool timeIsValid() { return time(nullptr) > 1735689600; }   // après le 01/01/2025

void connectMQTT() {
  if (WiFi.status() != WL_CONNECTED || !timeIsValid()) return;
  Serial.println(F("[MQTTS] Connexion TLS port 8883..."));
  
  if (mqttClient.connect(NODE_ID, MQTT_USER, MQTT_PASS)) {
    Serial.println(F("[MQTTS] Connecte avec succes !"));
    mqttClient.subscribe(TOPIC_COMMANDS, 1);
    mqttClient.subscribe(TOPIC_RESPONSE, 1);
  } else {
    Serial.printf("[MQTTS] Echec connexion rc=%d\n", mqttClient.state());
  }
}

void onMqttMessage(char* topic, byte* payload, unsigned int length) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, length)) return;

  if (strcmp(topic, TOPIC_COMMANDS) == 0) {
    const char* action = doc["action"] | "";
    if (strcmp(action, "EMERGENCY_STOP_ALL") == 0) {
      alarmActive = false;
      localGasAlarm = false;
      digitalWrite(PIN_BUZZER, LOW);
      setRGB(false, true, false);
    } else if (strcmp(action, "OPERATE_MOTOR") == 0) {
      const char* command = doc["command"] | "";
      airlockOpen = (strcmp(command, "OPEN") == 0);
    } else if (strcmp(action, "TRIGGER_ALARM") == 0) {
      alarmActive = doc["state"] | false;
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

void sendAlertMQTT(const char* event_type, const char* severity, const char* source, float val, const char* details) {
  if (!mqttClient.connected()) return;

  JsonDocument doc;
  doc["node_id"] = NODE_ID;
  time_t nowSec; time(&nowSec);
  doc["timestamp"] = (nowSec > 100000) ? (long)nowSec : (long)millis();
  doc["event_type"] = event_type;
  doc["severity"] = severity;
  doc["source_sensor"] = source;
  doc["value"] = val;
  doc["details"] = details;

  char buf[512];
  serializeJson(doc, buf);
  mqttClient.publish(TOPIC_ALERTS, buf);
}

void readSensors() {
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  temperature = isnan(t) ? NAN : t;
  humidity = isnan(h) ? NAN : h;

  // Lecture analogique A0 (0-1023 étalonné vers 0-4095 pour la télémétrie)
  int rawA0 = analogRead(PIN_GAS_MQ);
  gasRaw = map(rawA0, 0, 1023, 0, 4095);

  // 1. DÉTECTION GAZ PHYSIQUE LOCALE : seuil brut sur A0 > 150 (ou gasRaw > 600)
  static bool lastGasWarning = false;
  if (rawA0 >= 150) {
    localGasAlarm = true;
    if (!lastGasWarning) {
      lastGasWarning = true;
      sendAlertMQTT("GAS_LEAK_WARNING", "CRITICAL", "MQ2", (float)gasRaw, "Forte concentration de gaz detectee !");
    }
  } else {
    localGasAlarm = false;
    lastGasWarning = false;
  }

  // 2. DÉTECTION PRÉSENCE PIR (valeur filtrée par updatePir())
  static unsigned long lastPirAlert = 0;
  if (presenceDetected && !lastPresenceState && (lastPirAlert == 0 || millis() - lastPirAlert >= PIR_ALERT_COOLDOWN_MS)) {
    lastPirAlert = millis();
    sendAlertMQTT("INTRUSION_DETECTED", "CRITICAL", "PIR_MOTION", 1.0, "Mouvement anormal detecte dans le perimetre");
  }
  lastPresenceState = presenceDetected;
}

// Gestion physique du Buzzer et de la LED RGB selon l'état d'alarme
void updateAlarmActuators() {
  bool inAlarm = (alarmActive || localGasAlarm);

  if (inAlarm) {
    // Alarme active : Clignotement rouge rapide et sirène sonore
    if (millis() - lastBuzzerToggle >= 120) {
      lastBuzzerToggle = millis();
      buzzerState = !buzzerState;
      if (buzzerState) {
        setRGB(true, false, false); // Rouge
        tone(PIN_BUZZER, 2600);     // Bip aigu d'alarme
      } else {
        setRGB(false, false, false);
        noTone(PIN_BUZZER);
      }
    }
  } else {
    // État nominal : pas d'alarme
    noTone(PIN_BUZZER);
    digitalWrite(PIN_BUZZER, LOW);
    if (WiFi.status() == WL_CONNECTED) {
      setRGB(false, true, false); // Vert fixe
    }
  }
}

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
  actuators["alarm_active"] = (alarmActive || localGasAlarm);

  JsonObject sys = doc["system"].to<JsonObject>();
  sys["wifi_rssi_dbm"] = WiFi.RSSI();
  sys["free_heap_bytes"] = ESP.getFreeHeap();

  char buffer[1024];
  size_t bytesWritten = serializeJson(doc, buffer, sizeof(buffer));
  if (mqttClient.publish(TOPIC_TELEMETRY, buffer, bytesWritten)) {
    telemetrySuccessCount++;
  }
}

void updateDisplay() {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  // Ligne 1 : Statut Réseau & MQTT TLS
  display.setCursor(0, 0);
  display.printf("SENTINEL [%s|%s]", 
    WiFi.status() == WL_CONNECTED ? "W:OK" : "W:KO",
    mqttClient.connected() ? "TLS:OK" : "TLS:KO");
  display.drawLine(0, 9, 127, 9, SSD1306_WHITE);

  // Ligne 2 : IP Locale de l'ESP
  display.setCursor(0, 12);
  if (WiFi.status() == WL_CONNECTED) {
    display.printf("IP: %s", WiFi.localIP().toString().c_str());
  } else {
    display.print("Recherche Wi-Fi...");
  }

  // Ligne 3 : Métriques Température & Humidité
  display.setCursor(0, 24);
  if (isnan(temperature) || isnan(humidity)) {
    display.print("DHT: [Attente/D4]");
  } else {
    display.printf("T:%.1fC  H:%.0f%%", temperature, humidity);
  }

  // Ligne 4 : Gaz & Présence
  display.setCursor(0, 36);
  display.printf("Gaz:%-4d PIR:%s", gasRaw, pirWarmingUp() ? "CHAUF" : (presenceDetected ? "!MVT!" : "OK"));

  // Ligne 5 : État Alarme & Compteur MQTTS
  display.setCursor(0, 48);
  if (localGasAlarm || alarmActive) {
    display.print(">> ALARME ACTIVE ! <<");
  } else {
    display.printf("TLS(1s):%lu | RSSI:%d", telemetrySuccessCount, WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0);
  }

  display.display();
}

void setup() {
  Serial.begin(115200);
  delay(200);

  pinMode(PIN_PIR, INPUT_PULLDOWN_16);  // GPIO16 : sans pull-down la broche flotte (lit HIGH si le PIR est débranché)
  pinMode(PIN_RGB_R, OUTPUT);
  pinMode(PIN_RGB_G, OUTPUT);
  pinMode(PIN_RGB_B, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);

  setRGB(false, false, false);
  digitalWrite(PIN_BUZZER, LOW);

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  if (display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(10, 25);
    display.println("SENTINEL-X TLS");
    display.display();
  }

  dht.begin();
  connectWiFi();

  configTime(0, 0, SERVER_HOST, "pool.ntp.org");
  tlsClient.setTrustAnchors(&caCert);
  
  mqttClient.setServer(SERVER_HOST, MQTT_PORT);
  mqttClient.setBufferSize(1024);
  mqttClient.setCallback(onMqttMessage);
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    static unsigned long lastWiFiCheck = 0;
    if (millis() - lastWiFiCheck > 8000) {
      lastWiFiCheck = millis();
      WiFi.reconnect();
    }
  } else {
    if (!mqttClient.connected()) {
      // Délai croissant (4 s -> 60 s) : un handshake TLS bloque la boucle (capteurs, alarme locale) pendant ~1-3 s.
      static unsigned long lastTlsRetry = 0, tlsBackoff = 4000;
      if (millis() - lastTlsRetry > tlsBackoff) {
        lastTlsRetry = millis();
        connectMQTT();
        tlsBackoff = mqttClient.connected() ? 4000 : min(tlsBackoff * 2, 60000UL);
      }
    } else {
      mqttClient.loop();
    }
  }

  updatePir();

  // Animation physique immédiate de l'alarme (Buzzer + LED Rouge clignotante)
  updateAlarmActuators();

  unsigned long now = millis();

  if (now - lastSensorReadTime >= 500) {
    lastSensorReadTime = now;
    readSensors();
  }

  if (now - lastTelemetryTime >= 1000) {
    lastTelemetryTime = now;
    sendTelemetry();
  }

  if (now - lastDisplayTime >= 500) {
    lastDisplayTime = now;
    updateDisplay();
  }
}
