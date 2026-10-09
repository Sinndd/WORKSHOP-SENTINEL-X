// Test des contacts en direct : RC522 et MCP23017 sont relus 5 fois par seconde, état sur l'OLED et le port série (115200).
// Bougez les fils / coupez l'alimentation externe pour voir ce qui fait passer le module de OK à ABSENT.
// Si un badge est posé, son UID s'affiche. Câblage : voir docs/CABLAGE-COMPLET.md.
#include <Arduino.h>
#include <Wire.h>
#include <SPI.h>
#include <MFRC522.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
MFRC522 rfid(5, 4);
bool oledOk = false;
uint8_t okRc = 0, koRc = 0, okMcp = 0, koMcp = 0;   // compteurs depuis le démarrage
uint8_t lastRc = 0xEE; int lastMcp = -1;

void setup() {
  Serial.begin(115200); delay(500);
  Wire.begin(21, 22); Wire.setClock(100000);   // 100 kHz : plus tolérant aux fils longs
  oledOk = oled.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  SPI.begin(18, 19, 23, 5);
  pinMode(4, OUTPUT); digitalWrite(4, LOW); delay(50); digitalWrite(4, HIGH); delay(50);
  rfid.PCD_Init();
  Serial.println("\n=== TEST CONTACTS RC522 / MCP23017 ===");
}

void loop() {
  static unsigned long last = 0;
  if (millis() - last < 200) return;
  last = millis();
  byte v = rfid.PCD_ReadRegister(MFRC522::VersionReg);
  bool rc = (v != 0x00 && v != 0xFF);
  Wire.beginTransmission(0x20); bool mcp = (Wire.endTransmission() == 0);
  if (!rc) { pinMode(4, OUTPUT); digitalWrite(4, LOW); delay(20); digitalWrite(4, HIGH); delay(40); rfid.PCD_Init(); }   // tente de le relancer
  (rc ? okRc : koRc)++; (mcp ? okMcp : koMcp)++;
  if (v != lastRc || mcp != lastMcp) { Serial.printf("t=%lus RC522=0x%02X (%s)  MCP=%s\n", millis() / 1000, v, rc ? "OK" : "ABSENT", mcp ? "OK" : "ABSENT"); lastRc = v; lastMcp = mcp; }
  String uid;
  if (rc && rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) {
    for (byte i = 0; i < rfid.uid.size; i++) { if (rfid.uid.uidByte[i] < 0x10) uid += '0'; uid += String(rfid.uid.uidByte[i], HEX); if (i + 1 < rfid.uid.size) uid += ':'; }
    uid.toUpperCase(); rfid.PICC_HaltA(); Serial.println("BADGE " + uid);
  }
  if (!oledOk) return;
  oled.clearDisplay(); oled.setTextColor(SSD1306_WHITE);
  oled.setTextSize(2);
  oled.setCursor(0, 0);  oled.print(rc ? "RC522 OK" : "RC522 --");
  oled.setCursor(0, 20); oled.print(mcp ? "MCP   OK" : "MCP   --");
  oled.setTextSize(1);
  oled.setCursor(0, 42); oled.printf("v=0x%02X  pertes %u/%u", v, koRc, (unsigned)(okRc + koRc));
  oled.setCursor(0, 54); oled.print(uid.length() ? "BADGE " + uid : String("pose un badge..."));
  oled.display();
}
