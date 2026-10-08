// Banc de test des moteurs SENTINEL-X : tête (28BYJ-48 via MCP23017, GPA0..3) + 3 servos MS18 (bras G D32, bras D D15, trappe arrière D2). OLED + série 115200.
// Servos : balayage prudent 60°..120° autour du centre (pas de butée mécanique). Série : h=tête, 1/2/3=servo, s=scan, a=tout.
// ---- (en-tête hérité du banc MCP23017) ----
// Banc de test MCP23017 (extension I/O I2C) + moteur 28BYJ-48 / ULN2003.
// Câblage MCP23017 : VDD 3V3, VSS GND, SDA D21, SCL D22 (même bus que l'OLED), RESET 3V3 (obligatoire), A0 A1 A2 GND (adresse 0x20).
// Moteur n (1..4) : IN1..IN4 = GPA0..3 (m1), GPA4..7 (m2), GPB0..3 (m3), GPB4..7 (m4). Alim ULN2003 en 5 V externe, masse commune avec l'ESP32.
// Séquence auto : 1) scan I2C 2) registres du MCP 3) 16 broches une par une (relecture) 4) 4 moteurs (1 tour aller, 1 tour retour).
// Série : s=scan, r=registres, p=broches, m1..m4=moteur, a=tout, ?=aide. Bouton BOOT : relance la séquence complète.
#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define PIN_SDA 21
#define PIN_SCL 22
#define PIN_BOOT 0
#define MCP_BASE 0x20
#define OLED_ADDR 0x3C
#define STEPS_PER_TURN 4096          // demi-pas, 28BYJ-48
#define STEP_US 1800                 // ~ 4,5 tr/min... assez lent pour être fiable

// Registres (IOCON.BANK = 0)
enum : uint8_t { IODIRA = 0x00, IODIRB = 0x01, GPPUA = 0x0C, GPPUB = 0x0D, GPIOA = 0x12, GPIOB = 0x13, OLATA = 0x14, OLATB = 0x15 };

Adafruit_SSD1306 oled(128, 64, &Wire, -1);
bool oledOk = false;
uint8_t mcpAddr = 0;
const uint8_t HALF[8] = {0x1, 0x3, 0x2, 0x6, 0x4, 0xC, 0x8, 0x9};

void screen(const String& title, const String& l1 = "", const String& l2 = "", const String& l3 = "") {
  Serial.printf("[%s] %s | %s | %s\n", title.c_str(), l1.c_str(), l2.c_str(), l3.c_str());
  if (!oledOk) return;
  oled.clearDisplay(); oled.setTextSize(1); oled.setTextColor(SSD1306_WHITE);
  oled.setCursor(0, 0);  oled.print(title);
  oled.drawLine(0, 10, 127, 10, SSD1306_WHITE);
  oled.setCursor(0, 16); oled.print(l1);
  oled.setCursor(0, 30); oled.print(l2);
  oled.setCursor(0, 44); oled.print(l3);
  oled.display();
}

bool i2cPing(uint8_t a) { Wire.beginTransmission(a); return Wire.endTransmission() == 0; }
bool mcpWrite(uint8_t reg, uint8_t v) { Wire.beginTransmission(mcpAddr); Wire.write(reg); Wire.write(v); return Wire.endTransmission() == 0; }
int mcpRead(uint8_t reg) {
  Wire.beginTransmission(mcpAddr); Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return -1;
  if (Wire.requestFrom(mcpAddr, (uint8_t)1) != 1) return -1;
  return Wire.read();
}

// Le MCP23017 reste en sortie à bas niveau tant qu'on ne l'a pas configuré : tout à 0 = moteurs coupés.
bool mcpAllOff() { return mcpWrite(IODIRA, 0x00) && mcpWrite(IODIRB, 0x00) && mcpWrite(OLATA, 0x00) && mcpWrite(OLATB, 0x00); }
bool mcpSet16(uint16_t v) { return mcpWrite(OLATA, v & 0xFF) && mcpWrite(OLATB, v >> 8); }
int mcpGet16() { int a = mcpRead(GPIOA), b = mcpRead(GPIOB); return (a < 0 || b < 0) ? -1 : (b << 8) | a; }

