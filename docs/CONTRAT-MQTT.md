# Contrat MQTT — SENTINEL-X (v2, module ESP32)

> **Source de vérité** des échanges entre le module **ESP32 SENTINEL-X-CORE**, le PC Serveur Local (ingestor, API)
> et le script IA. Il est construit à partir des spécifications matérielles : `01_ARCHITECTURE_GLOBALE`,
> `03_SPECIFICATION_API_ET_CONTRAT_DONNEES` (référence principale), `03_CONTRAT_DONNEES_ET_COMMUNICATION`,
> `04_FIRMWARE_ESP32_COMPLET` et `05_PILOTAGE_6_MOTEURS_SIMULTANES`.
> API REST : [API.md](API.md). Ne renommer aucun topic ni champ sans prévenir toute l'équipe.

## 1. Connexion au broker

| Paramètre | Valeur |
|---|---|
| Hôte | `192.168.10.1` (point d'accès Wi-Fi de la table) |
| Port | **8883, MQTTS uniquement**. Le port 1883 n'existe pas : le firmware `04` doit être adapté (§ 6). |
| TLS | 1.2 minimum. Certificat serveur ECDSA P-256 signé par la **CA interne** (`mosquitto/certs/ca.crt`, ou `ca_cert.h` pour le firmware) |
| Authentification | utilisateur + mot de passe obligatoires (pas d'anonyme). Mots de passe dans le `.env` du Pi |
| Protocole | MQTT 3.1.1. Une publication interdite par l'ACL est **ignorée silencieusement** |

| Compte | Utilisé par | Publie | S'abonne |
|---|---|---|---|
| `esp32` | module ESP32 | `sentinel/telemetry`, `sentinel/alerts`, `sentinel/access`, `sentinel/enroll` | `sentinel/commands`, `sentinel/access/response` |
| `ingestor` | ingestion → PostgreSQL | — | `sentinel/telemetry`, `sentinel/alerts`, `sentinel/vision/events` |
| `api` | API REST | `sentinel/commands`, `sentinel/access/response` | `sentinel/#` |
| `vision` | script IA caméra | `sentinel/vision/events` | — |

## 2. Topics

| Topic | Sens | QoS | Fréquence | Traité par |
|---|---|---|---|---|
| `sentinel/telemetry` | ESP32 → serveur | 0 | toutes les 2 s | ingestor |
| `sentinel/alerts` | ESP32 → serveur | 1 | sur événement | ingestor (aussi possible en `POST /api/v1/alerts`) |
| `sentinel/access` | ESP32 → serveur | 1 | à chaque badge | API (décision d'accès) |
| `sentinel/access/response` | serveur → ESP32 | 1 | en réponse à `sentinel/access` | firmware |
| `sentinel/enroll` | ESP32 → serveur | 0 | pendant un enrôlement de badge | API (§ 4.4) |
| `sentinel/commands` | serveur → ESP32 | 1 | sur ordre (`POST /api/v1/commands`) | firmware |
| `sentinel/vision/events` | script IA → serveur | 1 | sur détection | ingestor |

Aucun message n'est publié en *retained*.

## 3. Règles communes

- JSON UTF-8, **< 1 Ko** par message (rejeté côté serveur au-delà de 2 Ko).
- `node_id` : identifiant du module, `"SENTINEL-X-CORE"` (lettres, chiffres, `-`, `_` ; 32 caractères max).
- `timestamp` (entier) : **epoch Unix en secondes** (ou en millisecondes). Une autre valeur, comme `millis()`
  depuis le démarrage dans le firmware `04` actuel, est conservée telle quelle (`device_timestamp`), et le
  serveur horodate alors le message à sa réception. Recommandé : synchroniser l'ESP32 en NTP sur `192.168.10.1`.
- Le serveur ajoute toujours `received_at` (horloge du Pi).
- Les valeurs d'énumération sont en **MAJUSCULES** et sensibles à la casse.
- Champs inconnus : tolérés et ignorés. Exemple : `"type": "TELEMETRY"` de `03_CONTRAT`, ou un tableau `motors`.
- Un message invalide est **rejeté et journalisé**, sans interrompre le service.

## 4. Messages émis par l'ESP32

### 4.1 `sentinel/telemetry` (QoS 0, toutes les 2 s)

| Champ | Type | Obligatoire | Plage / unité |
|---|---|---|---|
| `node_id` | chaîne | oui | `SENTINEL-X-CORE` |
| `timestamp` | entier ≥ 0 | oui | cf. § 3 |
| `uptime_ms` | entier ≥ 0 | non | ms depuis le démarrage |
| `metrics.temperature_celsius` | nombre \| `null` | oui | -40 … 80 °C (DHT22 / V182) |
| `metrics.humidity_percent` | nombre \| `null` | oui | 0 … 100 % |
| `metrics.gas_raw_ppm` | entier | oui | **0 … 4095** (ADC 12 bits brut du MQ, GPIO 34) |
| `metrics.presence_detected` | booléen | oui | PIR (GPIO 13) |
| `actuators_state.airlock_open` | booléen | non | sas principal (moteur 1) |
| `actuators_state.gas_valve_open` | booléen | non | vanne gaz (moteur 2) |
| `actuators_state.ventilation_active` | booléen | non | trappe de ventilation (moteur 4) |
| `actuators_state.barrier_open` | booléen | non | barrière (moteur 3) |
| `actuators_state.alarm_active` | booléen | non | buzzer / LED d'alarme |
| `system.wifi_rssi_dbm` | entier | non | -120 … 0 |
| `system.free_heap_bytes` | entier ≥ 0 | non | `ESP.getFreeHeap()` |

```json
{"node_id":"SENTINEL-X-CORE","timestamp":1728132000,"uptime_ms":142580,
 "metrics":{"temperature_celsius":23.4,"humidity_percent":48.0,"gas_raw_ppm":215,"presence_detected":false},
 "actuators_state":{"airlock_open":false,"gas_valve_open":true,"ventilation_active":false,"barrier_open":false,"alarm_active":false},
 "system":{"wifi_rssi_dbm":-58,"free_heap_bytes":194200}}
```

La trame minimale réellement émise par le firmware `04` est acceptée :

```json
{"node_id":"SENTINEL-X-CORE","timestamp":142580,
 "metrics":{"temperature_celsius":23.4,"humidity_percent":48.0,"gas_raw_ppm":215,"presence_detected":false},
 "actuators_state":{"airlock_open":false}}
```

> `null` est attendu pour la température et l'humidité quand le DHT échoue. Le firmware `04` renvoie à la place
> la dernière valeur lue (0.0 au démarrage) : à corriger côté firmware pour ne pas fausser l'historique et l'IA.

### 4.2 `sentinel/alerts` (QoS 1) — ou `POST /api/v1/alerts`

| Champ | Type | Obligatoire | Valeurs |
|---|---|---|---|
| `node_id` | chaîne | oui | |
| `timestamp` | entier ≥ 0 | non | cf. § 3 |
| `event_type` | chaîne | oui | `INTRUSION_DETECTED` \| `GAS_LEAK_WARNING` \| `THERMAL_RUNAWAY` \| `UNAUTHORIZED_ACCESS` |
| `severity` | chaîne | oui | `INFO` \| `WARNING` \| `CRITICAL` |
| `source_sensor` | chaîne | non | 64 car. max (`PIR_MOTION`, `MQ2`, `DHT22`…) |
| `value` | nombre | non | |
| `details` | chaîne | non | 512 car. max |

```json
{"node_id":"SENTINEL-X-CORE","timestamp":1728132045,"event_type":"INTRUSION_DETECTED","severity":"CRITICAL",
 "source_sensor":"PIR_MOTION","value":1.0,"details":"Mouvement anormal detecte dans le perimetre d'acces restreint"}
```

`UNAUTHORIZED_ACCESS` est aussi créée **automatiquement par le serveur** lorsqu'un badge est refusé (§ 4.3).

### 4.3 `sentinel/access` (QoS 1) — passage d'un badge RFID

| Champ | Type | Obligatoire | Valeurs |
|---|---|---|---|
| `node_id` | chaîne | oui | |
| `timestamp` | entier ≥ 0 | non | cf. § 3 |
| `card_uid` | chaîne | oui | 4, 7 ou 10 octets hexadécimaux séparés par `:` (`A3:5F:B2:1C`), casse libre |
| `card_type` | chaîne | non | 32 car. max, ex. `MIFARE_CLASSIC` |
| `door_id` | chaîne | non | 32 car. max, ex. `AIRLOCK_MAIN` |

```json
{"node_id":"SENTINEL-X-CORE","timestamp":1728132102,"card_uid":"A3:5F:B2:1C","card_type":"MIFARE_CLASSIC","door_id":"AIRLOCK_MAIN"}
```

L'API vérifie que le badge est enregistré et actif (`PUT /api/v1/badges/{uid}`), journalise le passage et répond
sur `sentinel/access/response` (§ 5.2) en moins d'une seconde.

### 4.4 `sentinel/enroll` — résultat d'un enrôlement de badge

Émis par l'ESP32 après un ordre `ENROLL_BADGE` (§ 5.3). L'API rattache alors le badge à l'utilisateur de la demande.

| Champ | Type | Obligatoire | Valeurs |
|---|---|---|---|
| `node_id` | chaîne | oui | |
| `enroll_id` | entier ≥ 1 | oui | celui de l'ordre reçu |
| `status` | chaîne | oui | `SUCCESS` (badge écrit), `ATTEMPT_FAILED` (un badge a échoué, le mode écriture continue), `TIMEOUT`, `CANCELLED` |
| `card_uid` | chaîne | si `SUCCESS` | comme § 4.3 |
| `error` | chaîne | non | 200 car. max |

```json
{"node_id":"SENTINEL-X-CORE","enroll_id":12,"status":"SUCCESS","card_uid":"43:4B:51:07"}
```

## 5. Messages reçus par l'ESP32

### 5.1 `sentinel/commands` (QoS 1)

Les messages sont publiés par l'API (`POST /api/v1/commands`) après validation. Le champ `action` détermine le format.

**`OPERATE_MOTOR`** (03_SPECIFICATION § 2.A) : `target` ∈ `AIRLOCK_MAIN` (moteur 1), `GAS_VALVE` (moteur 2),
`BARRIER` (moteur 3), `VENT` (moteur 4) ; `command` ∈ `OPEN`, `CLOSE`, `STOP` ; `duration_ms` (1–60000) facultatif.

```json
{"action":"OPERATE_MOTOR","target":"AIRLOCK_MAIN","command":"OPEN","duration_ms":3000}
```

**`CONTROL_MOTORS`** (03_CONTRAT § 3.A) : 1 à 6 ordres simultanés. `motor_id` vaut de 0 à 5 et doit être unique dans le
message. `direction` vaut `CW` ou `CCW`, `angle_deg` de 1 à 3600, `speed_rpm` de 1 à 15 (maximum du 28BYJ-48).

```json
{"action":"CONTROL_MOTORS","commands":[{"motor_id":0,"direction":"CW","angle_deg":90,"speed_rpm":12},
                                       {"motor_id":1,"direction":"CCW","angle_deg":180,"speed_rpm":8},
                                       {"motor_id":4,"direction":"CW","angle_deg":45,"speed_rpm":15}]}
```

**`EMERGENCY_STOP_ALL`** (03_CONTRAT § 3.B) : coupe toutes les bobines.

```json
{"action":"EMERGENCY_STOP_ALL"}
```

**`TRIGGER_ALARM`** (03_SPECIFICATION § 2.B) : `state` (booléen). `color` et `sound` sont facultatifs : codes en
majuscules, chiffres et `_`, 32 caractères max.

```json
{"action":"TRIGGER_ALARM","state":true,"color":"RED","sound":"SIREN_ALERT"}
```

L'ESP32 doit ignorer toute action inconnue. L'exécution réelle se constate dans la télémétrie suivante (`actuators_state`).

### 5.3 Ordres d'enrôlement (`sentinel/commands`, QoS 1)

Publiés par l'API (`POST /api/v1/enrollments`, depuis la page « Badges » du tableau de bord), jamais par `POST /api/v1/commands`.

```json
{"action":"ENROLL_BADGE","enroll_id":12,"duration_s":30}
{"action":"ENROLL_CANCEL","enroll_id":12}
```

`ENROLL_BADGE` : l'ESP32 passe en mode écriture pendant `duration_s` secondes (10 à 120) et écrit le premier badge présenté (cf. `docs/BADGES.md`) ;
il répond sur `sentinel/enroll` (§ 4.4). `ENROLL_CANCEL` le fait quitter ce mode.

### 5.2 `sentinel/access/response` (QoS 1)

```json
{"card_uid":"A3:5F:B2:1C","access_granted":true,"user_name":"Ingenieur Lucas Delon",
 "clearance_level":"LEVEL_4_AETHERCORP","auto_unlock_door":true}
```

Badge refusé (inconnu ou révoqué) :

```json
{"card_uid":"E8:AF:75:3B:02:C8:8E","access_granted":false,"user_name":null,"clearance_level":null,"auto_unlock_door":false}
```

Si `access_granted` et `auto_unlock_door` valent `true`, l'ESP32 ouvre le sas (moteur 1), passe la LED RGB en vert et
affiche `user_name` sur l'OLED. Sinon : LED rouge, sas fermé.

## 6. Adaptations nécessaires du firmware `04_FIRMWARE_ESP32_COMPLET`

Le firmware actuel ne peut pas se connecter au broker sécurisé. Corrections minimales :

| Problème dans `04` | Correction |
|---|---|
| `WiFiClient` + port **1883**, connexion **anonyme** | `WiFiClientSecure` + `setCACert(SENTINEL_CA_PEM)`, port **8883**, `connect("SENTINEL-X-CORE", "esp32", MQTT_PASS)` |
| Mot de passe Wi-Fi écrit en dur dans le code | le déplacer dans un `secrets.h` ajouté au `.gitignore` du firmware |
| Tampon PubSubClient de 256 octets par défaut : la télémétrie complète (~450 o) n'est **jamais envoyée** | `mqttClient.setBufferSize(1024);` |
| `timestamp = millis()` | NTP : `configTime(0, 0, "192.168.10.1")`, puis `time(nullptr)` |
| Lecture du DHT à chaque tour de `loop()` | toutes les 2 s minimum (contrainte du DHT22) ; `null` si `NaN` |
| `sentinel/commands` et `sentinel/access/response` sont abonnés mais jamais traités | `mqttClient.setCallback(...)` (exemple ci-dessous) |
| Abonnements faits sans vérifier le succès de `connect()` | se réabonner seulement si `connect()` renvoie `true`, avec une attente entre les essais |
| Capteur MQ alimenté en **5 V** sur GPIO 34 (**3,3 V max**) | **pont diviseur obligatoire** sur AO (ex. 10 kΩ en série, 20 kΩ vers GND : 5 V → 3,3 V), sinon l'entrée ADC est détruite |

Connexion TLS et traitement des messages (ESP32, Arduino) :

```cpp
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include "ca_cert.h"      // généré sur le Pi par scripts/gen-certs.sh (SENTINEL_CA_PEM)
#include "secrets.h"      // WIFI_SSID, WIFI_PASSWORD, MQTT_PASS — hors Git

WiFiClientSecure tlsClient;
PubSubClient mqttClient(tlsClient);

void onMessage(char* topic, byte* payload, unsigned int len) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, len)) return;                 // JSON invalide : ignoré
  if (strcmp(topic, "sentinel/access/response") == 0) {
    if (doc["access_granted"] && doc["auto_unlock_door"]) { /* moteur 1 : ouvrir le sas, LED verte, OLED */ }
    else { /* LED rouge */ }
  } else if (strcmp(topic, "sentinel/commands") == 0) {
    const char* action = doc["action"] | "";
    if (!strcmp(action, "EMERGENCY_STOP_ALL")) { /* couper toutes les bobines */ }
    else if (!strcmp(action, "OPERATE_MOTOR"))  { /* doc["target"], doc["command"], doc["duration_ms"] */ }
    else if (!strcmp(action, "CONTROL_MOTORS")) { for (JsonObject c : doc["commands"].as<JsonArray>()) { /* ... */ } }
    else if (!strcmp(action, "TRIGGER_ALARM"))  { /* doc["state"], doc["color"], doc["sound"] */ }
  }
}

void setupMqtt() {
  configTime(0, 0, "192.168.10.1");             // NTP servi par le Pi
  tlsClient.setCACert(SENTINEL_CA_PEM);          // vérifie le certificat du broker
  mqttClient.setServer("192.168.10.1", 8883);
  mqttClient.setBufferSize(1024);
  mqttClient.setCallback(onMessage);
}

void ensureMqtt() {
  static unsigned long lastTry = 0;
  if (mqttClient.connected() || millis() - lastTry < 5000) return;
  lastTry = millis();
  if (mqttClient.connect("SENTINEL-X-CORE", "esp32", MQTT_PASS)) {
    mqttClient.subscribe("sentinel/commands", 1);
    mqttClient.subscribe("sentinel/access/response", 1);
  }
}
```

> PubSubClient publie uniquement en QoS 0. Pour les alertes, l'envoi par `POST /api/v1/alerts` (réponse `201`)
> donne un accusé de réception fiable : voir [API.md § 4](API.md).

## 7. Script IA caméra (`sentinel/vision/events`, compte `vision`)

Ce flux ne figure pas dans les spécifications ESP32 : il est conservé pour le script de vision du Pi.

| Champ | Type | Valeurs |
|---|---|---|
| `ts` | nombre | epoch en secondes (décimales acceptées) |
| `label` | chaîne | 1–64 car., ex. `person` |
| `confidence` | nombre | 0 … 1 |
| `bbox` | tableau | `[x, y, w, h]` en pixels, nombres ≥ 0, dans l'image |
| `frame_w`, `frame_h` | entier | 1 … 10000 |
| `snapshot_path` | chaîne \| `null` | facultatif, 255 car. max |

```python
import json, ssl, time
import paho.mqtt.client as mqtt

client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="sentinel-vision")
client.username_pw_set("vision", "<MQTT_PASS_VISION du .env>")
client.tls_set(ca_certs="mosquitto/certs/ca.crt", tls_version=ssl.PROTOCOL_TLS_CLIENT)
client.connect("192.168.10.1", 8883)
client.loop_start()
event = {"ts": time.time(), "label": "person", "confidence": 0.87, "bbox": [120, 40, 200, 380],
         "frame_w": 640, "frame_h": 480, "snapshot_path": None}
client.publish("sentinel/vision/events", json.dumps(event), qos=1).wait_for_publish()
client.loop_stop(); client.disconnect()
```

## 8. Évolution du contrat

1. Ajout d'un champ **facultatif** : compatible, aucun changement côté serveur (les champs inconnus sont ignorés).
2. Renommage, suppression, changement de type ou d'unité : accord de l'équipe, puis mise à jour **dans la même PR** de ce
   document, de `ingestor/validation.py`, de `api/app/models.py`, de leurs tests et de `scripts/smoke-test.sh`.
