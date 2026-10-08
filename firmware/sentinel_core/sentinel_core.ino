// Firmware SENTINEL-X : ESP8266 (NodeMCU) ou ESP32 (DevKit) — les broches sont dans config.h.
#include <Arduino.h>
#if defined(ESP32)
  #include <WiFi.h>
  #include <SPI.h>
  #include <MFRC522.h>
  #include <Preferences.h>
  #include "mbedtls/md.h"
#else
  #include <ESP8266WiFi.h>
#endif
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

#if !defined(ESP32)
X509List caCert(SENTINEL_CA_PEM);   // BearSSL (ESP8266) ; sur ESP32 : setCACert() dans setup()
#endif

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

// --- Lecteur de badges RC522 (ESP32) : publie l'UID sur sentinel/access, le serveur décide (réponse sur sentinel/access/response) ---
String accessLine;                  // dernière ligne affichée sur l'OLED (badge lu / décision)
unsigned long accessLineUntil = 0;
void showAccess(const String& s) { accessLine = s; accessLineUntil = millis() + 5000; }

#if defined(ESP32)
// Interface ESP32 (ui_esp32.h) : événements à plein écran, sons, LED en PWM.
enum Overlay { OV_NONE, OV_GRANTED, OV_DENIED, OV_CLONE, OV_ENROLLED, OV_ENROLL_FAIL };
void uiOverlay(Overlay kind, const String& line1, const String& line2, unsigned long ms);
void soundGrant(); void soundDeny(); void soundClone(); void soundEnrolled();
void ledRGB(uint8_t r, uint8_t g, uint8_t b);
void uiBoot(const char* msg, int pct);
void uiConnecting(int tries);
void uiUpdate();
extern unsigned long intrusionUntil;
#endif

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
#if defined(ESP32)
  ledRGB(r ? 255 : 0, g ? 255 : 0, b ? 255 : 0);   // la LED est pilotée en PWM sur ESP32
#else
  digitalWrite(PIN_RGB_R, r ? HIGH : LOW);
  digitalWrite(PIN_RGB_G, g ? HIGH : LOW);
  digitalWrite(PIN_RGB_B, b ? HIGH : LOW);
#endif
}


#if defined(ESP32)
// =====================================================================================================
// ACTIONNEURS : 3 servos (bras gauche, bras droit, trappe arrière) + tête 28BYJ-48 via MCP23017.
// Machines à états non bloquantes (aucun delay) : les mouvements sont lissés, jamais brusques.
// =====================================================================================================
void sendAlertMQTT(const char* event_type, const char* severity, const char* source, float val, const char* details);

// ---- servos ----
ServoCtl armL = {PIN_SERVO_ARM_L, ARM_REST_DEG, ARM_REST_DEG, ARM_MIN_DEG, ARM_MAX_DEG};
ServoCtl armR = {PIN_SERVO_ARM_R, ARM_REST_DEG, ARM_REST_DEG, ARM_MIN_DEG, ARM_MAX_DEG};
ServoCtl trapServo = {PIN_SERVO_TRAP, TRAP_CLOSED_DEG, TRAP_CLOSED_DEG,
                      min(TRAP_CLOSED_DEG, TRAP_OPEN_DEG), max(TRAP_CLOSED_DEG, TRAP_OPEN_DEG)};
unsigned long lastServoMs = 0;

void servoPwm(const ServoCtl& s) {
  uint32_t us = 500 + (uint32_t)(s.cur * 2000.0f / 180.0f + 0.5f);   // 500..2500 us
  ledcWrite(s.pin, (uint32_t)((uint64_t)us * 65535 / 20000));
}
void servoSet(ServoCtl& s, float deg) { s.target = constrain(deg, (float)s.minD, (float)s.maxD); }
void servoFreeze(ServoCtl& s) { s.target = s.cur; }
bool servoArrived(const ServoCtl& s) { return fabsf(s.target - s.cur) < 0.5f; }
void servoInit(ServoCtl& s) { ledcAttach(s.pin, 50, 16); servoPwm(s); }
void servoStepOne(ServoCtl& s, float maxStep) {
  float d = s.target - s.cur;
  if (fabsf(d) < 0.01f) return;
  s.cur += (fabsf(d) <= maxStep) ? d : (d > 0 ? maxStep : -maxStep);
  servoPwm(s);
}
void servoTick() {
  unsigned long now = millis();
  if (now - lastServoMs < 10) return;
  float maxStep = SERVO_SPEED_DPS * (now - lastServoMs) / 1000.0f;
  lastServoMs = now;
  servoStepOne(armL, maxStep); servoStepOne(armR, maxStep); servoStepOne(trapServo, maxStep);
}

// ---- trappe arrière (servo) : même automate que l'ancienne trappe, l'écran et la télémétrie n'ont rien à changer ----
enum TrapState { TRAP_CLOSED, TRAP_OPENING, TRAP_OPEN, TRAP_CLOSING };
TrapState trapState = TRAP_CLOSED;
long trapPos = 0;                    // progression 0..TRAP_STEPS (0 = fermée)
unsigned long trapOpenSince = 0, trapHoldMs = 0;   // trapHoldMs = 0 : reste ouverte jusqu'à un ordre CLOSE

