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

#define PIN_RGB_BLUE   14 // D5
#define PIN_RGB_GREEN  12 // D6
#define PIN_RGB_RED    13 // D7
#define PIN_BUZZER     15 // D8

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

// Fréquences des notes (Hz)
#define NOTE_C5  523
#define NOTE_D5  587
#define NOTE_E5  659
#define NOTE_F5  698
#define NOTE_G5  784
#define NOTE_A5  880
#define NOTE_B5  988
#define NOTE_C6  1047
#define REST     0

// Notes de Jingle Bells (Vive le vent)
int melody[] = {
  // Jingle bells, jingle bells, jingle all the way
  NOTE_E5, NOTE_E5, NOTE_E5, REST,
  NOTE_E5, NOTE_E5, NOTE_E5, REST,
  NOTE_E5, NOTE_G5, NOTE_C5, NOTE_D5,
  NOTE_E5, REST,

  // Oh what fun it is to ride in a one-horse open sleigh
  NOTE_F5, NOTE_F5, NOTE_F5, NOTE_F5,
  NOTE_F5, NOTE_E5, NOTE_E5, NOTE_E5, NOTE_E5,
  NOTE_E5, NOTE_D5, NOTE_D5, NOTE_E5,
  NOTE_D5, NOTE_G5, REST,

  // Jingle bells, jingle bells, jingle all the way
  NOTE_E5, NOTE_E5, NOTE_E5, REST,
  NOTE_E5, NOTE_E5, NOTE_E5, REST,
  NOTE_E5, NOTE_G5, NOTE_C5, NOTE_D5,
  NOTE_E5, REST,

  // Oh what fun it is to ride in a one-horse open sleigh
  NOTE_F5, NOTE_F5, NOTE_F5, NOTE_F5,
  NOTE_F5, NOTE_E5, NOTE_E5, NOTE_E5, NOTE_E5,
  NOTE_G5, NOTE_G5, NOTE_F5, NOTE_D5,
  NOTE_C5, REST
};

// Durées des notes (en ms)
int durations[] = {
  180, 180, 360, 100,
  180, 180, 360, 100,
  180, 180, 250, 150,
  500, 150,

  180, 180, 250, 150,
  180, 180, 180, 100, 100,
  180, 180, 180, 180,
  360, 360, 150,

  180, 180, 360, 100,
  180, 180, 360, 100,
  180, 180, 250, 150,
  500, 150,

  180, 180, 250, 150,
  180, 180, 180, 100, 100,
  180, 180, 180, 180,
  600, 300
};

void setRGB(bool r, bool g, bool b) {
  digitalWrite(PIN_RGB_RED, r ? HIGH : LOW);
  digitalWrite(PIN_RGB_GREEN, g ? HIGH : LOW);
  digitalWrite(PIN_RGB_BLUE, b ? HIGH : LOW);
}

void setup() {
  pinMode(PIN_RGB_RED, OUTPUT);
  pinMode(PIN_RGB_GREEN, OUTPUT);
  pinMode(PIN_RGB_BLUE, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);

  Wire.begin(PIN_SDA, PIN_SCL);
  display.begin(SSD1306_SWITCHCAPVCC, SCREEN_ADDRESS);
}

void loop() {
  int totalNotes = sizeof(melody) / sizeof(melody[0]);

  for (int i = 0; i < totalNotes; i++) {
    int note = melody[i];
    int duration = durations[i];

    // Ambiance Noël : Alternance Rouge et Vert sur la LED RGB
    if (i % 2 == 0) setRGB(true, false, false); // Rouge Noël
    else setRGB(false, true, false);           // Vert Sapin

    // Écran OLED avec animation sapin et cloches
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(18, 5);
    display.print("* JINGLE BELLS *");
    display.drawLine(0, 16, 127, 16, SSD1306_WHITE);

    // Dessin d'un sapin en géométrie
    display.drawTriangle(64, 22, 50, 35, 78, 35, SSD1306_WHITE);
    display.drawTriangle(64, 30, 44, 46, 84, 46, SSD1306_WHITE);
    display.drawTriangle(64, 38, 38, 58, 90, 58, SSD1306_WHITE);
    display.fillRect(60, 58, 8, 5, SSD1306_WHITE);

    // Étoiles de neige qui clignotent
    if (i % 2 == 0) {
      display.drawPixel(15, 30, SSD1306_WHITE);
      display.drawPixel(25, 45, SSD1306_WHITE);
      display.drawPixel(105, 30, SSD1306_WHITE);
      display.drawPixel(115, 45, SSD1306_WHITE);
    } else {
      display.drawPixel(20, 25, SSD1306_WHITE);
      display.drawPixel(10, 40, SSD1306_WHITE);
      display.drawPixel(110, 25, SSD1306_WHITE);
      display.drawPixel(120, 40, SSD1306_WHITE);
    }

    display.display();

    if (note != REST) {
      tone(PIN_BUZZER, note, duration);
    } else {
      noTone(PIN_BUZZER);
    }

    delay(duration * 1.15);
    noTone(PIN_BUZZER);
  }

  setRGB(false, false, false);
  delay(1200);
}
