#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
#define SCREEN_ADDRESS 0x3C

// Broches I2C
#define PIN_SCL 5 // D1 (GPIO5)
#define PIN_SDA 4 // D2 (GPIO4)

// MODULE LED RGB KS (Cathode Commune)
#define PIN_RGB_BLUE   14 // D5 (GPIO14) -> Broche B
#define PIN_RGB_GREEN  12 // D6 (GPIO12) -> Broche G
#define PIN_RGB_RED    13 // D7 (GPIO13) -> Broche R

// BUZZER YXDZ
#define PIN_BUZZER     15 // D8 (GPIO15)

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

int stepState = 0;

void setRgbColor(bool r, bool g, bool b) {
  digitalWrite(PIN_RGB_RED, r ? HIGH : LOW);
  digitalWrite(PIN_RGB_GREEN, g ? HIGH : LOW);
  digitalWrite(PIN_RGB_BLUE, b ? HIGH : LOW);
}

void setup() {
  Serial.begin(115200);

  pinMode(PIN_RGB_RED, OUTPUT);
  pinMode(PIN_RGB_GREEN, OUTPUT);
  pinMode(PIN_RGB_BLUE, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);

  setRgbColor(false, false, false);
  digitalWrite(PIN_BUZZER, LOW);

  Wire.begin(PIN_SDA, PIN_SCL);
  display.begin(SSD1306_SWITCHCAPVCC, SCREEN_ADDRESS);
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(10, 20);
  display.println("TEST RGB KS INIT");
  display.display();
  delay(1000);
}

void loop() {
  stepState = (stepState + 1) % 5;

  display.clearDisplay();
  display.drawRect(0, 0, 128, 64, SSD1306_WHITE);
  display.setCursor(10, 8);
  display.print("TEST LED RGB KS");
  display.drawLine(0, 20, 127, 20, SSD1306_WHITE);

  if (stepState == 0) {
    // 1. BLEU
    setRgbColor(false, false, true);
    digitalWrite(PIN_BUZZER, LOW);

    display.setCursor(15, 30);
    display.print("COULEUR : BLEU");
    display.setCursor(15, 45);
    display.print("(Broche B sur D5)");
    display.display();
    delay(1200);

  } else if (stepState == 1) {
    // 2. VERT
    setRgbColor(false, true, false);
    digitalWrite(PIN_BUZZER, LOW);

    display.setCursor(15, 30);
    display.print("COULEUR : VERT");
    display.setCursor(15, 45);
    display.print("(Broche G sur D6)");
    display.display();
    delay(1200);

  } else if (stepState == 2) {
    // 3. ROUGE
    setRgbColor(true, false, false);
    digitalWrite(PIN_BUZZER, LOW);

    display.setCursor(15, 30);
    display.print("COULEUR : ROUGE");
    display.setCursor(15, 45);
    display.print("(Broche R sur D7)");
    display.display();
    delay(1200);

  } else if (stepState == 3) {
    // 4. JAUNE (Rouge + Vert)
    setRgbColor(true, true, false);
    digitalWrite(PIN_BUZZER, LOW);

    display.setCursor(15, 30);
    display.print("COULEUR : JAUNE");
    display.setCursor(15, 45);
    display.print("(Pre-alerte IA)");
    display.display();
    delay(1200);

  } else if (stepState == 4) {
    // 5. ROUGE CLIGNOTANT + BUZZER
    display.setCursor(15, 30);
    display.print(">> ALERTE BUZZER <<");
    display.setCursor(15, 45);
    display.print("Rouge clignotant");
    display.display();

    for (int i = 0; i < 3; i++) {
      setRgbColor(true, false, false);
      digitalWrite(PIN_BUZZER, HIGH);
      delay(120);
      setRgbColor(false, false, false);
      digitalWrite(PIN_BUZZER, LOW);
      delay(120);
    }
  }
}