void trapOpen(unsigned long holdMs) {
  trapHoldMs = holdMs;
  if (trapState == TRAP_CLOSED || trapState == TRAP_CLOSING) { trapState = TRAP_OPENING; servoSet(trapServo, TRAP_OPEN_DEG); }
  else if (trapState == TRAP_OPEN) trapOpenSince = millis();   // déjà ouverte : prolonge
}
void trapClose() {
  if (trapState == TRAP_OPEN || trapState == TRAP_OPENING) { trapState = TRAP_CLOSING; servoSet(trapServo, TRAP_CLOSED_DEG); }
}
void trapStop() {
  servoFreeze(trapServo);
  trapState = (trapPos <= TRAP_STEPS / 50) ? TRAP_CLOSED : TRAP_OPEN;
  trapHoldMs = 0; trapOpenSince = millis();
}

// ---- tête (28BYJ-48 sur le MCP23017) : -HEAD_RANGE_DEG..+HEAD_RANGE_DEG autour de la position de démarrage ----
enum : uint8_t { MCP_IODIRA = 0x00, MCP_IODIRB = 0x01, MCP_OLATA = 0x14, MCP_OLATB = 0x15 };
const uint8_t HEAD_HALF[8] = {0x1, 0x3, 0x2, 0x6, 0x4, 0xC, 0x8, 0x9};   // bit0..3 = IN1..IN4
bool mcpOk = false;
long headPos = 0, headTarget = 0;    // demi-pas depuis la position de démarrage
int headPhase = 0;
unsigned long lastHeadUs = 0;
bool headMoving = false;

bool mcpWrite(uint8_t reg, uint8_t v) { Wire.beginTransmission(MCP_ADDR); Wire.write(reg); Wire.write(v); return Wire.endTransmission() == 0; }
void headInit() {
  Wire.beginTransmission(MCP_ADDR);
  mcpOk = (Wire.endTransmission() == 0);
  if (mcpOk) mcpOk = mcpWrite(MCP_IODIRA, 0x00) && mcpWrite(MCP_IODIRB, 0x00) && mcpWrite(MCP_OLATA, 0x00) && mcpWrite(MCP_OLATB, 0x00);
  Serial.printf("[HEAD] MCP23017 0x%02X : %s\n", MCP_ADDR, mcpOk ? "OK" : "ABSENT (tete desactivee)");
}
void headSetAngle(float deg) { headTarget = lroundf(constrain(deg, -(float)HEAD_RANGE_DEG, (float)HEAD_RANGE_DEG) * HEAD_STEPS_PER_DEG); }
void headStop() { headTarget = headPos; if (mcpOk) mcpWrite(MCP_OLATA, 0x00); headMoving = false; }
float headAngle() { return headPos / HEAD_STEPS_PER_DEG; }
void updateHead() {
  if (!mcpOk) return;
  if (headPos == headTarget) { if (headMoving) { mcpWrite(MCP_OLATA, 0x00); headMoving = false; } return; }   // coupe les bobines à l'arrivée : elles chauffent sinon
  unsigned long nowUs = micros();
  if (nowUs - lastHeadUs < HEAD_STEP_US) return;
  lastHeadUs = nowUs;
  int dir = (headTarget > headPos) ? 1 : -1;
  int ph = (headPhase + dir + 8) & 7;
  if (!mcpWrite(MCP_OLATA, HEAD_HALF[ph])) return;   // bus perdu : on réessaie au tour suivant sans perdre le compte des pas
  headPhase = ph; headPos += dir; headMoving = true;
}

// ---- boucle unique des actionneurs ----
void updateTrap() {
  servoTick();
  updateHead();
  trapPos = constrain((long)(TRAP_STEPS * (trapServo.cur - TRAP_CLOSED_DEG) / (float)(TRAP_OPEN_DEG - TRAP_CLOSED_DEG)), 0L, (long)TRAP_STEPS);
  if (trapState == TRAP_OPENING && servoArrived(trapServo)) { trapState = TRAP_OPEN; trapOpenSince = millis(); }
  else if (trapState == TRAP_CLOSING && servoArrived(trapServo)) trapState = TRAP_CLOSED;
  else if (trapState == TRAP_OPEN && trapHoldMs && millis() - trapOpenSince >= trapHoldMs) trapClose();
  airlockOpen = (trapState != TRAP_CLOSED);   // reflété dans la télémétrie (actuators_state.airlock_open)
}

