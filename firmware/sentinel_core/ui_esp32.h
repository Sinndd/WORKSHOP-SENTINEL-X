// Interface ESP32 : écran OLED animé, LED RGB en PWM et sons non bloquants.
// Inclus par sentinel_core.ino (ESP32 uniquement, après les définitions de la trappe et des badges).
//
// Une seule fonction est appelée dans loop() : uiUpdate(). Elle choisit l'écran, la couleur de la LED et le son selon une
// priorité unique : alarme gaz/superviseur > intrusion > événement de badge > mode écriture > trappe en mouvement > réseau > nominal.
#pragma once

// ===================================================================================================
// Événements ponctuels à plein écran (la déclaration de Overlay et de uiOverlay() est dans le sketch)
// ===================================================================================================
static Overlay ovKind = OV_NONE;
static String ovLine1, ovLine2;
static unsigned long ovStart = 0, ovUntil = 0;
unsigned long intrusionUntil = 0;     // armé par readSensors() quand le PIR déclenche une alerte d'intrusion

void uiOverlay(Overlay kind, const String& line1, const String& line2, unsigned long ms) {
  ovKind = kind; ovLine1 = line1; ovLine2 = line2; ovStart = millis(); ovUntil = ovStart + ms;
}
static bool overlayActive() { return ovKind != OV_NONE && millis() < ovUntil; }
static bool inGasAlarm()    { return localGasAlarm || alarmActive; }
static bool inIntrusion()   { return millis() < intrusionUntil; }

// ===================================================================================================
// LED RGB en PWM (correction gamma : l'œil perçoit la luminosité de façon non linéaire)
// ===================================================================================================
static uint8_t gamma8(uint8_t v) { return (uint8_t)(((uint16_t)v * v) / 255); }
void ledRGB(uint8_t r, uint8_t g, uint8_t b) {
  analogWrite(PIN_RGB_R, gamma8(r)); analogWrite(PIN_RGB_G, gamma8(g)); analogWrite(PIN_RGB_B, gamma8(b));
}
// Intensité qui « respire » entre lo et hi sur la période donnée.
static uint8_t breathe(unsigned long periodMs, uint8_t lo, uint8_t hi) {
  float phase = (millis() % periodMs) / (float)periodMs;
  float s = (sinf(2.0f * PI * phase - PI / 2.0f) + 1.0f) / 2.0f;
  return (uint8_t)(lo + (hi - lo) * s);
}

static void uiUpdateLed() {
  static unsigned long last = 0;
  unsigned long now = millis();
  if (now - last < 15) return;
  last = now;

  if (inGasAlarm()) {                                   // flash rouge, éclair blanc, rouge sombre
    unsigned long p = now % 300;
    if (p < 110) ledRGB(255, 0, 0); else if (p < 160) ledRGB(255, 255, 255); else ledRGB(60, 0, 0);
    return;
  }
  if (inIntrusion()) { bool a = (now / 140) % 2; ledRGB(a ? 0 : 255, 0, a ? 255 : 0); return; }   // rouge / bleu alternés
  if (overlayActive()) {
    unsigned long p = now - ovStart;
    switch (ovKind) {
      case OV_GRANTED:    if (p < 150) ledRGB(200, 255, 200); else ledRGB(0, 255, 0); return;
      case OV_DENIED:     if (p < 750 && (p / 150) % 2 == 0) ledRGB(255, 0, 0); else ledRGB(70, 0, 0); return;
      case OV_CLONE:      if ((p / 80) % 2) ledRGB(255, 255, 255); else ledRGB(255, 0, 0); return;
      case OV_ENROLLED:   if ((p / 200) % 2) ledRGB(0, 255, 120); else ledRGB(0, 160, 255); return;
      case OV_ENROLL_FAIL: if ((p / 150) % 2 == 0) ledRGB(255, 100, 0); else ledRGB(0, 0, 0); return;
      default: break;
    }
  }
  if (enrollMode) { uint8_t v = breathe(900, 20, 255); ledRGB(0, (uint8_t)(v * 0.6f), v); return; }   // cyan qui pulse
  if (trapState == TRAP_OPENING || trapState == TRAP_CLOSING) { uint8_t v = breathe(300, 60, 255); ledRGB(v, (uint8_t)(v * 0.4f), 0); return; }   // ambre
  if (trapState == TRAP_OPEN) { ledRGB(0, breathe(1200, 120, 255), 0); return; }
  if (WiFi.status() != WL_CONNECTED) { ledRGB(0, 0, breathe(800, 20, 255)); return; }                // bleu : Wi-Fi absent
  if (!mqttClient.connected()) { uint8_t v = breathe(1600, 15, 140); ledRGB(v, (uint8_t)(v * 0.35f), 0); return; }   // orange : serveur absent
  ledRGB(0, breathe(3000, 6, 70), 0);                                                                // vert qui respire
}

