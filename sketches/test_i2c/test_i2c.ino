#include <Wire.h>

#define PIN_SDA 4 // D2 (GPIO4)
#define PIN_SCL 5 // D1 (GPIO5)

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n--- SCANNER I2C SENTINEL-X ---");
  Wire.begin(PIN_SDA, PIN_SCL);
}

void loop() {
  byte error, address;
  int nDevices = 0;

  Serial.println("Scan du bus I2C en cours...");

  for (address = 1; address < 127; address++) {
    Wire.beginTransmission(address);
    error = Wire.endTransmission();

    if (error == 0) {
      Serial.print(" -> Trouve: 0x");
      if (address < 16) Serial.print("0");
      Serial.print(address, HEX);
      if (address == 0x3C || address == 0x3D) {
        Serial.println(" [OK - Ecran HW-416A OLED SSD1306 !]");
      } else {
        Serial.println();
      }
      nDevices++;
    }
  }

  if (nDevices == 0) {
    Serial.println(" -> Aucun composant I2C detecte.");
  } else {
    Serial.printf("Fin du scan. %d composant(s) connecte(s).\n", nDevices);
  }

  delay(3000);
}