// Ordre OPERATE_MOTOR du serveur : target = TRAP_REAR (alias AIRLOCK_MAIN) | ARM_LEFT | ARM_RIGHT | HEAD
// command = OPEN | CLOSE | STOP | CENTER | SET_ANGLE (+ "angle" : bras 0..180, tête -90..90)
void operateActuator(const char* target, const char* command, JsonDocument& doc) {
  bool isAngle = strcmp(command, "SET_ANGLE") == 0, isCenter = strcmp(command, "CENTER") == 0, isStop = strcmp(command, "STOP") == 0;
  float angle = doc["angle"] | 0.0f;
  if (strcmp(target, "AIRLOCK_MAIN") == 0 || strcmp(target, "TRAP_REAR") == 0) {
    unsigned long dur = doc["duration_ms"] | 0;
    if (strcmp(command, "OPEN") == 0) trapOpen(dur ? dur : TRAP_REMOTE_HOLD_MS);
    else if (strcmp(command, "CLOSE") == 0) trapClose();
    else if (isStop) trapStop();
  } else if (strcmp(target, "ARM_LEFT") == 0 || strcmp(target, "ARM_RIGHT") == 0) {
    ServoCtl& arm = (strcmp(target, "ARM_LEFT") == 0) ? armL : armR;
    if (isAngle) servoSet(arm, angle);
    else if (isCenter) servoSet(arm, ARM_REST_DEG);
    else if (isStop) servoFreeze(arm);
  } else if (strcmp(target, "HEAD") == 0) {
    if (isAngle) headSetAngle(angle);
    else if (isCenter) headSetAngle(0);
    else if (isStop) headStop();
  }
}

// =====================================================================================================
// BADGES MIFARE Classic 1K (RC522) : clés propres à chaque badge + contenu signé + compteur tournant
//
// Un badge enrôlé contient dans le secteur 1 (blocs 4 à 7) :
//   bloc 4 = "SX" | compteur (4 octets) | signature HMAC-SHA256 tronquée (10 octets)   (écrit en une seule fois)
//   bloc 5 = nonce aléatoire (16 octets), propre au badge
//   bloc 7 = clé A | droits d'accès 78 77 88 C1 | clé B   (lecture : clé A ou B ; écriture : clé B seule)
// Les clés A et B sont dérivées de CARD_MASTER_KEY et de l'UID : un badge ne donne aucune information sur les autres.
// À chaque passage valide, le compteur avance sur le badge ET dans la mémoire de l'ESP32 : une copie réalisée avant le
// dernier passage porte un compteur trop ancien, elle est refusée et signalée (UNAUTHORIZED_ACCESS).
// Limite : ni le MIFARE Classic ni le RC522 ne permettent un badge réellement infalsifiable (voir docs/BADGES.md).
// =====================================================================================================
MFRC522 rfid(PIN_RFID_SS, PIN_RFID_RST);
bool rfidOk = false;
Preferences cardPrefs;
uint8_t masterKey[16];
String lastCardUid;
unsigned long lastCardSeen = 0;
String pendingUid;                  // dernier badge envoyé au serveur : sa réponse ne peut ouvrir la trappe que s'il est valide
bool pendingValid = false;

bool enrollMode = false;
unsigned long enrollUntil = 0;
long enrollId = 0;                  // identifiant de la demande du serveur (0 = démarrage local par le bouton)
String enrollOutbox;                // résultat à envoyer sur sentinel/enroll (réessayé tant que MQTT est coupé)

void flushEnrollOutbox() {
  if (enrollOutbox.length() && mqttClient.connected() && mqttClient.publish(TOPIC_ENROLL, enrollOutbox.c_str())) enrollOutbox = "";
}
void queueEnrollResult(const char* status, const String& uid, const String& error) {
  if (enrollId <= 0) return;
  JsonDocument doc;
  doc["node_id"] = NODE_ID; doc["enroll_id"] = enrollId; doc["status"] = status;
  if (uid.length()) doc["card_uid"] = uid;
  if (error.length()) doc["error"] = error;
  serializeJson(doc, enrollOutbox);
  flushEnrollOutbox();
}

static bool parseMasterKey() {
  const char* hex = CARD_MASTER_KEY;
  if (strlen(hex) != 32) return false;
  for (int i = 0; i < 16; i++) {
    char b[3] = {hex[2 * i], hex[2 * i + 1], 0};
    char* end; masterKey[i] = (uint8_t)strtoul(b, &end, 16);
    if (*end) return false;
  }
  return true;
}

static void hmac256(const uint8_t* msg, size_t len, uint8_t out[32]) {
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  mbedtls_md_setup(&ctx, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 1);
  mbedtls_md_hmac_starts(&ctx, masterKey, sizeof masterKey);
  mbedtls_md_hmac_update(&ctx, msg, len);
  mbedtls_md_hmac_finish(&ctx, out);
  mbedtls_md_free(&ctx);
}

static void deriveKey(char which, const MFRC522::Uid& u, MFRC522::MIFARE_Key& key) {
  uint8_t msg[2 + 10]; size_t n = 0;
  msg[n++] = (uint8_t)which; msg[n++] = u.size;
  for (byte i = 0; i < u.size && i < 10; i++) msg[n++] = u.uidByte[i];
  uint8_t h[32]; hmac256(msg, n, h);
  memcpy(key.keyByte, h, 6);
}