// ===================================================================================================
// Sons : séquences de notes (carillons) et sons continus (alarmes), sans delay()
// ===================================================================================================
struct Note { uint16_t f; uint16_t ms; };           // f = 0 : silence
static const Note SND_GRANT[]    = {{880, 90}, {0, 30}, {1320, 170}};
static const Note SND_DENY[]     = {{300, 150}, {0, 70}, {300, 260}};
static const Note SND_CLONE[]    = {{1800, 100}, {900, 100}, {1800, 100}, {900, 100}, {1800, 100}, {900, 100}};
static const Note SND_ENROLLED[] = {{880, 90}, {1100, 90}, {1320, 90}, {1760, 220}};
static const Note* sndSeq = nullptr;
static uint8_t sndLen = 0, sndIdx = 0;
static unsigned long sndNoteUntil = 0;
static bool buzzing = false;

static void playSound(const Note* s, uint8_t n) { sndSeq = s; sndLen = n; sndIdx = 0; sndNoteUntil = 0; }
void soundGrant()    { playSound(SND_GRANT, sizeof SND_GRANT / sizeof(Note)); }
void soundDeny()     { playSound(SND_DENY, sizeof SND_DENY / sizeof(Note)); }
void soundClone()    { playSound(SND_CLONE, sizeof SND_CLONE / sizeof(Note)); }
void soundEnrolled() { playSound(SND_ENROLLED, sizeof SND_ENROLLED / sizeof(Note)); }

static void buzz(uint16_t freq) {                   // freq = 0 : silence ; n'écrit sur la broche que si l'état change
  if (freq) { tone(PIN_BUZZER, freq); buzzing = true; }
  else if (buzzing) { noTone(PIN_BUZZER); digitalWrite(PIN_BUZZER, LOW); buzzing = false; }
}

static void uiUpdateSound() {
  unsigned long now = millis();
  if (sndSeq) {                                     // une séquence en cours : prioritaire, même sur l'alarme
    if (now >= sndNoteUntil) {
      if (sndIdx >= sndLen) { sndSeq = nullptr; buzz(0); }
      else { const Note n = sndSeq[sndIdx++]; buzz(n.f); sndNoteUntil = now + n.ms; }
    }
    return;
  }
  static unsigned long lastUpd = 0;
  if (now - lastUpd < 25) return;
  lastUpd = now;
  if (inGasAlarm()) {                               // sirène : balayage 1200 -> 2600 Hz par seconde
    unsigned long p = now % 1000;
    float tri = p < 500 ? p / 500.0f : (1000 - p) / 500.0f;
    buzz((uint16_t)(1200 + 1400 * tri));
  } else if (inIntrusion()) {                       // trois bips brefs par seconde
    buzz((now % 500) < 150 ? 2800 : 0);
  } else buzz(0);
}

