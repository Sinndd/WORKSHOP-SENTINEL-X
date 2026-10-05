#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
#define SCREEN_ADDRESS 0x3C

// Broches I2C
#define PIN_SCL 5 // D1
#define PIN_SDA 4 // D2

// Broche Analogique Gaz
#define PIN_MQ_ANALOG A0

// Module LED KS RGB
#define PIN_RGB_BLUE   14 // D5
#define PIN_RGB_GREEN  12 // D6
#define PIN_RGB_RED    13 // D7

// Buzzer YXDZ
#define PIN_BUZZER     15 // D8

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

// Historique pour dessiner la courbe sur l'écran
int history[128];
int historyIndex = 0;

void setup() {
  Serial.begin(115200);

  pinMode(PIN_RGB_RED, OUTPUT);
  pinMode(PIN_RGB_GREEN, OUTPUT);
  pinMode(PIN_RGB_BLUE, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);

  digitalWrite(PIN_BUZZER, LOW);

  Wire.begin(PIN_SDA, PIN_SCL);
  display.begin(SSD1306_SWITCHCAPVCC, SCREEN_ADDRESS);

  for (int i = 0; i < 128; i++) history[i] = 0;
}

void loop() {
  // Lecture de la valeur brute du capteur de gaz (0 à 1023)
  int gasRaw = analogRead(PIN_MQ_ANALOG);

  // Mémoriser dans l'historique pour la courbe
  history[historyIndex] = gasRaw;
  historyIndex = (historyIndex + 1) % 128;

  // Gestion des alertes selon le niveau de gaz
  if (gasRaw > 500) {
    // Alerte Critique (Rouge + Bip)
    digitalWrite(PIN_RGB_RED, HIGH);
    digitalWrite(PIN_RGB_GREEN, LOW);
    digitalWrite(PIN_RGB_BLUE, LOW);
    tone(PIN_BUZZER, 2000, 80);
  } else if (gasRaw > 280) {
    // Attention / Hausse suspecte (Orange / Jaune)
    digitalWrite(PIN_RGB_RED, HIGH);
    digitalWrite(PIN_RGB_GREEN, HIGH);
    digitalWrite(PIN_RGB_BLUE, LOW);
    noTone(PIN_BUZZER);
  } else {
    // Nominal / Air propre (Vert)
    digitalWrite(PIN_RGB_RED, LOW);
    digitalWrite(PIN_RGB_GREEN, HIGH);
    digitalWrite(PIN_RGB_BLUE, LOW);
    noTone(PIN_BUZZER);
  }

  // Affichage dynamique sur l'écran OLED
  display.clearDisplay();

  // En-tête
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.printf("GAZ MH-MQ: %4d", gasRaw);

  display.setCursor(85, 0);
  if (gasRaw > 500) {
    display.print("[DANGER]");
  } else if (gasRaw > 280) {
    display.print("[SUSPECT]");
  } else {
    display.print("[AIR OK]");
  }

  display.drawLine(0, 10, 127, 10, SSD1306_WHITE);

  // Dessin de la courbe en temps réel (comme sur un oscilloscope d'usine)
  for (int x = 0; x < 127; x++) {
    int idx1 = (historyIndex + x) % 128;
    int idx2 = (historyIndex + x + 1) % 128;

    // Normalisation de 0-1023 vers la hauteur de l'écran (15 à 63)
    int y1 = 63 - map(constrain(history[idx1], 0, 1000), 0, 1000, 0, 48);
    int y2 = 63 - map(constrain(history[idx2], 0, 1000), 0, 1000, 0, 48);

    display.drawLine(x, y1, x + 1, y2, SSD1306_WHITE);
  }

  display.display();
  delay(100);
}