static void cardTag(const MFRC522::Uid& u, const uint8_t nonce[16], uint32_t counter, uint8_t out[10]) {
  uint8_t msg[1 + 1 + 10 + 16 + 2 + 4]; size_t n = 0;
  msg[n++] = 'T'; msg[n++] = u.size;
  for (byte i = 0; i < u.size && i < 10; i++) msg[n++] = u.uidByte[i];
  memcpy(msg + n, nonce, 16); n += 16;
  msg[n++] = 'S'; msg[n++] = 'X';
  for (int i = 0; i < 4; i++) msg[n++] = (counter >> (8 * i)) & 0xFF;
  uint8_t h[32]; hmac256(msg, n, h);
  memcpy(out, h, 10);
}

static String uidToString(const MFRC522::Uid& u) {
  String s;
  for (byte i = 0; i < u.size; i++) { if (u.uidByte[i] < 0x10) s += '0'; s += String(u.uidByte[i], HEX); if (i + 1 < u.size) s += ':'; }
  s.toUpperCase();
  return s;
}

static String counterKey(const MFRC522::Uid& u) {       // clé NVS (15 caractères max) : "c" + UID en hexadécimal
  String k = "c";
  for (byte i = 0; i < u.size && k.length() < 15; i++) { char b[3]; snprintf(b, sizeof b, "%02x", u.uidByte[i]); k += b; }
  return k.substring(0, 15);
}

// Réveille un badge qui vient d'être mis en veille ou dont l'authentification a échoué.
static bool reselect() {
  byte atqa[2]; byte sz = sizeof atqa;
  rfid.PICC_HaltA();            // WUPA n'est compris que par un badge en veille ou au repos, pas par un badge encore actif
  rfid.PCD_StopCrypto1();
  delay(5);
  for (int i = 0; i < 3; i++) {
    sz = sizeof atqa;
    if (rfid.PICC_WakeupA(atqa, &sz) == MFRC522::STATUS_OK && rfid.PICC_ReadCardSerial()) return true;
    delay(10);
  }
  return false;
}

enum { CARD_OK, CARD_UNENROLLED, CARD_INVALID, CARD_CLONE, CARD_ERROR };   // valeurs de retour de checkCard() (int : le préprocesseur Arduino place les prototypes avant l'enum)

// Vérifie le badge présenté ; si advance, écrit le compteur suivant (badge + mémoire ESP32).
static int checkCard(bool advance) {
  MFRC522::MIFARE_Key keyA, keyB;
  deriveKey('A', rfid.uid, keyA); deriveKey('B', rfid.uid, keyB);
  if (rfid.PCD_Authenticate(MFRC522::PICC_CMD_MF_AUTH_KEY_A, 4, &keyA, &rfid.uid) != MFRC522::STATUS_OK) return CARD_UNENROLLED;

  byte buf[18]; byte sz = sizeof buf;
  if (rfid.MIFARE_Read(4, buf, &sz) != MFRC522::STATUS_OK) return CARD_ERROR;
  uint8_t data[16]; memcpy(data, buf, 16);
  sz = sizeof buf;
  if (rfid.MIFARE_Read(5, buf, &sz) != MFRC522::STATUS_OK) return CARD_ERROR;
  uint8_t nonce[16]; memcpy(nonce, buf, 16);

  if (data[0] != 'S' || data[1] != 'X') return CARD_INVALID;
  uint32_t c = data[2] | (data[3] << 8) | (data[4] << 16) | ((uint32_t)data[5] << 24);
  uint8_t tag[10]; cardTag(rfid.uid, nonce, c, tag);
  uint8_t diff = 0; for (int i = 0; i < 10; i++) diff |= tag[i] ^ data[6 + i];   // comparaison à durée constante
  if (diff) return CARD_INVALID;

  cardPrefs.begin("cards", false);
  String nk = counterKey(rfid.uid);
  uint32_t expected = cardPrefs.getUInt(nk.c_str(), 0);
  cardPrefs.end();
  if (c < expected) return CARD_CLONE;               // copie plus ancienne que le dernier passage
  if (c > expected + 1) return CARD_INVALID;         // saut impossible : contenu falsifié
  if (!advance) return CARD_OK;

  // Compteur suivant : une seule écriture de 16 octets (bloc 4), donc jamais à moitié faite.
  uint32_t next = c + 1;
  uint8_t nd[16] = {'S', 'X', (uint8_t)next, (uint8_t)(next >> 8), (uint8_t)(next >> 16), (uint8_t)(next >> 24)};
  uint8_t nt[10]; cardTag(rfid.uid, nonce, next, nt); memcpy(nd + 6, nt, 10);
  if (rfid.PCD_Authenticate(MFRC522::PICC_CMD_MF_AUTH_KEY_B, 4, &keyB, &rfid.uid) != MFRC522::STATUS_OK) return CARD_ERROR;
  if (rfid.MIFARE_Write(4, nd, 16) != MFRC522::STATUS_OK) return CARD_ERROR;
  cardPrefs.begin("cards", false); cardPrefs.putUInt(nk.c_str(), next); cardPrefs.end();
  return CARD_OK;
}