const char* pinName(int p, char* b) { snprintf(b, 8, "GP%c%d", p < 8 ? 'A' : 'B', p & 7); return b; }

// ---- 1. scan I2C ----
bool testScan() {
  String found; int n = 0; mcpAddr = 0;
  for (uint8_t a = 1; a < 127; a++) if (i2cPing(a)) {
    char b[8]; snprintf(b, sizeof b, "%02X ", a); found += b; n++;
    if (a >= MCP_BASE && a <= MCP_BASE + 7 && !mcpAddr) mcpAddr = a;
  }
  Serial.printf("I2C : %d peripherique(s) : %s\n", n, found.c_str());
  if (mcpAddr) { char b[24]; snprintf(b, sizeof b, "MCP trouve 0x%02X", mcpAddr); screen("1/4 SCAN I2C", found, b, "OK"); }
  else screen("1/4 SCAN I2C", found.length() ? found : "(rien)", "MCP23017 ABSENT", "SDA/SCL/VDD/RESET ?");
  delay(1800);
  return mcpAddr != 0;
}

// ---- 2. registres : écrit/relit des motifs dans les registres de sortie et de direction ----
bool testRegs() {
  const uint8_t pat[3] = {0xAA, 0x55, 0x00};
  bool ok = true;
  for (uint8_t p : pat) {
    mcpWrite(IODIRA, 0x00); mcpWrite(IODIRB, 0x00);
    mcpWrite(OLATA, p); mcpWrite(OLATB, (uint8_t)~p);
    int a = mcpRead(OLATA), b = mcpRead(OLATB);
    if (a != p || b != (uint8_t)~p) { ok = false; Serial.printf("  registre OLAT : ecrit %02X/%02X relu %02X/%02X\n", p, (uint8_t)~p, a, b); }
  }
  mcpAllOff();
  screen("2/4 REGISTRES", ok ? "Ecriture/lecture OK" : "ECHEC relecture", ok ? "puce vivante" : "bus instable ?", ok ? "" : "pull-up, fils, masse");
  delay(1500);
  return ok;
}

// ---- 3. 16 broches : on lève chaque sortie seule et on relit GPIO ----
// Si une sortie est court-circuitée à la masse ou à une voisine, la relecture diffère.
int testPins() {
  int bad = 0; String badList;
  mcpAllOff();
  for (int p = 0; p < 16; p++) {
    char nm[8], l2[24], l3[24];
    mcpSet16(1u << p);
    delay(350);
    int g = mcpGet16();
    bool ok = g == (1 << p);
    int m = p / 4 + 1, in = p % 4 + 1;
    snprintf(l2, sizeof l2, "-> moteur %d IN%d", m, in);
    snprintf(l3, sizeof l3, ok ? "relecture OK" : "ERREUR lu %04X", g < 0 ? 0 : g);
    char t[24]; snprintf(t, sizeof t, "3/4 BROCHE %2d/16", p + 1);
    screen(t, pinName(p, nm), l2, l3);
    if (!ok) { bad++; badList += String(nm) + " "; }
    delay(450);   // temps de voir la LED correspondante s'allumer sur la carte ULN2003
  }
  mcpAllOff();
  screen("3/4 BROCHES", bad ? "ECHEC" : "16/16 OK", bad ? badList : "LED ULN2003 vues ?", bad ? "court-circuit ?" : "");
  delay(1800);
  return bad;
}

// ---- 4. moteurs ----
void motorRun(int m, bool fwd, int steps) {
  int shift = (m - 1) * 4;
  uint16_t mask = 0x0F << shift;
  int idx = 0;
  for (int i = 0; i < steps; i++) {
    idx = (idx + (fwd ? 1 : 7)) & 7;
    uint16_t v = (uint16_t)HALF[idx] << shift;
    if (!mcpSet16(v)) return;                       // bus perdu : on s'arrête
    delayMicroseconds(STEP_US);
  }
  mcpSet16(0);                                     // coupe les bobines (sinon ça chauffe)
  (void)mask;
}
void testMotor(int m) {
  char t[24], l[24]; snprintf(t, sizeof t, "4/4 MOTEUR %d", m);
  snprintf(l, sizeof l, "IN1..4 = GP%c%d..%d", m <= 2 ? 'A' : 'B', ((m - 1) % 2) * 4, ((m - 1) % 2) * 4 + 3);
  screen(t, "Sens horaire 1 tour", l);
  motorRun(m, true, STEPS_PER_TURN);
  delay(300);
  screen(t, "Sens inverse 1 tour", l);
  motorRun(m, false, STEPS_PER_TURN);
  delay(300);
}


