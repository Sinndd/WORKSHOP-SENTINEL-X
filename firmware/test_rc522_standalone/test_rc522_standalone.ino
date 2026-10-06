// Test autonome du lecteur RFID RC522 : affiche sur le port série l'UID de chaque badge présenté.
// Moniteur série : 115200 bauds.
//
// ESP32 (DevKit) — câblage de test, noms sérigraphiés :
//   RC522 3.3V -> 3V3 (JAMAIS 5 V)   GND -> GND   SDA(SS) -> D5   RST -> D4
//   SCK -> D18   MISO -> D19   MOSI -> D23   IRQ : non connecté
// ESP8266 (NodeMCU) — câblage de test :
//   RC522 3.3V -> 3V3   GND -> GND   RST -> 3V3   SCK -> D5   MISO -> D6   MOSI -> D7   SDA(SS) -> D4
#include <SPI.h>
#include <MFRC522.h>

#if defined(ESP32)
  #define PIN_SS    5
  #define PIN_RST   4
  #define PIN_SCK   18
  #define PIN_MISO  19
  #define PIN_MOSI  23
#else
  #define PIN_SS    2    // D4 (GPIO2) : HIGH au repos, compatible avec le démarrage
  #define PIN_RST   MFRC522::UNUSED_PIN   // RST relié au 3V3
#endif

MFRC522 rfid(PIN_SS, PIN_RST);

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println(F("\n=== Test RC522 ==="));
#if defined(ESP32)
  SPI.begin(PIN_SCK, PIN_MISO, PIN_MOSI, PIN_SS);
#else
  SPI.begin();
#endif
  rfid.PCD_Init();
  delay(50);
  byte v = rfid.PCD_ReadRegister(MFRC522::VersionReg);
  Serial.print(F("Version du lecteur : 0x")); Serial.print(v, HEX);
  if (v == 0x91 || v == 0x92) Serial.println(F("  -> OK, lecteur detecte"));
  else if (v == 0x00 || v == 0xFF) Serial.println(F("  -> AUCUN lecteur : verifier le cablage (3V3, GND, SCK, MISO, MOSI, SDA, RST)"));
  else Serial.println(F("  -> version inattendue (clone ?), le test continue"));
  Serial.println(F("Approchez un badge..."));
}

void loop() {
  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) return;
  String uid;
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) uid += '0';
    uid += String(rfid.uid.uidByte[i], HEX);
    if (i + 1 < rfid.uid.size) uid += ':';
  }
  uid.toUpperCase();
  MFRC522::PICC_Type type = rfid.PICC_GetType(rfid.uid.sak);
  Serial.print(F("[BADGE] UID=")); Serial.print(uid);
  Serial.print(F("  (")); Serial.print(rfid.uid.size); Serial.print(F(" octets)  type="));
  Serial.println(rfid.PICC_GetTypeName(type));
  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
  delay(400);   // évite de relire le même badge en rafale
}