// Mode écriture : prépare un badge vierge (clés d'usine) ou ré-enrôle un badge déjà enrôlé par cet appareil.
static bool enrollCard(String& err) {
  MFRC522::MIFARE_Key factory, keyA, keyB;
  memset(factory.keyByte, 0xFF, 6);
  deriveKey('A', rfid.uid, keyA); deriveKey('B', rfid.uid, keyB);
  bool blank = true;

  // Un badge vierge accepte la clé d'usine en A (badge neuf) ou en B (badge déjà formaté NFC : clé A publique D3F7D3F7D3F7,
  // clé B restée à FFFFFFFFFFFF) ; un badge déjà enrôlé par cet appareil accepte sa clé B dérivée.
  bool opened = rfid.PCD_Authenticate(MFRC522::PICC_CMD_MF_AUTH_KEY_A, 4, &factory, &rfid.uid) == MFRC522::STATUS_OK;
  if (!opened) {
    if (!reselect()) { err = "badge perdu"; return false; }
    opened = rfid.PCD_Authenticate(MFRC522::PICC_CMD_MF_AUTH_KEY_B, 4, &factory, &rfid.uid) == MFRC522::STATUS_OK;
  }
  if (!opened) {
    if (!reselect()) { err = "badge perdu"; return false; }
    if (rfid.PCD_Authenticate(MFRC522::PICC_CMD_MF_AUTH_KEY_B, 4, &keyB, &rfid.uid) != MFRC522::STATUS_OK) { err = "badge verrouille (autres cles)"; return false; }
    blank = false;   // déjà à nous : on renouvelle seulement le contenu
  }

  uint8_t nonce[16]; esp_fill_random(nonce, sizeof nonce);
  uint8_t data[16] = {'S', 'X', 0, 0, 0, 0};
  uint8_t tag[10]; cardTag(rfid.uid, nonce, 0, tag); memcpy(data + 6, tag, 10);
  if (rfid.MIFARE_Write(5, nonce, 16) != MFRC522::STATUS_OK) { err = "ecriture bloc 5"; return false; }
  if (rfid.MIFARE_Write(4, data, 16) != MFRC522::STATUS_OK) { err = "ecriture bloc 4"; return false; }

  if (blank) {   // secteur protégé en dernier : une panne avant ce point laisse un badge encore vierge
    uint8_t trailer[16];
    memcpy(trailer, keyA.keyByte, 6);
    trailer[6] = 0x78; trailer[7] = 0x77; trailer[8] = 0x88; trailer[9] = 0xC1;   // données : lecture A|B, écriture B ; clés : jamais lisibles
    memcpy(trailer + 10, keyB.keyByte, 6);
    if (rfid.MIFARE_Write(7, trailer, 16) != MFRC522::STATUS_OK) { err = "ecriture des cles"; return false; }
  }

  // Contrôle : on relit le badge avec ses nouvelles clés (sans avancer le compteur).
  if (!reselect()) { err = "badge retire trop tot"; return false; }
  cardPrefs.begin("cards", false); String nk = counterKey(rfid.uid); cardPrefs.putUInt(nk.c_str(), 0); cardPrefs.end();
  int st = checkCard(false);
  if (st != CARD_OK) { err = "controle echoue"; return false; }
  return true;
}

void startEnrollMode(unsigned long windowMs, long id) {
  if (!rfidOk) { enrollId = id; queueEnrollResult("ATTEMPT_FAILED", "", "lecteur RC522 absent"); showAccess("RC522 absent"); return; }
  enrollId = id; enrollMode = true; enrollUntil = millis() + windowMs;
  Serial.printf("[RFID] MODE ECRITURE (%lu s) : presentez un badge\n", windowMs / 1000);
}
void cancelEnrollMode(const char* why) {
  if (!enrollMode) return;
  enrollMode = false; showAccess(why);
  queueEnrollResult("CANCELLED", "", "");
}

// Bouton BOOT : appui court = annuler le mode écriture (l'appui long ne le déclenche que si ENROLL_FROM_BUTTON).
void pollButton() {
  static unsigned long pressedAt = 0; static bool fired = false;
  bool down = digitalRead(PIN_BOOT) == LOW;
  if (down && pressedAt == 0) { pressedAt = millis(); fired = false; }
#if ENROLL_FROM_BUTTON
  if (down && !fired && millis() - pressedAt >= ENROLL_HOLD_MS) { fired = true; startEnrollMode(ENROLL_WINDOW_MS, 0); }
#endif
  if (!down && pressedAt != 0) {
    if (!fired && enrollMode && millis() - pressedAt > 50) cancelEnrollMode("Ecriture annulee");
    pressedAt = 0;
  }
}

