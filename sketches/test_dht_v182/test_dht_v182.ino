#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <DHT.h>

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
#define SCREEN_ADDRESS 0x3C

#define PIN_SCL 5 // D1
#define PIN_SDA 4 // D2
#define PIN_MQ_ANALOG A0

// DATA SUR D4 (GPIO2)
#define PIN_DHT 2 // D4

#define PIN_RGB_BLUE   14 // D5
#define PIN_RGB_GREEN  12 // D6
#define PIN_RGB_RED    13 // D7
#define PIN_BUZZER     15 // D8

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

// On teste les deux types au cas où
DHT dht22(PIN_DHT, DHT22);
DHT dht11(PIN_DHT, DHT11);

void setup() {
  Serial.begin(115200);

  pinMode(PIN_RGB_RED, OUTPUT);
  pinMode(PIN_RGB_GREEN, OUTPUT);
  pinMode(PIN_RGB_BLUE, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);

  Wire.begin(PIN_SDA, PIN_SCL);
  display.begin(SSD1306_SWITCHCAPVCC, SCREEN_ADDRESS);

  dht22.begin();
  dht11.begin();
}

void loop() {
  // Test en DHT22
  float t = dht22.readTemperature();
  float h = dht22.readHumidity();
  const char* typeDetected = "DHT22";

  // Si échec en DHT22, tenter en DHT11
  if (isnan(t) || isnan(h)) {
    t = dht11.readTemperature();
    h = dht11.readHumidity();
    typeDetected = "DHT11";
  }

  int gasRaw = analogRead(PIN_MQ_ANALOG);

  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.print("V182 SUR BROCHE D4");
  display.drawLine(0, 10, 127, 10, SSD1306_WHITE);

  display.setCursor(0, 15);
  if (isnan(t)) {
    display.print("Temp: Erreur D4");
  } else {
    display.printf("Temp: %.1f C [%s]", t, typeDetected);
  }

  display.setCursor(0, 28);
  if (isnan(h)) {
    display.print("Hum : Erreur D4");
  } else {
    display.printf("Hum : %.1f %%", h);
  }

  display.setCursor(0, 42);
  display.printf("Gaz : %4d", gasRaw);

  display.setCursor(0, 54);
  if (!isnan(t) && !isnan(h)) {
    display.print("STATUS: CAPTEUR OK");
    digitalWrite(PIN_RGB_GREEN, HIGH);
    digitalWrite(PIN_RGB_RED, LOW);
  } else {
    display.print("Verification broches..");
    digitalWrite(PIN_RGB_GREEN, LOW);
    digitalWrite(PIN_RGB_RED, HIGH);
  }

  display.display();
  delay(2000);
}
