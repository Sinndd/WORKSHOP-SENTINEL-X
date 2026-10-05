#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
#define SCREEN_ADDRESS 0x3C

#define PIN_SDA 4 // D2 (GPIO4)
#define PIN_SCL 5 // D1 (GPIO5)

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

int counter = 0;

void setup() {
  Serial.begin(115200);
  Wire.begin(PIN_SDA, PIN_SCL);

  if (!display.begin(SSD1306_SWITCHCAPVCC, SCREEN_ADDRESS)) {
    Serial.println(F("Échec initialisation SSD1306"));
    for (;;);
  }

  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(10, 5);
  display.println("SENTINEL-X");
  display.setCursor(10, 20);
  display.println("AetherCorp Ops");
  display.drawRect(5, 0, 118, 62, SSD1306_WHITE);
  display.display();
  delay(1500);
}

void loop() {
  display.clearDisplay();

  // Titre
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(10, 4);
  display.print("TEST SENTINEL-X");
  display.drawLine(0, 14, 127, 14, SSD1306_WHITE);

  // Contenu animé
  display.setCursor(5, 20);
  display.print("Ecran OLED: OK !");

  display.setCursor(5, 34);
  display.printf("Compteur: %d s", counter++);

  display.setCursor(5, 48);
  display.print("Pret pour capteurs");

  // Cadre de bordure
  display.drawRect(0, 0, 128, 64, SSD1306_WHITE);

  display.display();
  delay(1000);
}
