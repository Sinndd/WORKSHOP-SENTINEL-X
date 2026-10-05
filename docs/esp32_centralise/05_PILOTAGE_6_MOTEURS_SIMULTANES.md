# ARCHITECTURE POUR LE PILOTAGE SIMULTANÉ DE 6 MOTEURS PAS-À-PAS

Pour piloter **6 moteurs pas-à-pas 28BYJ-48 de manière 100% indépendante et simultanée**, il faut :
\[
6 \text{ moteurs} \times 4 \text{ bobines} = \mathbf{24 \text{ sorties logiques distinctes}}
\]

---

## 1. Solution Matérielle Retenue : Deux Expanseurs I2C (MCP23017)

Sur le même bus I2C de l'ESP32 (broches **GPIO 21 SDA** et **GPIO 22 SCL**), on connecte simplement **2 puces MCP23017** côte à côte :
- **MCP #1** (Adresses A0, A1, A2 reliées au GND) ➔ Adresse I2C : **`0x20`** (Fournit 16 sorties ➔ **Moteurs 0, 1, 2, 3**)
- **MCP #2** (Broche A0 reliée au 3.3V) ➔ Adresse I2C : **`0x21`** (Fournit 16 sorties ➔ **Moteurs 4 et 5**, avec 8 broches encore libres !)

```
                   ESP32 (GPIO 21 & GPIO 22)
                              |
               +--------------+--------------+
               | (Bus I2C partagé)           |
               v                             v
     [MCP23017 #1 (0x20)]          [MCP23017 #2 (0x21)]
       |     |     |     |           |     |
       v     v     v     v           v     v
     Moteur Moteur Moteur Moteur   Moteur Moteur
       #0    #1    #2    #3          #4    #5
```

---

## 2. Algorithme Multitâche Non-Bloquant (Accélération / Pas Indépendants)

Pour que les moteurs bougent en même temps sans se bloquer mutuellement, le micrologiciel n'utilise **aucun `delay()`**. Chaque moteur possède sa propre structure d'état mise à jour à chaque tour de boucle `loop()` :

```cpp
struct StepperMotor {
  int id;
  uint8_t mcp_address; // 0x20 ou 0x21
  int pin_base;        // Broche de départ (0, 4, 8, 12...)
  long target_steps;   // Pas restant à effectuer
  int direction;       // 1 (CW) ou -1 (CCW)
  unsigned long step_interval_us; // Détermine la vitesse
  unsigned long last_step_time;   // Horodatage du dernier demi-pas
  int current_step_phase;         // Phase actuelle (0 à 7)
  bool is_moving;
};

StepperMotor motors[6];

// Boucle cadencée exécutée à pleine vitesse par le CPU ESP32 :
void updateAllMotors() {
  unsigned long now = micros();
  for (int i = 0; i < 6; i++) {
    if (motors[i].is_moving && (now - motors[i].last_step_time >= motors[i].step_interval_us)) {
      motors[i].last_step_time = now;
      advanceMotorOneStep(i);
      motors[i].target_steps--;
      if (motors[i].target_steps <= 0) {
        motors[i].is_moving = false;
        powerDownMotor(i); // Éteint les bobines pour éviter la chauffe
      }
    }
  }
}
```

### Résultat :
* Le **Moteur 0** peut être en train d'ouvrir le sas lentement.
* Le **Moteur 1** peut tourner à toute vitesse en sens inverse pour fermer la vanne de gaz.
* Les **Moteurs 2, 3, 4 et 5** peuvent démarrer ou s'arrêter à n'importe quel moment sans ralentir les autres !
