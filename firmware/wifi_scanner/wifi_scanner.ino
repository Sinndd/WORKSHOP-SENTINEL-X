#include <ESP8266WiFi.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

Adafruit_SSD1306 display(128, 64, &Wire, -1);

void setup() {
  Serial.begin(115200);
  Wire.begin(4, 5); // D2 SDA, D1 SCL
  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("SCANNER WIFI 2.4G");
  display.display();

  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  delay(100);
}

void loop() {
  display.clearDisplay();
  display.setCursor(0, 0);
  display.println("Recherche reseaux...");
  display.display();

  int n = WiFi.scanNetworks();

  display.clearDisplay();
  display.setCursor(0, 0);
  display.printf("Trouves: %d reseaux\n", n);
  display.drawLine(0, 9, 127, 9, SSD1306_WHITE);

  int y = 12;
  for (int i = 0; i < n && i < 5; ++i) {
    display.setCursor(0, y);
    // Tronquer le nom si trop long
    String ssid = WiFi.SSID(i);
    display.printf("%d:%.11s %ddB", i + 1, ssid.c_str(), WiFi.RSSI(i));
    y += 10;
  }
  display.display();

  delay(4000);
}
