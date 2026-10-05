# CONTRAT D'ÉCHANGE DE DONNÉES & PROTOCOLES (POUR L'ÉQUIPE DEV / BACKEND)

Ce document s'adresse au développeur Backend/Web (EISI DEV). L'ESP32 s'adapte à la technologie retenue côté serveur : **REST HTTP**, **WebSockets en direct** ou **Broker MQTT (Mosquitto)**.

---

## 1. Choix du Protocole de Communication (Laissé au choix du Développeur Backend)

L'ESP32 intègre les bibliothèques pour supporter indifféremment :
1. **Option A — WebSockets bidirectionnels (`ws://` ou `wss://`)** :
   - Établissement d'une connexion permanente persistante à très faible latence (< 5ms).
   - Idéal pour recevoir les flux capteurs en direct et envoyer des ordres moteurs instantanés sans overhead HTTP.
2. **Option B — MQTT (Pub/Sub via Mosquitto)** :
   - Découplage propre par topics (`sentinel/telemetry`, `sentinel/alerts`, `sentinel/commands`).
3. **Option C — API REST (HTTP POST / JSON)** :
   - Requêtes standards `POST` vers les URLs convenues par l'équipe.

---

## 2. Dictionnaire & Formats des Données Émises par l'ESP32

### A. Flux de Télémétrie Périodique (Émis toutes les 1 à 2 secondes)
Données brutes et métriques physiques de la micro-centrale :

| Champ | Type | Unité / Plage | Description |
| :--- | :--- | :--- | :--- |
| `node_id` | String | Ex: `"SENTINEL-X-CORE"` | Identifiant matériel unique de la station |
| `timestamp` | Integer | Millisecondes / UNIX | Horodatage de la mesure |
| `temperature` | Float | Degrés Celsius (°C) | Température captée par le V182 (DHT) |
| `humidity` | Float | Pourcentage (%) | Taux d'humidité relative dans l'air |
| `gas_raw` | Integer | 0 à 4095 (ADC 12 bits) | Concentration brute de gaz / fumées (MH-MQ) |
| `presence_pir` | Boolean | `true` / `false` | Détection infrarouge de mouvement physique |
| `rfid_last_uid` | String | Format Hexa `XX:XX:XX:XX` | Dernier badge scanné (ou `null`) |
| `motors_status` | Array/Obj | États 0 à 5 | Statut opérationnel de chaque moteur (en cours / arrêté) |

#### Exemple de Trame JSON :
```json
{
  "type": "TELEMETRY",
  "node_id": "SENTINEL-X-CORE",
  "timestamp": 1728132000,
  "sensors": {
    "temperature": 23.4,
    "humidity": 48.0,
    "gas_raw": 245,
    "presence_pir": false
  },
  "rfid": {
    "last_badge_uid": "A3:5F:B2:1C",
    "timestamp_last_scan": 1728131950
  },
  "motors": [
    {"id": 0, "name": "SAS_PRINCIPAL", "moving": false, "position_deg": 90},
    {"id": 1, "name": "VANNE_GAZ",     "moving": true,  "position_deg": 45},
    {"id": 2, "name": "BARRIERE_NORD", "moving": false, "position_deg": 0},
    {"id": 3, "name": "BARRIERE_SUD",  "moving": false, "position_deg": 0},
    {"id": 4, "name": "TRAPPE_VENTIL", "moving": false, "position_deg": 180},
    {"id": 5, "name": "VERROU_SECOURS","moving": false, "position_deg": 0}
  ]
}
```

---

### B. Événements d'Alerte Critique (Émis immédiatement lors d'une détection)
Trame envoyée dès qu'un seuil d'urgence est franchi :
```json
{
  "type": "ALERT",
  "event_type": "INTRUSION_DETECTED",
  "severity": "CRITICAL",
  "source": "PIR_SENSOR",
  "details": "Mouvement detecte dans le sas securise",
  "timestamp": 1728132045
}
```

---

### C. Événement de Scan RFID (Contrôle d'accès)
Émis à la seconde exacte où un agent passe son badge :
```json
{
  "type": "RFID_SCAN",
  "card_uid": "A3:5F:B2:1C",
  "timestamp": 1728132100
}
```

---

## 3. Format des Ordres Reçus par l'ESP32 (Contrôle des 6 Moteurs Indépendants)

L'ESP32 intègre un gestionnaire multitâche non-bloquant capable de faire tourner **plusieurs moteurs en même temps**, chacun à une vitesse et un angle différents.

### A. Commande Multi-Moteurs Simultanée
Le serveur Web (ou l'opérateur) peut envoyer une liste d'ordres pour plusieurs moteurs dans **un seul message JSON** :

```json
{
  "action": "CONTROL_MOTORS",
  "commands": [
    {
      "motor_id": 0,
      "direction": "CW",
      "angle_deg": 90,
      "speed_rpm": 12
    },
    {
      "motor_id": 1,
      "direction": "CCW",
      "angle_deg": 180,
      "speed_rpm": 8
    },
    {
      "motor_id": 4,
      "direction": "CW",
      "angle_deg": 45,
      "speed_rpm": 15
    }
  ]
}
```
* **`motor_id`** : Index de 0 à 5 (chacun des 6 moteurs).
* **`direction`** : `"CW"` (Sens horaire / Clockwise) ou `"CCW"` (Sens anti-horaire).
* **`angle_deg`** : Angle de rotation souhaité en degrés (ex: 90° pour ouvrir une porte, 360° pour un tour complet).
* **`speed_rpm`** : Vitesse désirée (tours par minute).

### B. Commande d'Arrêt d'Urgence Global
Stoppe instantanément toutes les bobines de tous les moteurs :
```json
{
  "action": "EMERGENCY_STOP_ALL"
}
```

### C. Décision Serveur pour Accès RFID
Le backend valide si le badge scanné a le droit d'entrer et ordonne à l'ESP32 d'ouvrir le sas :
```json
{
  "action": "ACCESS_DECISION",
  "card_uid": "A3:5F:B2:1C",
  "granted": true,
  "user_name": "Lucas Delon",
  "auto_open_motor_id": 0
}
```