// ===================================================================================================
// Dessin
// ===================================================================================================
static void drawWifiBars(int x, int y) {            // 4 barres, nombre selon le signal ; dessinées en noir (sur bandeau blanc)
  int rssi = WiFi.RSSI();
  int lvl = WiFi.status() != WL_CONNECTED ? 0 : rssi > -55 ? 4 : rssi > -65 ? 3 : rssi > -75 ? 2 : 1;
  for (int i = 0; i < 4; i++) {
    int h = 2 + 2 * i;
    if (i < lvl) display.fillRect(x + i * 4, y + 8 - h, 3, h, BLACK);
    else display.drawPixel(x + i * 4 + 1, y + 7, BLACK);
  }
}

static void bandTop(const char* title) {            // bandeau blanc en haut, texte noir
  display.fillRect(0, 0, 128, 11, WHITE);
  display.setTextColor(BLACK); display.setTextSize(1);
  display.setCursor(3, 2); display.print(title);
}

static void bandBottom(const String& s) {           // bandeau blanc en bas ; texte long : défilement horizontal
  display.fillRect(0, 55, 128, 9, WHITE);
  display.setTextColor(BLACK); display.setTextSize(1);
  int w = s.length() * 6;
  if (w <= 124) { display.setCursor(2, 56); display.print(s); return; }
  int span = w + 30, off = (millis() / 35) % span;
  display.setCursor(2 - off, 56); display.print(s);
  display.setCursor(2 - off + span, 56); display.print(s);
}

static void hazard(int y, int h, long phase) {      // bande de danger : rayures obliques blanches qui défilent
  for (int r = 0; r < h; r++)
    for (int x = 0; x < 128; x++)
      if ((((x + r + phase) % 16 + 16) % 16) < 8) display.drawPixel(x, y + r, WHITE);
}

static void drawCheck(int x, int y) {
  for (int t = 0; t < 3; t++) { display.drawLine(x + 2, y + 11 + t, x + 9, y + 18 + t, WHITE); display.drawLine(x + 9, y + 18 + t, x + 25, y + 2 + t, WHITE); }
}
static void drawCross(int x, int y) {
  for (int t = 0; t < 3; t++) { display.drawLine(x + t, y + 2, x + 22 + t, y + 24, WHITE); display.drawLine(x + 22 + t, y + 2, x + t, y + 24, WHITE); }
}
static void drawWarning(int cx, int cy) {           // triangle plein avec point d'exclamation
  display.fillTriangle(cx, cy - 15, cx - 17, cy + 15, cx + 17, cy + 15, WHITE);
  display.fillRect(cx - 1, cy - 6, 3, 12, BLACK);
  display.fillRect(cx - 1, cy + 9, 3, 3, BLACK);
}
static void drawLock(int x, int y, bool open) {
  display.drawRect(x, y + 3, 7, 5, WHITE);
  display.drawLine(x + 1, y + 3, x + 1, y + (open ? 0 : 1), WHITE);
  display.drawLine(x + 1, y + (open ? 0 : 1), x + 5, y + (open ? 0 : 1), WHITE);
  display.drawLine(x + 5, y + (open ? 0 : 1), x + 5, y + (open ? 1 : 3), WHITE);
}

static const char* trapLabel() {
  switch (trapState) { case TRAP_OPENING: return "OUVRE"; case TRAP_OPEN: return "OUVERTE"; case TRAP_CLOSING: return "FERME"; default: return "FERMEE"; }
}