void sendAccessMQTT(const String& uid, const String& cardType) {
  JsonDocument doc;
  doc["node_id"] = NODE_ID;
  time_t nowSec; time(&nowSec);
  doc["timestamp"] = (nowSec > 100000) ? (long)nowSec : (long)millis();
  doc["card_uid"] = uid;
  doc["card_type"] = cardType;
  doc["door_id"] = DOOR_ID;
  char buf[256];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  mqttClient.publish(TOPIC_ACCESS, buf, n);
}


void pollRfid() {
  static unsigned long lastPoll = 0;
  if (!rfidOk || millis() - lastPoll < 150) return;
  lastPoll = millis();
  if (enrollMode && millis() > enrollUntil) { enrollMode = false; showAccess("Ecriture: delai ecoule"); queueEnrollResult("TIMEOUT", "", ""); }
  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) return;

  String uid = uidToString(rfid.uid);
  String type = rfid.PICC_GetTypeName(rfid.PICC_GetType(rfid.uid.sak));
  type.replace(' ', '_');
  bool classic1k = (rfid.PICC_GetType(rfid.uid.sak) == MFRC522::PICC_TYPE_MIFARE_1K);

  // ---- MODE ECRITURE : enrôle le badge, n'ouvre rien ----
  if (enrollMode) {
    String err;
    if (!classic1k) { showAccess("Badge non MIFARE 1K"); uiOverlay(OV_ENROLL_FAIL, "Badge non", "MIFARE 1K", 3500); soundDeny(); queueEnrollResult("ATTEMPT_FAILED", uid, "badge non MIFARE 1K"); }
    else if (enrollCard(err)) {
      Serial.printf("[RFID] Badge ENROLE : %s\n", uid.c_str());
      showAccess("ENROLE " + uid); uiOverlay(OV_ENROLLED, uid, "Pret a servir", 4000); soundEnrolled(); enrollMode = false;
      queueEnrollResult("SUCCESS", uid, "");
    } else { Serial.printf("[RFID] Enrolement echoue (%s)\n", err.c_str()); showAccess("ECHEC: " + err); uiOverlay(OV_ENROLL_FAIL, err.substring(0, 14), err.length() > 14 ? err.substring(14) : String("Reessayez"), 3500); soundDeny(); queueEnrollResult("ATTEMPT_FAILED", uid, err); }
    rfid.PICC_HaltA(); rfid.PCD_StopCrypto1(); lastCardUid = uid; lastCardSeen = millis();
    return;
  }

  // ---- MODE NORMAL : vérifie le badge, puis demande la décision au serveur ----
  bool sameAsBefore = (uid == lastCardUid && millis() - lastCardSeen < 3000);   // badge laissé devant le lecteur
  lastCardSeen = millis(); lastCardUid = uid;
  if (sameAsBefore) { rfid.PICC_HaltA(); rfid.PCD_StopCrypto1(); return; }

  int st = classic1k ? checkCard(true) : CARD_UNENROLLED;
  rfid.PICC_HaltA(); rfid.PCD_StopCrypto1();
  Serial.printf("[RFID] Badge %s (%s) : %s\n", uid.c_str(), type.c_str(),
    st == CARD_OK ? "valide" : st == CARD_CLONE ? "COPIE SUSPECTE" : st == CARD_INVALID ? "contenu invalide" : st == CARD_ERROR ? "erreur lecture/ecriture" : "non enrole");

  if (st == CARD_CLONE) {
    showAccess("COPIE SUSPECTE !"); uiOverlay(OV_CLONE, uid, "Badge copie ?", 5000); soundClone();
    sendAlertMQTT("UNAUTHORIZED_ACCESS", "CRITICAL", "RFID_CLONE", 1.0, ("Badge copie suspecte UID=" + uid).c_str());
  }
  pendingUid = uid; pendingValid = (st == CARD_OK);
  if (mqttClient.connected()) {
    sendAccessMQTT(uid, type);
    if (st == CARD_OK) showAccess("Badge " + uid);
    else if (st != CARD_CLONE) showAccess(st == CARD_UNENROLLED ? "Badge non enrole" : "Badge invalide");
  } else {
    showAccess(st == CARD_OK ? "Badge valide-hors ligne" : "Badge refuse");   // sans serveur on n'ouvre pas
  }
}
#endif

#if defined(ESP32)
#include "ui_esp32.h"
#endif

void connectWiFi() {
  Serial.print(F("\n[WIFI] Connexion a : "));
  Serial.println(WIFI_SSID);

  WiFi.disconnect();
  delay(100);
  WiFi.mode(WIFI_STA);
#if defined(ESP32)
  WiFi.setSleep(false);   // pas d'économie d'énergie radio : sinon l'ESP32 manque des trames de certains hotspots (injoignable, sessions MQTT coupées)
#endif
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 25) {
    delay(400);
    Serial.print(".");
    setRGB(false, false, (tries % 2 == 0));
#if defined(ESP32)
    uiConnecting(tries);
#endif
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
#if defined(ESP32)
    // Diagnostic : réseau (TCP brut) ou TLS ?
    char tlsErr[100] = "";
    tlsClient.lastError(tlsErr, sizeof tlsErr);
    WiFiClient probe;
    unsigned long t0 = millis();
    bool tcpOk = probe.connect(SERVER_HOST, MQTT_PORT, 3000);
    probe.stop();
    Serial.printf("[DIAG] ip=%s gw=%s rssi=%d dBm | TCP %s:%d %s (%lu ms) | erreur TLS: %s | heure NTP %s\n",
      WiFi.localIP().toString().c_str(), WiFi.gatewayIP().toString().c_str(), WiFi.RSSI(), SERVER_HOST, MQTT_PORT,
      tcpOk ? "OK" : "ECHEC", millis() - t0, tlsErr[0] ? tlsErr : "aucune", timeIsValid() ? "valide" : "INVALIDE");
#endif
  }
}