// ---- servos (PWM 50 Hz, 16 bits) ----
const uint8_t SERVO_PIN[3] = {32, 15, 2};
const char* SERVO_NAME[3] = {"bras gauche", "bras droit", "trappe arriere"};
void servoWrite(int i, int deg) {
  uint32_t us = 500 + (uint32_t)deg * 2000 / 180;           // 500..2500 us
  ledcWrite(SERVO_PIN[i], (uint32_t)((uint64_t)us * 65535 / 20000));
}
void servoOff(int i) { ledcWrite(SERVO_PIN[i], 0); }
void testServo(int i) {
  char t[24]; snprintf(t, sizeof t, "SERVO %d/3 D%d", i + 1, SERVO_PIN[i]);
  screen(t, SERVO_NAME[i], "centre 90");
  servoWrite(i, 90); delay(800);
  screen(t, SERVO_NAME[i], "vers 120");
  for (int d = 90; d <= 120; d++) { servoWrite(i, d); delay(20); }
  delay(400);
  screen(t, SERVO_NAME[i], "vers 60");
  for (int d = 120; d >= 60; d--) { servoWrite(i, d); delay(20); }
  delay(400);
  screen(t, SERVO_NAME[i], "retour centre");
  for (int d = 60; d <= 90; d++) { servoWrite(i, d); delay(20); }
  delay(500);
  servoOff(i);
}

void runAll() {
  if (!testScan()) { Serial.println("=> STOP : MCP23017 introuvable."); return; }
  bool regs = testRegs();
  int bad = testPins();
  if (!regs || bad) { screen("BILAN", "Corriger le cablage", "avant les moteurs", "(BOOT = relancer)"); return; }
  testMotor(1);
  for (int i = 0; i < 3; i++) testServo(i);
  screen("BILAN", "Tete + 3 servos", "sequences jouees", "BOOT = relancer");
  Serial.println("=> BILAN : tout OK.");
}

void help() { Serial.println("s=scan r=registres p=broches m1..m4=moteur a=tout ?=aide"); }

void setup() {
  Serial.begin(115200); delay(300);
  for (int i = 0; i < 3; i++) { ledcAttach(SERVO_PIN[i], 50, 16); ledcWrite(SERVO_PIN[i], 0); }
  Wire.begin(PIN_SDA, PIN_SCL); Wire.setClock(400000);
  pinMode(PIN_BOOT, INPUT_PULLUP);
  oledOk = i2cPing(OLED_ADDR) && oled.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  screen("TEST MCP23017", "demarrage...");
  help();
  delay(800);
  runAll();
}

void loop() {
  if (digitalRead(PIN_BOOT) == LOW) { delay(60); if (digitalRead(PIN_BOOT) == LOW) { while (digitalRead(PIN_BOOT) == LOW) delay(10); runAll(); } }
  if (!Serial.available()) { delay(10); return; }
  String c = Serial.readStringUntil('\n'); c.trim();
  if (c == "s") testScan();
  else if (c == "r") { if (mcpAddr || testScan()) testRegs(); }
  else if (c == "p") { if (mcpAddr || testScan()) testPins(); }
  else if (c == "a") runAll();
  else if (c == "h") { if (mcpAddr || testScan()) { mcpAllOff(); testMotor(1); } }
  else if (c.length() == 1 && c[0] >= '1' && c[0] <= '3') testServo(c[0] - '1');
  else if (c.length() == 2 && c[0] == 'm' && c[1] >= '1' && c[1] <= '4') { if (mcpAddr || testScan()) { mcpAllOff(); testMotor(c[1] - '0'); } }
  else help();
}
