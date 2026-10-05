#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
#define SCREEN_ADDRESS 0x3C

#define PIN_SCL 5 // D1 (GPIO5)
#define PIN_SDA 4 // D2 (GPIO4)

#define PIN_RGB_BLUE   14 // D5
#define PIN_RGB_GREEN  12 // D6
#define PIN_RGB_RED    13 // D7
#define PIN_BUZZER     15 // D8 (GPIO15)

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

// Fréquences AIGUËS (Octave 6 & 7 - Mode perce-oreilles strident !)
#define NOTE_C6   1047
#define NOTE_D6   1175
#define NOTE_E6   1319
#define NOTE_G6   1568
#define NOTE_A6   1760
#define NOTE_C7   2093
#define NOTE_D7   2349
#define NOTE_E7   2637
#define NOTE_G7   3136
#define REST      0

int melody[] = {
  NOTE_E7, NOTE_E7, NOTE_D7, NOTE_E7, REST,
  NOTE_G7, NOTE_E7, NOTE_D7, NOTE_C7, REST,
  NOTE_A6, NOTE_C7, NOTE_D7, NOTE_E7,
  NOTE_D7, NOTE_C7, NOTE_A6, REST,

  NOTE_E7, NOTE_E7, NOTE_D7, NOTE_E7, NOTE_G7,
  NOTE_A6, NOTE_G7, NOTE_E7, NOTE_D7,
  NOTE_C7, NOTE_D7, NOTE_E7, NOTE_D7, NOTE_C7,
  NOTE_A6, REST
};

// Durées divisées par 3 (Mode Speedcore ultra rapide !)
int noteDurations[] = {
  70,  70,  70, 100,  30,
 110,  80,  70, 130,  50,
  70,  70,  70, 110,
  80,  80, 150,  60,

  70,  70,  70,  80, 100,
 110,  80,  70, 100,
  70,  70, 100,  80, 110,
 150, 100
};

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

  for (int thisNote = 0; thisNote < totalNotes; thisNote++) {
    int note = melody[thisNote];
    int duration = noteDurations[thisNote];

    // Stroboscope RGB ultra rapide
    digitalWrite(PIN_RGB_RED, (thisNote % 2 == 0) ? HIGH : LOW);
    digitalWrite(PIN_RGB_BLUE, (thisNote % 2 != 0) ? HIGH : LOW);
    digitalWrite(PIN_RGB_GREEN, (thisNote % 3 == 0) ? HIGH : LOW);

    // Écran en mode ALERTE M2LT STROBO
    display.clearDisplay();
    display.setTextSize(2);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 5);
    display.println("!! M2LT !!");
    display.setTextSize(1);
    display.setCursor(0, 30);
    display.println("MODE OREILLES CASSEES");
    display.printf("FREQ: %d Hz\n", note);
    display.drawRect(0, 0, 128, 64, SSD1306_WHITE);
    display.display();

    if (note != REST) {
      tone(PIN_BUZZER, note, duration);
    } else {
      noTone(PIN_BUZZER);
    }

    delay(duration);
    noTone(PIN_BUZZER);
    delay(20);
  }

  // Petit silence de 300ms avant de relancer direct
  delay(300);
}
