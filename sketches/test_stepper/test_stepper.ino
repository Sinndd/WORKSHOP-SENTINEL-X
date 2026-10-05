#include <Arduino.h>

// Broches reliées aux entrées du driver ULN2003
#define IN1 5  // D1 (GPIO5)
#define IN2 4  // D2 (GPIO4)
#define IN3 14 // D5 (GPIO14)
#define IN4 12 // D6 (GPIO12)

// Séquence 8 demi-pas (Half-step) pour un couple maximal et un mouvement fluide
const int stepSequence[8][4] = {
  {1, 0, 0, 0},
  {1, 1, 0, 0},
  {0, 1, 0, 0},
  {0, 1, 1, 0},
  {0, 0, 1, 0},
  {0, 0, 1, 1},
  {0, 0, 0, 1},
  {1, 0, 0, 1}
};

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n--- TEST MOTEUR PAS-A-PAS 28BYJ-48 ---");

  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
  pinMode(IN3, OUTPUT);
  pinMode(IN4, OUTPUT);

  // Couper le courant au départ
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, LOW);
  digitalWrite(IN3, LOW);
  digitalWrite(IN4, LOW);
}

// Fonction pour faire tourner d'un certain nombre de pas
// clockwise: true (sens horaire), false (sens anti-horaire)
void rotateSteps(int steps, bool clockwise, int stepDelayMicroseconds) {
  for (int i = 0; i < steps; i++) {
    int stepIndex = clockwise ? (i % 8) : (7 - (i % 8));

    digitalWrite(IN1, stepSequence[stepIndex][0]);
    digitalWrite(IN2, stepSequence[stepIndex][1]);
    digitalWrite(IN3, stepSequence[stepIndex][2]);
    digitalWrite(IN4, stepSequence[stepIndex][3]);

    delayMicroseconds(stepDelayMicroseconds);
  }

  // Éteindre les bobines après rotation pour éviter que le moteur ne chauffe
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, LOW);
  digitalWrite(IN3, LOW);
  digitalWrite(IN4, LOW);
}

void loop() {
  Serial.println("-> Rotation Sens Horaire (1/2 Tour)...");
  // 28BYJ-48 : environ 4096 demi-pas pour 1 tour complet (2048 pour 180°)
  rotateSteps(2048, true, 1200);
  delay(1000);

  Serial.println("-> Rotation Sens Anti-Horaire (1/2 Tour)...");
  rotateSteps(2048, false, 1200);
  delay(1500);
}
