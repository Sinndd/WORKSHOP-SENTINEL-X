#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
#define SCREEN_ADDRESS 0x3C

// I2C OLED
#define PIN_SCL 5 // D1
#define PIN_SDA 4 // D2

// CAPTEUR DE PRÉSENCE SUR D3
#define PIN_PIR 0 // D3 (GPIO0)

// LED RGB KS
#define PIN_RGB_BLUE   14 // D5
#define PIN_RGB_GREEN  12 // D6
#define PIN_RGB_RED    13 // D7

// BUZZER YXDZ
#define PIN_BUZZER     15 // D8

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

int motionCount = 0;
bool lastState = false;

void setup() {
  Serial.begin(115200);

  pinMode(PIN_PIR, INPUT); // Entrée pour le capteur de présence
  pinMode(PIN_RGB_RED, OUTPUT);
  pinMode(PIN_RGB_GREEN, OUTPUT);
  pinMode(PIN_RGB_BLUE, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);

  Wire.begin(PIN_SDA, PIN_SCL);
  display.begin(SSD1306_SWITCHCAPVCC, SCREEN_ADDRESS);

  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(5, 20);
  display.println("CALIBRATION PIR...");
  display.setCursor(5, 35);
  display.println("Attendre 5 sec");
  display.display();
  delay(5000); // Temps de chauffe du capteur PIR
}

void loop() {
  // Lecture de l'état du capteur (HIGH = mouvement détecté, LOW = calme)
  int pirState = digitalRead(PIN_PIR);

  // Si nouveau mouvement détecté
  if (pirState == HIGH && !lastState) {
    motionCount++;
    // Bip court d'alerte
    tone(PIN_BUZZER, 1800, 100);
  }
  lastState = (pirState == HIGH);

  // Gestion affichage et LED RGB
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.print("SENTINEL-X PRESENCE");
  display.drawLine(0, 10, 127, 10, SSD1306_WHITE);

  display.setCursor(0, 18);
  display.printf("Capteur D3 : %s", pirState == HIGH ? "HIGH (3.3V)" : "LOW (0V)");

  display.setCursor(0, 32);
  display.printf("Intrusions : %d fois", motionCount);

  display.setCursor(0, 48);
  if (pirState == HIGH) {
    display.print(">> MOUVEMENT DETECTE! <<");
    // LED Rouge
    digitalWrite(PIN_RGB_RED, HIGH);
    digitalWrite(PIN_RGB_GREEN, LOW);
    digitalWrite(PIN_RGB_BLUE, LOW);
  } else {
    display.print("Zone securisee (OK)");
    // LED Verte
    digitalWrite(PIN_RGB_RED, LOW);
    digitalWrite(PIN_RGB_GREEN, HIGH);
    digitalWrite(PIN_RGB_BLUE, LOW);
  }

  display.display();
  delay(100);
}
