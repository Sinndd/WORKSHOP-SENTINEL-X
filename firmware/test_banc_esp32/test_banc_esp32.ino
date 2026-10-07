// Banc de test SENTINEL-X (ESP32 DevKit) : teste les éléments un par un, affiche le déroulé et le bilan sur l'OLED et le port série (115200).
// Ordre : OLED, DHT22, MQ-2, LED RGB, buzzer, moteur, RC522, PIR (testé tard : chauffe ~60 s), Wi-Fi. Bouton BOOT : passer l'attente en cours / relancer le bilan.
// Câblage : voir docs/esp32_centralise/02_PINOUT_ET_CABALAGE.md (OLED D21/D22, DHT D14, PIR D13, MQ-2 D34, RGB D25/D26/D27,
// buzzer D33, RC522 SS D5 RST D4 SCK D18 MISO D19 MOSI D23, moteur ULN2003 IN1 D32 IN2 D15 IN3 D2 IN4 D12).
#include <Arduino.h>
#include <Wire.h>
#include <SPI.h>
#include <WiFi.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <DHT.h>
#include <MFRC522.h>
#include "../sentinel_core/secrets.h"   // WIFI_SSID (seul le nom du réseau sert ici)

#define PIN_SDA 21
#define PIN_SCL 22
#define PIN_DHT 14
#define PIN_PIR 13
#define PIN_GAS 34
#define PIN_R 25
#define PIN_G 26
#define PIN_B 27
#define PIN_BUZ 33
#define PIN_SS 5
#define PIN_RST 4
#define PIN_SCK 18
#define PIN_MISO 19
#define PIN_MOSI 23
#define PIN_BOOT 0
const uint8_t MOTOR[4] = {32, 15, 2, 12};   // IN1..IN4 de l'ULN2003

Adafruit_SSD1306 oled(128, 64, &Wire, -1);
DHT dht(PIN_DHT, DHT22);
MFRC522 rfid(PIN_SS, PIN_RST);
bool oledOk = false;

enum { T_PEND = 0, T_OK = 1, T_KO = 2, T_VIS = 3 };    // T_VIS : test visuel/sonore, à constater
const char* NAMES[9] = {"OLED", "DHT22", "MQ-2", "PIR", "LED RGB", "Buzzer", "Moteur", "RC522", "Wi-Fi 2.4G"};
uint8_t res[9];
String detail[9];

bool bootPressed() { return digitalRead(PIN_BOOT) == LOW; }

void screen(const String& title, const String& l1 = "", const String& l2 = "", const String& l3 = "") {
  Serial.printf("[%s] %s | %s | %s\n", title.c_str(), l1.c_str(), l2.c_str(), l3.c_str());
  if (!oledOk) return;
  oled.clearDisplay();
  oled.setTextSize(1);
  oled.setTextColor(SSD1306_WHITE);
  oled.setCursor(0, 0);  oled.print(title);
  oled.drawLine(0, 10, 127, 10, SSD1306_WHITE);
  oled.setCursor(0, 16); oled.print(l1);
  oled.setCursor(0, 30); oled.print(l2);
  oled.setCursor(0, 44); oled.print(l3);
  oled.display();
}

void setRGB(bool r, bool g, bool b) { digitalWrite(PIN_R, r); digitalWrite(PIN_G, g); digitalWrite(PIN_B, b); }

void finish(int i, uint8_t status, const String& d) {
  res[i] = status; detail[i] = d;
  Serial.printf("==> TEST %d %-10s : %s  (%s)\n", i + 1, NAMES[i], status == T_OK ? "OK" : status == T_VIS ? "A CONSTATER" : "ECHEC", d.c_str());
}

// ---- 1. OLED (déjà initialisé dans setup : si on lit ceci à l'écran, c'est bon) ----
void testOled() {
  screen("TEST 1/9  OLED", "Ecran OK si vous", "lisez ce texte", "");
  delay(1500);
  finish(0, oledOk ? T_OK : T_KO, oledOk ? "affichage OK" : "ecran non detecte");
}

// ---- 2. DHT22 ----
void testDht() {
  screen("TEST 2/9  DHT22", "Lecture en cours...");
  float t = NAN, h = NAN;
  for (int k = 0; k < 5 && (isnan(t) || isnan(h)); k++) { delay(2200); t = dht.readTemperature(); h = dht.readHumidity(); }
  if (isnan(t) || isnan(h)) { screen("TEST 2/9  DHT22", "ECHEC", "pas de lecture", "verifier D14, VCC"); finish(1, T_KO, "pas de lecture"); delay(1500); return; }
  char b[40]; snprintf(b, sizeof b, "T=%.1fC H=%.0f%%", t, h);
  screen("TEST 2/9  DHT22", "OK", b); finish(1, T_OK, b); delay(1500);
}

