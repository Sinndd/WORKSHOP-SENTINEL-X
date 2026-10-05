#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
#define SCREEN_ADDRESS 0x3C

#define PIN_SCL 5 // D1
#define PIN_SDA 4 // D2
#define PIN_DHT 2 // D4 (GPIO2)

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

void setup() {
  Serial.begin(115200);
  Wire.begin(PIN_SDA, PIN_SCL);
  display.begin(SSD1306_SWITCHCAPVCC, SCREEN_ADDRESS);
}

void loop() {
  // Test 1: broche configurée en entrée avec pull-up activé
  pinMode(PIN_DHT, INPUT_PULLUP);
  delay(10);
  int stateWithPullup = digitalRead(PIN_DHT);

  // Test 2: broche configurée en entrée flottante
  pinMode(PIN_DHT, INPUT);
  delay(10);
  int stateFloating = digitalRead(PIN_DHT);

  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.print("DIAGNOSTIC BROCHE D4");
  display.drawLine(0, 10, 127, 10, SSD1306_WHITE);

  display.setCursor(0, 18);
  display.printf("Etat Pullup  : %s", stateWithPullup == HIGH ? "HIGH (3.3V)" : "LOW (0V)");

  display.setCursor(0, 32);
  display.printf("Etat Flottant: %s", stateFloating == HIGH ? "HIGH (3.3V)" : "LOW (0V)");

  display.setCursor(0, 48);
  if (stateFloating == HIGH) {
    display.print("Ligne capteur: VCC OK");
  } else {
    display.print("Ligne D4 a 0V (Pas signal)");
  }

  display.display();
  delay(500);
}