void onMqttMessage(char* topic, byte* payload, unsigned int length) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, length)) return;

  if (strcmp(topic, TOPIC_COMMANDS) == 0) {
    const char* action = doc["action"] | "";
    if (strcmp(action, "EMERGENCY_STOP_ALL") == 0) {
#if defined(ESP32)
      trapStop(); servoFreeze(armL); servoFreeze(armR); headStop();
#endif
      alarmActive = false;
      localGasAlarm = false;
      digitalWrite(PIN_BUZZER, LOW);
      setRGB(false, true, false);
    } else if (strcmp(action, "OPERATE_MOTOR") == 0) {
      const char* command = doc["command"] | "";
#if defined(ESP32)
      operateActuator(doc["target"] | "AIRLOCK_MAIN", command, doc);
#else
      airlockOpen = (strcmp(command, "OPEN") == 0);
#endif
#if defined(ESP32)
    } else if (strcmp(action, "ENROLL_BADGE") == 0) {
      long id = doc["enroll_id"] | 0L;
      unsigned long dur = doc["duration_s"] | 30;
      if (id > 0) startEnrollMode(min(max(dur, 10UL), 120UL) * 1000UL, id);
    } else if (strcmp(action, "ENROLL_CANCEL") == 0) {
      if ((doc["enroll_id"] | 0L) == enrollId) { enrollMode = false; showAccess("Ecriture annulee"); }
#endif
    } else if (strcmp(action, "TRIGGER_ALARM") == 0) {
      alarmActive = doc["state"] | false;
    }
  } else if (strcmp(topic, TOPIC_RESPONSE) == 0) {
    bool accessGranted = doc["access_granted"] | false;
    bool autoUnlock = doc["auto_unlock_door"] | false;
    String who = doc["user_name"] | "";
    if (who.length() > 11) who = who.substring(0, 11);
    showAccess(accessGranted ? ("OK " + who) : String("ACCES REFUSE"));
    String respUid = doc["card_uid"] | "";
    respUid.toUpperCase();
    if (accessGranted) {
#if defined(ESP32)
      // La trappe ne s'ouvre que si le serveur accepte ET que le badge présenté a passé la vérification locale (clé, signature, compteur).
      if (autoUnlock && pendingValid && respUid == pendingUid) {
        trapOpen(TRAP_HOLD_MS); pendingValid = false;
        uiOverlay(OV_GRANTED, who.length() ? who : respUid, "Trappe ouverte", 4500); soundGrant();
      }
      else if (autoUnlock) { showAccess("BADGE NON VALIDE"); uiOverlay(OV_DENIED, "Badge non", "valide", 3500); soundDeny(); }
      else { uiOverlay(OV_GRANTED, who.length() ? who : respUid, "Acces accorde", 3000); soundGrant(); }
#else
      setRGB(false, true, false);
      if (autoUnlock) airlockOpen = true;
#endif
    } else {
#if defined(ESP32)
      uiOverlay(OV_DENIED, "Badge inconnu", "ou revoque", 3500); soundDeny();
#else
      setRGB(true, false, false);
      tone(PIN_BUZZER, 1000, 300);
#endif
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

  // Lecture analogique : ESP8266 0-1023 étalonné vers 0-4095 pour la télémétrie ; ESP32 déjà en 12 bits (0-4095)
  int rawA0 = analogRead(PIN_GAS_MQ);
#if defined(ESP32)
  gasRaw = rawA0;
#else
  gasRaw = map(rawA0, 0, 1023, 0, 4095);
#endif

  // 1. DÉTECTION GAZ PHYSIQUE LOCALE : seuil brut GAS_ALARM_RAW (config.h)
  static bool lastGasWarning = false;
  if (rawA0 >= GAS_ALARM_RAW) {
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
#if defined(ESP32)
    intrusionUntil = millis() + 6000;   // écran, LED et sons d'intrusion pendant 6 s
#endif
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
#if defined(ESP32)
    if (enrollMode) { setRGB(false, false, (millis() / 300) % 2 == 0); return; }   // MODE ECRITURE : bleu clignotant
#endif
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
#if defined(ESP32)
  actuators["arm_left_deg"] = (int)lroundf(armL.cur);
  actuators["arm_right_deg"] = (int)lroundf(armR.cur);
  actuators["head_deg"] = (int)lroundf(headAngle());
  actuators["trap_pos_percent"] = (int)(trapPos * 100 / TRAP_STEPS);
#endif

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
#if defined(ESP32)
  if (enrollMode) {
    display.clearDisplay(); display.setTextSize(1); display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 0);  display.print("MODE ECRITURE");
    display.drawLine(0, 9, 127, 9, SSD1306_WHITE);
    display.setCursor(0, 16); display.print("Presentez un badge");
    display.setCursor(0, 28); display.print("vierge ou deja a nous");
    display.setCursor(0, 44); display.printf("reste %lus  BOOT=annuler", (enrollUntil > millis() ? (enrollUntil - millis()) / 1000 : 0));
    display.display();
    return;
  }
#endif
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
    display.print("DHT: [Attente]");
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
  } else if (millis() < accessLineUntil) {
    display.print(accessLine);
  } else {
    display.printf("TLS(1s):%lu | RSSI:%d", telemetrySuccessCount, WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0);
  }

  display.display();
}

