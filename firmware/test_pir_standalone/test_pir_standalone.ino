#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define OLED_ADDR 0x3C
Adafruit_SSD1306 display(128, 64, &Wire, -1);

// BROCHE DU CAPTEUR DE PRÉSENCE SUR D3 (GPIO0)
#define PIN_PIR 0 

// ACTIONNEURS POUR RETOUR IMMÉDIAT
#define PIN_RGB_R  13 // D7 (Rouge)
#define PIN_RGB_G  12 // D6 (Vert)
#define PIN_RGB_B  14 // D5 (Bleu)
#define PIN_BUZZER 15 // D8

int motionCount = 0;
bool lastState = false;

void setRGB(bool r, bool g, bool b) {
  digitalWrite(PIN_RGB_R, r ? HIGH : LOW);
  digitalWrite(PIN_RGB_G, g ? HIGH : LOW);
  digitalWrite(PIN_RGB_B, b ? HIGH : LOW);
}

void setup() {
  Serial.begin(115200);

  pinMode(PIN_PIR, INPUT);
  pinMode(PIN_RGB_R, OUTPUT);
  pinMode(PIN_RGB_G, OUTPUT);
  pinMode(PIN_RGB_B, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);

  setRGB(false, false, false);
  digitalWrite(PIN_BUZZER, LOW);

  Wire.begin(4, 5); // D2 SDA, D1 SCL
  display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);

  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 10);
  display.println("TEST CAPTEUR PRESENCE");
  display.setCursor(0, 30);
  display.println("Stabilisation: 3s...");
  display.display();
  delay(3000);
}

void loop() {
  int pirState = digitalRead(PIN_PIR);

  if (pirState == HIGH && !lastState) {
    motionCount++;
    tone(PIN_BUZZER, 2000, 150); // Bip sonore net
  }
  lastState = (pirState == HIGH);

  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  // Titre
  display.setCursor(0, 0);
  display.print("TEST PRESENCE (D3)");
  display.drawLine(0, 10, 127, 10, SSD1306_WHITE);

  // État de la broche D3 en temps réel
  display.setCursor(0, 16);
  display.printf("Signal D3 : %s", pirState == HIGH ? "HIGH (3.3V)" : "LOW (0V)");

  // Compteur
  display.setCursor(0, 30);
  display.printf("Compteur  : %d detections", motionCount);

  // Statut visuel
  display.setCursor(0, 46);
  if (pirState == HIGH) {
    display.print(">> MOUVEMENT VU ! <<");
    setRGB(true, false, false); // Rouge d'alerte
  } else {
    display.print("Zone calme [R.A.S]");
    setRGB(false, true, false); // Vert nominal
  }

  display.display();
  delay(100);
}