// ---- 3. MQ-2 (lecture analogique, chauffe non attendue : valeurs indicatives) ----
void testGas() {
  screen("TEST 3/9  MQ-2", "Lecture analogique...");
  long sum = 0; int mn = 4095, mx = 0;
  for (int k = 0; k < 20; k++) { int v = analogRead(PIN_GAS); sum += v; mn = min(mn, v); mx = max(mx, v); delay(40); }
  int avg = sum / 20;
  char b[40]; snprintf(b, sizeof b, "brut=%d (%d..%d)", avg, mn, mx);
  bool ok = avg > 5 && avg < 4090;   // 0 = fil debranche/masse, 4095 = court-circuit au 3,3 V
  screen("TEST 3/9  MQ-2", ok ? "OK" : "ECHEC", b, ok ? "souffler: doit monter" : "verifier D34, VCC 5V");
  finish(2, ok ? T_OK : T_KO, b); delay(2000);
}

// ---- 4. PIR (attendre un mouvement, 30 s max) ----
void testPir() {
  unsigned long t0 = millis(); bool seen = false;
  while (millis() - t0 < 40000 && !seen) {
    bool hi = digitalRead(PIN_PIR) == HIGH;
    if (hi) seen = true;
    char b[32]; snprintf(b, sizeof b, "reste %lus", (40000 - (millis() - t0)) / 1000);
    screen("TEST 8/9  PIR", "Bougez la main", hi ? "MOUVEMENT !" : "en attente...", String(b) + "  BOOT=passer");
    if (bootPressed()) break;
    delay(200);
  }
  screen("TEST 8/9  PIR", seen ? "OK mouvement vu" : "ECHEC", seen ? "" : "aucun mouvement");
  finish(3, seen ? T_OK : T_KO, seen ? "mouvement detecte" : "aucun mouvement (chauffe ~60 s ?)"); delay(1200);
}

// ---- 5. LED RGB ----
void testRgb() {
  const char* n[4] = {"ROUGE", "VERT", "BLEU", "BLANC"};
  bool c[4][3] = {{1,0,0},{0,1,0},{0,0,1},{1,1,1}};
  for (int i = 0; i < 4; i++) { setRGB(c[i][0], c[i][1], c[i][2]); screen("TEST 4/9  LED RGB", n[i], "Couleur correcte ?"); delay(900); }
  setRGB(0, 0, 0);
  finish(4, T_VIS, "rouge/vert/bleu/blanc affiches"); 
}

// ---- 6. Buzzer ----
void testBuzzer() {
  screen("TEST 5/9  BUZZER", "3 bips...", "Vous les entendez ?");
  for (int i = 0; i < 3; i++) { tone(PIN_BUZ, 2600); delay(250); noTone(PIN_BUZ); delay(250); }
  digitalWrite(PIN_BUZ, LOW);
  finish(5, T_VIS, "3 bips emis");
}

// ---- 7. Moteur 28BYJ-48 : 1024 demi-pas (~90 deg) dans un sens puis dans l'autre ----
void stepMotor(int steps, int dir) {
  static const uint8_t seq[8][4] = {{1,0,0,0},{1,1,0,0},{0,1,0,0},{0,1,1,0},{0,0,1,0},{0,0,1,1},{0,0,0,1},{1,0,0,1}};
  static int phase = 0;
  for (int s = 0; s < steps; s++) {
    phase = (phase + dir + 8) % 8;
    for (int k = 0; k < 4; k++) digitalWrite(MOTOR[k], seq[phase][k]);
    delay(3);
  }
  for (int k = 0; k < 4; k++) digitalWrite(MOTOR[k], LOW);   // coupe le courant : le moteur chauffe sinon
}
void testMotor() {
  screen("TEST 6/9  MOTEUR", "Sens horaire...", "~90 degres");
  stepMotor(1024, +1); delay(400);
  screen("TEST 6/9  MOTEUR", "Sens inverse...", "retour a 0");
  stepMotor(1024, -1);
  finish(6, T_VIS, "1024 demi-pas aller/retour");
}

// ---- 8. RC522 : version puis un badge (20 s max) ----
void testRfid() {
  SPI.begin(PIN_SCK, PIN_MISO, PIN_MOSI, PIN_SS);
  rfid.PCD_Init(); delay(50);
  byte v = rfid.PCD_ReadRegister(MFRC522::VersionReg);
  char vb[24]; snprintf(vb, sizeof vb, "version 0x%02X", v);
  if (v == 0x00 || v == 0xFF) { screen("TEST 7/9  RC522", "ECHEC", vb, "verifier cablage SPI"); finish(7, T_KO, String(vb) + " : lecteur absent"); delay(2000); return; }
  unsigned long t0 = millis(); String uid;
  while (millis() - t0 < 20000 && uid.length() == 0) {
    char b[32]; snprintf(b, sizeof b, "reste %lus", (20000 - (millis() - t0)) / 1000);
    screen("TEST 7/9  RC522", "Presentez un badge", vb, String(b) + " BOOT=passer");
    if (bootPressed()) break;
    if (rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) {
      for (byte i = 0; i < rfid.uid.size; i++) { if (rfid.uid.uidByte[i] < 0x10) uid += '0'; uid += String(rfid.uid.uidByte[i], HEX); if (i + 1 < rfid.uid.size) uid += ':'; }
      uid.toUpperCase(); rfid.PICC_HaltA(); rfid.PCD_StopCrypto1();
    }
    delay(150);
  }
  if (uid.length()) { screen("TEST 7/9  RC522", "OK badge lu", uid); finish(7, T_OK, uid); }
  else { screen("TEST 7/9  RC522", "lecteur OK", "aucun badge lu"); finish(7, T_KO, String(vb) + ", aucun badge"); }
  delay(1500);
}