// ---- Écran nominal : bandeaux blancs, grandes valeurs, jauge de gaz --------------------------------
static void screenNormal() {
  unsigned long now = millis();
  display.clearDisplay(); display.setTextWrap(false);
  bandTop("SENTINEL-X");
  if ((now / 500) % 2 == 0) display.fillCircle(75, 5, 2, BLACK); else display.drawCircle(75, 5, 2, BLACK);   // pouls
  display.setCursor(86, 2); display.print(mqttClient.connected() ? "TLS" : "---");
  drawWifiBars(110, 2);

  display.setTextColor(WHITE);
  display.setTextSize(2);
  display.setCursor(0, 13); display.print(isnan(temperature) ? String("--.-") : String(temperature, 1));
  display.setCursor(76, 13); display.print(isnan(humidity) ? String("--%") : String(humidity, 0) + "%");
  display.setTextSize(1);
  display.drawCircle(52, 15, 1, WHITE); display.setCursor(56, 13); display.print("C");
  display.setCursor(0, 29); display.print("TEMPERATURE");
  display.setCursor(76, 29); display.print("HUMIDITE");

  display.setCursor(0, 38); display.print("GAZ");
  display.drawRect(22, 37, 78, 8, WHITE);
  int fullScale = GAS_ALARM_RAW * 2;
  int fill = constrain((long)gasRaw * 74 / fullScale, 0, 74);
  display.fillRect(24, 39, fill, 4, WHITE);
  display.drawLine(22 + 39, 35, 22 + 39, 46, WHITE);                       // repère du seuil d'alarme
  display.setCursor(104, 38); display.print(gasRaw);

  display.setCursor(0, 47);
  display.print("PIR "); display.print(pirWarmingUp() ? "CHAUF" : (presenceDetected ? "MVT!" : "OK"));
  if (presenceDetected && (now / 250) % 2 == 0) display.fillCircle(46, 50, 2, WHITE);    // voyant de mouvement
  drawLock(80, 46, trapState != TRAP_CLOSED);
  display.setCursor(90, 47); display.print(trapLabel());

  String foot = (millis() < accessLineUntil) ? accessLine
              : (WiFi.status() == WL_CONNECTED ? "IP " + WiFi.localIP().toString() + "  " + String(WiFi.RSSI()) + "dBm" : String("Recherche Wi-Fi..."));
  bandBottom(foot);
}

// ---- Écran d'alarme : bandes de danger défilantes + triangle + clignotement inversé -----------------
static void screenAlarm(const char* title, const char* l1, const char* l2) {
  unsigned long now = millis();
  display.clearDisplay(); display.setTextWrap(false);
  hazard(0, 9, now / 35);
  hazard(55, 9, -(long)(now / 35));
  drawWarning(24, 32);
  display.setTextColor(WHITE); display.setTextSize(2);
  display.setCursor(48, 15); display.print(title);
  display.setTextSize(1);
  display.setCursor(48, 35); display.print(l1);
  display.setCursor(48, 45); display.print(l2);
}

// ---- Écrans d'événements de badge ---------------------------------------------------------------------
static void screenOverlay() {
  unsigned long now = millis();
  display.clearDisplay(); display.setTextWrap(false);
  const char* title = "";
  switch (ovKind) {
    case OV_GRANTED: title = "ACCES AUTORISE"; drawCheck(6, 16); break;
    case OV_DENIED: title = "ACCES REFUSE"; drawCross(8, 17); break;
    case OV_CLONE: title = "COPIE SUSPECTE"; drawWarning(20, 32); break;
    case OV_ENROLLED: title = "BADGE ENROLE"; drawCheck(6, 16); break;
    case OV_ENROLL_FAIL: title = "ECHEC ENROLEMENT"; drawCross(8, 17); break;
    default: break;
  }
  display.setTextColor(WHITE); display.setTextSize(1);
  display.setCursor(42, 18); display.print(ovLine1.substring(0, 14));
  display.setCursor(42, 30); display.print(ovLine2.substring(0, 14));
  // Barre : avancement de la trappe pendant l'ouverture, sinon temps restant de l'écran
  int w;
  if (ovKind == OV_GRANTED) { display.setCursor(6, 42); display.print("TRAPPE"); w = (int)(112L * trapPos / TRAP_STEPS); }
  else w = (int)(112L * (ovUntil > now ? ovUntil - now : 0) / max(1UL, ovUntil - ovStart));
  display.drawRect(6, 51, 116, 3, WHITE);
  display.fillRect(8, 51, constrain(w, 0, 112), 3, WHITE);
  bandTop(title);
}