void setup() {
  Serial.begin(115200);
  delay(200);

#if defined(ESP32)
  pinMode(PIN_PIR, INPUT_PULLDOWN);     // sans pull-down la broche flotte (lit HIGH si le PIR est débranché)
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_GAS_MQ, ADC_11db);   // plage 0-~3,1 V
#else
  pinMode(PIN_PIR, INPUT_PULLDOWN_16);  // GPIO16 : sans pull-down la broche flotte (lit HIGH si le PIR est débranché)
#endif
  pinMode(PIN_RGB_R, OUTPUT);
  pinMode(PIN_RGB_G, OUTPUT);
  pinMode(PIN_RGB_B, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);

  setRGB(false, false, false);
  digitalWrite(PIN_BUZZER, LOW);

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
#if defined(ESP32)
  Wire.setClock(400000);   // 400 kHz : une image OLED en ~25 ms au lieu de ~100 ms (animations fluides)
#endif
  if (display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(10, 25);
    display.println("SENTINEL-X TLS");
    display.display();
  }

  dht.begin();

#if defined(ESP32)
  uiBoot("Capteurs...", 35);
  servoInit(armL); servoInit(armR); servoInit(trapServo); headInit();
  pinMode(PIN_BOOT, INPUT_PULLUP);
  if (!parseMasterKey()) Serial.println(F("[RFID] ERREUR : CARD_MASTER_KEY invalide (32 caracteres hexadecimaux attendus dans secrets.h)"));
  SPI.begin(PIN_RFID_SCK, PIN_RFID_MISO, PIN_RFID_MOSI, PIN_RFID_SS);
  rfid.PCD_Init();
  delay(50);   // laisse la puce finir sa réinitialisation : lue trop tôt, la version vaut 0x00
  byte rfidVersion = rfid.PCD_ReadRegister(MFRC522::VersionReg);
  rfidOk = (rfidVersion != 0x00 && rfidVersion != 0xFF);   // 0x00/0xFF : aucun lecteur sur le bus
  Serial.printf("[RFID] RC522 version 0x%02X : %s\n", rfidVersion, rfidOk ? "OK" : "ABSENT (verifier le cablage)");
#endif

#if defined(ESP32)
  uiBoot("Reseau...", 70);
#endif
  connectWiFi();

  configTime(0, 0, SERVER_HOST, "pool.ntp.org");
#if defined(ESP32)
  tlsClient.setCACert(SENTINEL_CA_PEM);   // mbedTLS : vérifie la chaîne et le nom/IP du serveur (SAN du certificat)
#else
  tlsClient.setTrustAnchors(&caCert);
#endif
  
  mqttClient.setServer(SERVER_HOST, MQTT_PORT);
  mqttClient.setBufferSize(1024);
  mqttClient.setCallback(onMqttMessage);
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    static unsigned long lastWiFiCheck = 0;
    if (millis() - lastWiFiCheck > 8000) {
      lastWiFiCheck = millis();
#if defined(ESP32)
      // ESP32 : reconnect() pendant une connexion en cours renvoie « sta is connecting, return error » ; on relance proprement.
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASS);
#else
      WiFi.reconnect();
#endif
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
#if defined(ESP32)
  pollButton();
  pollRfid();
  flushEnrollOutbox();
  updateTrap();
#endif

  // Animation physique immédiate de l'alarme (Buzzer + LED Rouge clignotante)
#if defined(ESP32)
  uiUpdate();               // LED, sons et écran animé (10 images/s)
#else
  updateAlarmActuators();
#endif

  unsigned long now = millis();

  if (now - lastSensorReadTime >= 500) {
    lastSensorReadTime = now;
    readSensors();
  }

  if (now - lastTelemetryTime >= 1000) {
    lastTelemetryTime = now;
    sendTelemetry();
  }

#if !defined(ESP32)
  if (now - lastDisplayTime >= 500) {
    lastDisplayTime = now;
    updateDisplay();
  }
#endif
}
