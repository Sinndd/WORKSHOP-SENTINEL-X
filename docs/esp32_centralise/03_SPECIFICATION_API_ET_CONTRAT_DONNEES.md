# CONTRAT D'INTERFACE & SPÉCIFICATIONS DES FLUX DE DONNÉES (API / MQTT)

Ce document formalise les contrats d'échange entre l'**ESP32 Sentinel-X** et le **PC Serveur Local (Backend / IA)**. Il sert de base de développement immédiate pour l'équipe EISI DEV (API REST / WebSockets) et EISI IA (Séries temporelles).

---

## 1. Flux Émis par l'ESP32 vers le Serveur

### A. Télémétrie Périodique (Toutes les 2 secondes)
* **Canaux** : `HTTP POST /api/v1/telemetry` et topic MQTT `sentinel/telemetry`
* **Objectif** : Historisation et alimentation du modèle d'IA de maintenance prédictive (Scikit-Learn).
* **Payload JSON** :
```json
{
  "node_id": "SENTINEL-X-CORE",
  "timestamp": 1728132000,
  "uptime_ms": 142580,
  "metrics": {
    "temperature_celsius": 23.4,
    "humidity_percent": 48.0,
    "gas_raw_ppm": 215,
    "presence_detected": false
  },
  "actuators_state": {
    "airlock_open": false,
    "gas_valve_open": true,
    "ventilation_active": false,
    "barrier_open": false,
    "alarm_active": false
  },
  "system": {
    "wifi_rssi_dbm": -58,
    "free_heap_bytes": 194200
  }
}
```

---

### B. Alertes Critiques Immédiates (Événements)
* **Canal obligatoire sujet** : `HTTP POST /api/v1/alerts`
* **Objectif** : Réceptionner instantanément les incidents critiques pour affichage immédiat sur le Dashboard Web et déclenchement des protocoles de sécurité.
* **Payload JSON** :
```json
{
  "node_id": "SENTINEL-X-CORE",
  "timestamp": 1728132045,
  "event_type": "INTRUSION_DETECTED",
  "severity": "CRITICAL",
  "source_sensor": "PIR_MOTION",
  "value": 1.0,
  "details": "Mouvement anormal detecte dans le perimetre d'acces restreint"
}
```
*Autres valeurs possibles de `event_type`* :
* `GAS_LEAK_WARNING` : Détection cinétique d'une hausse anormale de gaz.
* `THERMAL_RUNAWAY` : Surchauffe de centrale thermique (> 45°C).
* `UNAUTHORIZED_ACCESS` : Tentative de badge RFID inconnu ou révoqué.

---

### C. Événements de Contrôle d'Accès RFID
* **Canaux** : `HTTP POST /api/v1/access/badge` et topic MQTT `sentinel/access`
* **Objectif** : Transmission de l'UID du badge scanné au serveur pour validation d'accès et ouverture du sas.
* **Payload JSON** :
```json
{
  "node_id": "SENTINEL-X-CORE",
  "timestamp": 1728132102,
  "card_uid": "A3:5F:B2:1C",
  "card_type": "MIFARE_CLASSIC",
  "door_id": "AIRLOCK_MAIN"
}
```

---

## 2. Commandes Reçues par l'ESP32 depuis le Serveur (Superviseur)

L'ESP32 écoute en permanence le topic MQTT : **`sentinel/commands`**.

### A. Contrôle du Sas et des Moteurs
```json
{
  "action": "OPERATE_MOTOR",
  "target": "AIRLOCK_MAIN",
  "command": "OPEN",
  "duration_ms": 3000
}
```
*Paramètres valides* :
* `target` : `"AIRLOCK_MAIN"` (Moteur 1), `"GAS_VALVE"` (Moteur 2), `"BARRIER"` (Moteur 3), `"VENT"` (Moteur 4).
* `command` : `"OPEN"`, `"CLOSE"`, `"STOP"`.

### B. Déclenchement / Arrêt d'Urgence de l'Alarme Physique
```json
{
  "action": "TRIGGER_ALARM",
  "state": true,
  "color": "RED",
  "sound": "SIREN_ALERT"
}
```

### C. Réponse du Serveur à une Demande d'Accès RFID
Topic : `sentinel/access/response`
```json
{
  "card_uid": "A3:5F:B2:1C",
  "access_granted": true,
  "user_name": "Ingenieur Lucas Delon",
  "clearance_level": "LEVEL_4_AETHERCORP",
  "auto_unlock_door": true
}
```
*(Si `access_granted` est true, l'ESP32 déclenche automatiquement la rotation du moteur 1 pour ouvrir le sas, passe la LED RGB en Vert et affiche le nom de l'agent sur l'écran OLED !)*
