/*
 * SENTINEL-X — test de connexion ESP8266 -> broker MQTTS (contrat v2, docs/CONTRAT-MQTT.md).
 *
 * Préparation :
 *   1. cp secrets.h.example secrets.h  et remplir (Wi-Fi, IP du serveur, MQTT_PASS_ESP32 du .env)
 *   2. cp ../../mosquitto/certs/ca_cert.h .   (CA générée par scripts/gen-certs.sh)
 *   3. Bibliothèque : PubSubClient (Nick O'Leary). Carte : NodeMCU 1.0 / Wemos D1 mini (core ESP8266 >= 3.1)
 * Moniteur série 115200 bauds : connexion, télémétrie toutes les 2 s, commandes reçues.
 */
#include <ESP8266WiFi.h>
#include <WiFiClientSecure.h>   // BearSSL
#include <PubSubClient.h>
#include <time.h>
#include "secrets.h"
#include "ca_cert.h"

static const uint16_t MQTT_PORT = 8883;
static const char* NODE_ID = "SENTINEL-X-CORE";

BearSSL::X509List trustAnchor(SENTINEL_CA_PEM);
BearSSL::WiFiClientSecure tls;
PubSubClient mqtt(tls);

void onMessage(char* topic, byte* payload, unsigned int len) {
  Serial.printf("<- %s : %.*s\n", topic, len, (const char*)payload);
}

void waitForTime() {
  // BearSSL vérifie les dates du certificat : l'heure doit être juste AVANT la connexion TLS.
  configTime(0, 0, "pool.ntp.org", MQTT_HOST);   // sur le Pi, le serveur NTP est 192.168.10.1
  Serial.print("NTP");
  while (time(nullptr) < 1704067200) { delay(300); Serial.print("."); }
  Serial.printf(" ok (%ld)\n", (long)time(nullptr));
}

void ensureMqtt() {
  static unsigned long lastTry = 0;
  if (mqtt.connected() || (lastTry && millis() - lastTry < 5000)) return;
  lastTry = millis();
  Serial.printf("MQTTS %s:%u ... ", MQTT_HOST, MQTT_PORT);
  if (mqtt.connect(NODE_ID, "esp32", MQTT_PASS)) {   // compte MQTT "esp32" (cf. ACL)
    Serial.println("connecté");
    mqtt.subscribe("sentinel/commands", 1);
    mqtt.subscribe("sentinel/access/response", 1);
  } else {
    char err[96];
    tls.getLastSSLError(err, sizeof err);
    // rc=-2 + erreur TLS : CA, IP absente du certificat ou heure ; rc=4/5 : mot de passe / ACL
    Serial.printf("échec rc=%d, TLS : %s\n", mqtt.state(), err);
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Wi-Fi");
  while (WiFi.status() != WL_CONNECTED) { delay(300); Serial.print("."); }
  Serial.printf(" ok, IP %s, RSSI %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());

  waitForTime();
  tls.setTrustAnchors(&trustAnchor);   // vérifie la chaîne ET le nom (MQTT_HOST doit être dans le SAN)
  if (tls.probeMaxFragmentLength(MQTT_HOST, MQTT_PORT, 1024)) tls.setBufferSizes(1024, 1024);  // économise ~25 Ko de RAM
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(1024);
  mqtt.setKeepAlive(30);
  mqtt.setCallback(onMessage);
}

void loop() {
  ensureMqtt();
  mqtt.loop();

  static unsigned long last = 0;
  if (mqtt.connected() && millis() - last >= 2000) {
    last = millis();
    char buf[384];
    snprintf(buf, sizeof buf,
      "{\"node_id\":\"%s\",\"timestamp\":%ld,\"uptime_ms\":%lu,"
      "\"metrics\":{\"temperature_celsius\":null,\"humidity_percent\":null,\"gas_raw_ppm\":%d,\"presence_detected\":false},"
      "\"system\":{\"wifi_rssi_dbm\":%d,\"free_heap_bytes\":%u}}",
      NODE_ID, (long)time(nullptr), millis(), analogRead(A0), WiFi.RSSI(), ESP.getFreeHeap());
    bool ok = mqtt.publish("sentinel/telemetry", buf);
    Serial.printf("-> sentinel/telemetry %s (%u o)\n", ok ? "ok" : "ÉCHEC", (unsigned)strlen(buf));
  }
}