// ---- Mode écriture : radar qui s'étend autour d'un badge --------------------------------------------------
static void screenEnroll() {
  unsigned long now = millis();
  display.clearDisplay(); display.setTextWrap(false);
  for (int k = 0; k < 3; k++) display.drawCircle(30, 36, 4 + (int)((now / 55 + k * 12) % 34), WHITE);   // ondes
  display.fillRoundRect(13, 26, 34, 22, 3, BLACK);
  display.drawRoundRect(13, 26, 34, 22, 3, WHITE);                       // le badge
  display.fillRect(18, 31, 8, 6, WHITE);                                  // sa puce
  display.setTextColor(WHITE); display.setTextSize(1);
  display.setCursor(62, 22); display.print("Presentez");
  display.setCursor(62, 32); display.print("un badge");
  display.setCursor(62, 42); display.print("VIERGE");
  bandTop("MODE ECRITURE");
  unsigned long left = enrollUntil > now ? (enrollUntil - now) / 1000 : 0;
  bandBottom("reste " + String(left) + " s    BOOT=annuler");
}

// ---- Démarrage et connexion Wi-Fi (appelés avant que loop() ne tourne) ------------------------------------
void uiBoot(const char* msg, int pct) {
  display.clearDisplay(); display.setTextWrap(false);
  display.fillRect(0, 0, 128, 9, WHITE);
  display.setTextColor(BLACK); display.setTextSize(1); display.setCursor(18, 1); display.print("SURVEILLANCE ACTIVE");
  display.setTextColor(WHITE); display.setTextSize(2); display.setCursor(4, 16); display.print("SENTINEL-X");
  display.drawRect(4, 40, 120, 7, WHITE);
  display.fillRect(6, 42, constrain(pct, 0, 100) * 116 / 100, 3, WHITE);
  display.setTextSize(1); display.setCursor(4, 52); display.print(msg);
  display.display();
}
void uiConnecting(int tries) {
  display.clearDisplay(); display.setTextWrap(false);
  bandTop("RESEAU");
  for (int i = 0; i < 8; i++) {                                           // anneau de points, un point plein qui tourne
    float a = 2.0f * PI * i / 8.0f;
    int x = 22 + (int)(11 * cosf(a)), y = 38 + (int)(11 * sinf(a));
    if (i == tries % 8) display.fillCircle(x, y, 2, WHITE); else display.drawPixel(x, y, WHITE);
  }
  display.setTextColor(WHITE); display.setTextSize(1);
  display.setCursor(46, 22); display.print("Connexion Wi-Fi");
  display.setCursor(46, 34); display.print(String(WIFI_SSID).substring(0, 13));
  display.setCursor(46, 46); for (int i = 0; i < (tries % 4); i++) display.print('.');
  display.display();
}

// ===================================================================================================
// Point d'entrée : à appeler à chaque tour de loop()
// ===================================================================================================
static void uiUpdateDisplay() {
  static unsigned long last = 0;
  static bool inverted = false;
  unsigned long now = millis();
  if (now - last < 100) return;                                           // 10 images par seconde
  last = now;
  bool strobe = false;
  if (inGasAlarm()) {
    screenAlarm(alarmActive && !localGasAlarm ? "ALARME" : "GAZ !", alarmActive && !localGasAlarm ? "SUPERVISION" : "CONCENTRATION", alarmActive && !localGasAlarm ? "A DISTANCE" : "ELEVEE");
    strobe = (now / 250) % 2 == 0;
  } else if (inIntrusion()) {
    screenAlarm("ALERTE", "INTRUSION", "DETECTEE");
    strobe = (now / 250) % 2 == 0;
  } else if (overlayActive()) {
    screenOverlay();
    strobe = ovKind == OV_CLONE && (now / 200) % 2 == 0;
  } else if (enrollMode) {
    screenEnroll();
  } else {
    screenNormal();
  }
  if (strobe != inverted) { display.invertDisplay(strobe); inverted = strobe; }   // flash plein écran des alarmes
  display.display();
}

void uiUpdate() {
  uiUpdateLed();
  uiUpdateSound();
  uiUpdateDisplay();
}