// ---- 9. Wi-Fi : le réseau configuré est-il visible en 2,4 GHz ? ----
void testWifi() {
  screen("TEST 9/9  WI-FI", "Scan 2.4 GHz...");
  WiFi.mode(WIFI_STA); WiFi.disconnect();
  int n = WiFi.scanNetworks();
  int found = -1;
  for (int i = 0; i < n; i++) if (WiFi.SSID(i) == WIFI_SSID) { found = i; break; }
  char b[40];
  if (found >= 0) { snprintf(b, sizeof b, "canal %d, %d dBm", WiFi.channel(found), WiFi.RSSI(found)); screen("TEST 9/9  WI-FI", "OK reseau visible", b); finish(8, T_OK, b); }
  else { snprintf(b, sizeof b, "%d reseaux, cible absente", n); screen("TEST 9/9  WI-FI", "ECHEC", "hotspot invisible", "activer bande 2,4 GHz"); finish(8, T_KO, b); }
  delay(1800);
}

// ---- Bilan (2 pages alternées) ----
void summary() {
  int ok = 0, ko = 0, vis = 0;
  for (int i = 0; i < 9; i++) { if (res[i] == T_OK) ok++; else if (res[i] == T_KO) ko++; else if (res[i] == T_VIS) vis++; }
  Serial.printf("\n===== BILAN : %d OK, %d a constater, %d ECHEC =====\n", ok, vis, ko);
  for (int i = 0; i < 9; i++) Serial.printf("  %-11s %s  %s\n", NAMES[i], res[i] == T_OK ? "OK " : res[i] == T_VIS ? "VIS" : "KO ", detail[i].c_str());
  Serial.println("(BOOT = relancer le test)");
  unsigned long page = 0;
  while (!bootPressed()) {
    if (oledOk) {
      oled.clearDisplay(); oled.setTextSize(1); oled.setTextColor(SSD1306_WHITE);
      oled.setCursor(0, 0); oled.printf("BILAN %d/%d %s", ok + vis, 9, ko ? "ECHEC" : "OK");
      oled.drawLine(0, 10, 127, 10, SSD1306_WHITE);
      int from = (page % 2) ? 5 : 0, to = (page % 2) ? 9 : 5;
      for (int i = from, y = 14; i < to; i++, y += 10) {
        oled.setCursor(0, y); oled.printf("%-10s %s", NAMES[i], res[i] == T_OK ? "OK" : res[i] == T_VIS ? "VU?" : "KO");
      }
      oled.setCursor(0, 56); oled.print(page % 2 ? "2/2  BOOT=relancer" : "1/2  BOOT=relancer");
      oled.display();
    }
    page++;
    for (int k = 0; k < 30 && !bootPressed(); k++) delay(100);
  }
  while (bootPressed()) delay(20);
}

void runAll() {
  memset(res, 0, sizeof res);
  testOled(); testDht(); testGas(); testRgb(); testBuzzer(); testMotor(); testRfid(); testPir(); testWifi();   // PIR en fin : chauffe ~60 s depuis le démarrage
  summary();
}

void setup() {
  Serial.begin(115200); delay(500);
  Serial.println(F("\n=== BANC DE TEST SENTINEL-X (ESP32) ==="));
  pinMode(PIN_BOOT, INPUT_PULLUP);
  pinMode(PIN_PIR, INPUT_PULLDOWN);
  pinMode(PIN_R, OUTPUT); pinMode(PIN_G, OUTPUT); pinMode(PIN_B, OUTPUT); pinMode(PIN_BUZ, OUTPUT);
  digitalWrite(PIN_BUZ, LOW); setRGB(0, 0, 0);
  for (int k = 0; k < 4; k++) { pinMode(MOTOR[k], OUTPUT); digitalWrite(MOTOR[k], LOW); }
  analogReadResolution(12); analogSetPinAttenuation(PIN_GAS, ADC_11db);
  Wire.begin(PIN_SDA, PIN_SCL);
  oledOk = oled.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  dht.begin();
  screen("SENTINEL-X", "Banc de test", "demarrage...");
  delay(1000);
}

void loop() { runAll(); }
