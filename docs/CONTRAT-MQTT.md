# Contrat MQTT — SENTINEL-X (schéma v1)

> **Source de vérité** pour le firmware (ESP8266), l'API, le script de vision IA, le dashboard et l'ingestion.
> Aucun topic ni champ ne doit être renommé sans accord de toute l'équipe et sans incrémenter `v`.

## 1. Connexion au broker

| Paramètre | Valeur |
|---|---|
| Hôte | `192.168.10.1` (Wi-Fi de la table) — ou `sentinel.local` si le DNS du point d'accès le résout |
| Port | **8883 (MQTTS uniquement)**. Le port 1883 n'existe pas. |
| TLS | 1.2 minimum, certificat serveur ECDSA P-256 signé par la **CA interne** (`mosquitto/certs/ca.crt`, `ca_cert.h` pour le firmware) |
| Authentification | nom d'utilisateur + mot de passe obligatoires (pas d'anonyme), mots de passe dans le `.env` du Pi |
| Protocole | MQTT 3.1.1 (une publication interdite par l'ACL est **ignorée silencieusement**) |

| Compte | Utilisé par | Droits (ACL) |
|---|---|---|
| `esp_sentinel-01` | boîtier ESP8266 | publie `sentinel/sentinel-01/{telemetry,alerts,status}`, lit `sentinel/sentinel-01/cmd/#` |
| `ingestor` | service d'ingestion | lit `sentinel/+/telemetry`, `sentinel/+/alerts`, `sentinel/+/status`, `sentinel/vision/events` |
| `api` | API (équipe DEV) | lit `sentinel/#`, publie `sentinel/+/cmd/#` |
| `vision` | script IA (webcam) | publie `sentinel/vision/events` |

## 2. Topics

`<device_id>` = `sentinel-01` (minuscules, chiffres et `-`, 32 caractères max).

| Topic | Émetteur → Récepteur | QoS | Retained | Fréquence |
|---|---|---|---|---|
| `sentinel/<device_id>/telemetry` | ESP → serveur | 0 | non | toutes les 5 s |
| `sentinel/<device_id>/alerts` | ESP → serveur | 1 | non | sur événement |
| `sentinel/<device_id>/status` | ESP → serveur | 1 | **oui** | à la connexion + **Last Will** `offline` |
| `sentinel/<device_id>/cmd/buzzer` | API → ESP | 1 | non | sur commande |
| `sentinel/<device_id>/cmd/led` | API → ESP | 1 | non | sur commande |
| `sentinel/vision/events` | script IA → serveur | 1 | non | sur détection |

## 3. Règles communes

- JSON compact, encodage UTF-8, clés en **snake_case**, **unité dans le nom** (`_c`, `_pct`, `_dbm`, `_s`).
- `v` (entier) = version du schéma = **`1`** dans tous les messages. Un message sans `v` ou avec une autre valeur est rejeté.
- `ts` = horodatage **epoch en secondes, UTC**, donné par l'émetteur (**NTP obligatoire**). Rejeté si antérieur au 01/01/2024 (horloge non synchronisée) ou en avance de plus de 5 min.
- Taille : **< 512 octets** par message (rejet côté serveur au-delà de 1024).
- Le serveur ajoute `received_at` (horloge du Pi) à chaque enregistrement.
- Champs supplémentaires inconnus : tolérés et ignorés (compatibilité ascendante).
- Un message invalide est **rejeté et journalisé** par l'ingestor, sans interrompre le service.

## 4. Messages

### 4.1 `telemetry` (ESP, QoS 0, toutes les 5 s)

| Champ | Type | Bornes / valeurs | Remarque |
|---|---|---|---|
| `v` | entier | `1` | |
| `device_id` | chaîne | = `<device_id>` du topic | |
| `ts` | entier | epoch s | |
| `seq` | entier | ≥ 0 | compteur incrémenté à chaque envoi (détection de pertes) |
| `temperature_c` | nombre \| `null` | -40 … 80 | DHT22 ; `null` si la lecture échoue (et alerte `sensor_fault`) |
| `humidity_pct` | nombre \| `null` | 0 … 100 | DHT22 ; `null` si la lecture échoue |
| `gas_raw` | entier | 0 … 1023 | MQ-2, valeur ADC brute de A0 |
| `motion` | booléen | `true` / `false` | PIR HC-SR501 |
| `rssi_dbm` | entier | -120 … 0 | `WiFi.RSSI()` |
| `uptime_s` | entier | ≥ 0 | `millis() / 1000` |

```json
{"v":1,"device_id":"sentinel-01","ts":1791194400,"seq":1532,"temperature_c":22.4,"humidity_pct":48.1,"gas_raw":312,"motion":false,"rssi_dbm":-61,"uptime_s":7660}
```

### 4.2 `alerts` (ESP, QoS 1)

| Champ | Type | Bornes / valeurs |
|---|---|---|
| `v` | entier | `1` |
| `device_id` | chaîne | = `<device_id>` du topic |
| `ts` | entier | epoch s |
| `type` | chaîne | `gas_high` \| `temp_high` \| `motion_detected` \| `sensor_fault` \| `tamper` |
| `severity` | chaîne | `info` \| `warning` \| `critical` |
| `value` | nombre \| `null` | mesure ayant déclenché l'alerte (`null` si sans objet) |
| `threshold` | nombre \| `null` | seuil franchi (`null` si sans objet) |
| `message` | chaîne | 256 caractères max, lisible par un humain |

```json
{"v":1,"device_id":"sentinel-01","ts":1791194412,"type":"gas_high","severity":"critical","value":812,"threshold":600,"message":"MQ-2 au-dessus du seuil"}
```

```json
{"v":1,"device_id":"sentinel-01","ts":1791194415,"type":"sensor_fault","severity":"warning","value":null,"threshold":null,"message":"DHT22 : lecture impossible"}
```

> L'API expose `POST /api/v1/alerts` avec **exactement ce schéma** (corps JSON identique).

### 4.3 `status` (ESP, QoS 1, retained, Last Will)

| Champ | Type | Valeurs | Remarque |
|---|---|---|---|
| `v` | entier | `1` | |
| `state` | chaîne | `online` \| `offline` | |
| `ip` | chaîne | IPv4 | obligatoire si `online` |
| `fw` | chaîne | 32 caractères max | version du firmware, obligatoire si `online` |

Publié **retained** juste après la connexion :

```json
{"v":1,"state":"online","ip":"192.168.10.20","fw":"1.0.0"}
```

**Last Will** déclarée à la connexion (même topic, QoS 1, retained). Le broker la publie si l'ESP disparaît (keepalive dépassé) :

```json
{"v":1,"state":"offline"}
```

### 4.4 `cmd/buzzer` et `cmd/led` (API → ESP, QoS 1, non retained)

| Topic | Champ | Type | Valeurs |
|---|---|---|---|
| `cmd/buzzer` | `v` | entier | `1` |
| | `state` | chaîne | `on` \| `off` |
| | `duration_s` | entier | 0 … 60 (0 = jusqu'au prochain `off`), ignoré si `off` |
| `cmd/led` | `v` | entier | `1` |
| | `led` | chaîne | `status` \| `alert` |
| | `state` | chaîne | `on` \| `off` \| `blink` |

```json
{"v":1,"state":"on","duration_s":5}
```

```json
{"v":1,"led":"alert","state":"blink"}
```

L'ESP ignore toute commande invalide (version, champ manquant, valeur inconnue).

### 4.5 `vision/events` (script IA, QoS 1)

| Champ | Type | Bornes / valeurs | Remarque |
|---|---|---|---|
| `v` | entier | `1` | |
| `ts` | nombre | epoch s | décimales acceptées |
| `label` | chaîne | 1 … 64 caractères | ex. `person` |
| `confidence` | nombre | 0 … 1 | |
| `bbox` | tableau | `[x, y, w, h]`, nombres ≥ 0, en pixels, dans l'image | origine en haut à gauche |
| `frame_w`, `frame_h` | entier | 1 … 10000 | taille de l'image analysée |
| `snapshot_path` | chaîne \| `null` | 255 caractères max | chemin local de la capture, `null` si aucune |

```json
{"v":1,"ts":1791194420.5,"label":"person","confidence":0.87,"bbox":[120,40,200,380],"frame_w":640,"frame_h":480,"snapshot_path":"snapshots/20261005-120020.jpg"}
```

## 5. Contraintes côté ESP8266

- **NTP obligatoire avant TLS.** BearSSL vérifie les dates de validité du certificat : sans heure, la connexion échoue. Le Pi sert l'heure (NTP sur `192.168.10.1`, port 123/udp ouvert sur `wlan0`). Attendre `time(nullptr) > 1704067200` avant de se connecter et avant de publier un `ts`.
- **CA à embarquer** : `mosquitto/certs/ca_cert.h`, généré par `scripts/gen-certs.sh` sur le Pi. Il est propre à chaque Pi et n'est pas dans Git. Le certificat serveur contient aussi `192.168.10.1` en nom DNS, car BearSSL ne compare que les noms DNS du SAN.
- **BearSSL** (`WiFiClientSecure` de l'ESP8266) : TLS 1.2, suites ECDHE-ECDSA (AES-GCM, ChaCha20). Réduire les tampons TLS avec `setBufferSizes(512, 512)` si `probeMaxFragmentLength()` réussit, sinon garder les valeurs par défaut (~ 17 Ko de RAM). La poignée de main ECDSA prend ~1 à 2 s : ne pas se reconnecter en boucle serrée.
- **RAM limitée** (~40 Ko libres) : payloads **< 512 octets**, `PubSubClient::setBufferSize(512)`, pas de `String` concaténée en boucle (préférer `snprintf` dans un tampon fixe).
- **MQ-2 sur A0** : l'entrée ADC du module ESP-12 est limitée à **~1,0 V**, alors que le MQ-2 (alimenté en 5 V) sort jusqu'à ~5 V. Il faut un **pont diviseur** :
  - ESP-12 nu : R1 = 39 kΩ (série) / R2 = 10 kΩ (vers GND), soit 5 V → 1,02 V ;
  - NodeMCU / Wemos D1 mini (diviseur interne 220 k/100 k déjà présent) : ajouter ~180 kΩ en série, soit 5 V → 1,0 V à l'ADC.
  - Prévoir le préchauffage du MQ-2 (1 à 2 min après mise sous tension, et 24 h de rodage au premier usage) avant de déclencher des alertes `gas_high`.
- **DHT22** : une lecture toutes les 2 s maximum. En cas de `NaN`, envoyer `null` et une alerte `sensor_fault`.
- `client_id` MQTT = `device_id` (`sentinel-01`). Keepalive 30 à 60 s.

## 6. Exemple Arduino (ESP8266, PubSubClient + BearSSL)

Bibliothèques : core ESP8266 ≥ 3.1, `PubSubClient` (knolleary). Les identifiants vont dans `secrets.h`, **non versionné**.

```cpp
#include <ESP8266WiFi.h>
#include <WiFiClientSecure.h>   // BearSSL
#include <PubSubClient.h>
#include <time.h>
#include "ca_cert.h"            // généré par scripts/gen-certs.sh (SENTINEL_CA_PEM)
#include "secrets.h"            // WIFI_SSID, WIFI_PASS, MQTT_PASS — hors Git

static const char* MQTT_HOST = "192.168.10.1";
static const uint16_t MQTT_PORT = 8883;
static const char* DEVICE_ID = "sentinel-01";
static const char* FW = "1.0.0";
static const char* T_TELEMETRY = "sentinel/sentinel-01/telemetry";
static const char* T_ALERTS    = "sentinel/sentinel-01/alerts";
static const char* T_STATUS    = "sentinel/sentinel-01/status";
static const char* T_CMD       = "sentinel/sentinel-01/cmd/#";
static const char* LWT         = "{\"v\":1,\"state\":\"offline\"}";

BearSSL::X509List trustAnchor(SENTINEL_CA_PEM);
BearSSL::WiFiClientSecure tls;
PubSubClient mqtt(tls);
uint32_t seq = 0;

void onCommand(char* topic, byte* payload, unsigned int len) {
  // Ex. : parser avec ArduinoJson, vérifier "v":1, puis piloter buzzer / LED.
  Serial.printf("cmd %s : %.*s\n", topic, len, (const char*)payload);
}

void waitForNtp() {
  configTime("CET-1CEST,M3.5.0,M10.5.0/3", MQTT_HOST, "pool.ntp.org");
  while (time(nullptr) < 1704067200) delay(200);   // NTP obligatoire avant TLS
}

void connectMqtt() {
  while (!mqtt.connected()) {
    // client_id, user, pass, willTopic, willQos, willRetain, willMessage
    if (mqtt.connect(DEVICE_ID, "esp_sentinel-01", MQTT_PASS, T_STATUS, 1, true, LWT)) {
      char buf[128];
      snprintf(buf, sizeof buf, "{\"v\":1,\"state\":\"online\",\"ip\":\"%s\",\"fw\":\"%s\"}",
               WiFi.localIP().toString().c_str(), FW);
      mqtt.publish(T_STATUS, buf, true);              // retained
      mqtt.subscribe(T_CMD, 1);
    } else {
      Serial.printf("MQTT rc=%d, TLS err=%d\n", mqtt.state(), tls.getLastSSLError());
      delay(5000);
    }
  }
}

void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) delay(200);
  waitForNtp();
  tls.setTrustAnchors(&trustAnchor);                  // vérifie la chaîne + le nom "192.168.10.1"
  if (tls.probeMaxFragmentLength(MQTT_HOST, MQTT_PORT, 512)) tls.setBufferSizes(512, 512);
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(512);
  mqtt.setKeepAlive(30);
  mqtt.setCallback(onCommand);
}

void loop() {
  connectMqtt();
  mqtt.loop();
  static uint32_t last = 0;
  if (millis() - last >= 5000) {
    last = millis();
    float t = NAN, h = NAN;            // lire le DHT22 ici
    int gas = analogRead(A0);          // 0..1023 (via pont diviseur !)
    bool motion = digitalRead(D5);     // PIR
    char tbuf[16], hbuf[16], buf[256];
    if (isnan(t)) strcpy(tbuf, "null"); else dtostrf(t, 1, 1, tbuf);
    if (isnan(h)) strcpy(hbuf, "null"); else dtostrf(h, 1, 1, hbuf);
    snprintf(buf, sizeof buf,
      "{\"v\":1,\"device_id\":\"%s\",\"ts\":%ld,\"seq\":%lu,\"temperature_c\":%s,\"humidity_pct\":%s,"
      "\"gas_raw\":%d,\"motion\":%s,\"rssi_dbm\":%d,\"uptime_s\":%lu}",
      DEVICE_ID, (long)time(nullptr), (unsigned long)seq++, tbuf, hbuf, gas,
      motion ? "true" : "false", WiFi.RSSI(), (unsigned long)(millis() / 1000));
    mqtt.publish(T_TELEMETRY, buf);    // QoS 0 (PubSubClient ne publie qu'en QoS 0)
  }
}
```

> **PubSubClient publie uniquement en QoS 0.** Pour respecter le QoS 1 des `alerts` et du `status`, deux options :
> utiliser une bibliothèque qui le gère (ex. `arduino-mqtt` de 256dpi ou `AsyncMqttClient`), ou republier l'alerte
> tant qu'elle n'apparaît pas côté serveur. La Last Will, elle, est bien en QoS 1 et retained (paramètres de `connect`).

## 7. Exemple Python (paho-mqtt 2.x) — script de vision / API

```python
import json, ssl, time
import paho.mqtt.client as mqtt

client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="sentinel-vision")
client.username_pw_set("vision", "<MQTT_PASS_VISION du .env>")
client.tls_set(ca_certs="mosquitto/certs/ca.crt", tls_version=ssl.PROTOCOL_TLS_CLIENT)  # vérifie CA + nom
client.connect("192.168.10.1", 8883, keepalive=60)
client.loop_start()

event = {"v": 1, "ts": round(time.time(), 3), "label": "person", "confidence": 0.87,
         "bbox": [120, 40, 200, 380], "frame_w": 640, "frame_h": 480, "snapshot_path": None}
client.publish("sentinel/vision/events", json.dumps(event, separators=(",", ":")), qos=1).wait_for_publish()
client.loop_stop(); client.disconnect()
```

Abonnement (compte `api`, lecture de tout `sentinel/#`) :

```python
def on_message(_c, _u, msg):
    print(msg.topic, json.loads(msg.payload))

sub = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="sentinel-api")
sub.username_pw_set("api", "<MQTT_PASS_API>")
sub.tls_set(ca_certs="mosquitto/certs/ca.crt", tls_version=ssl.PROTOCOL_TLS_CLIENT)
sub.on_connect = lambda c, *_: c.subscribe("sentinel/#", qos=1)
sub.on_message = on_message
sub.connect("192.168.10.1", 8883)
sub.loop_forever()
```

Envoi d'une commande (compte `api`) :

```python
client.publish("sentinel/sentinel-01/cmd/buzzer", '{"v":1,"state":"on","duration_s":5}', qos=1)
```

## 8. Évolution du contrat

1. Ajout d'un champ **optionnel** : compatible, `v` inchangé (les consommateurs ignorent les champs inconnus).
2. Renommage, suppression ou changement de type/unité : **`v` = 2**. L'ingestor doit accepter v1 et v2 pendant la migration du firmware.
3. Toute modification passe par une PR qui met à jour ce document **et** `ingestor/validation.py` (et ses tests).
