#include <Arduino.h>

#define PIN_LED_BLUE  0  // D3 (GPIO0)
#define PIN_LED_GREEN 2  // D4 (GPIO2)
#define PIN_LED_RED   13 // D7 (GPIO13)
#define PIN_BUZZER    15 // D8 (GPIO15)

void setup() {
  Serial.begin(115200);
  pinMode(PIN_LED_BLUE, OUTPUT);
  pinMode(PIN_LED_GREEN, OUTPUT);
  pinMode(PIN_LED_RED, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);

  // Toutes les LEDs allumées en continu pour tester le branchement
  digitalWrite(PIN_LED_BLUE, HIGH);
  digitalWrite(PIN_LED_GREEN, HIGH);
  digitalWrite(PIN_LED_RED, HIGH);
  digitalWrite(PIN_BUZZER, LOW);
  
  Serial.println("--- TOUTES LES LEDS FORCEES A HIGH ---");
}

void loop() {
  delay(1000);
}
