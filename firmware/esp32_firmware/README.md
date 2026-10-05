# FIRMWARE ESP32 SENTINEL-X (STRICTEMENT CONFORME CONTRAT-MQTT & API.MD)

Ce dossier contient le code de production du microcontrôleur ESP32 pour la configuration banc de test actuelle (avec tous les capteurs, l'écran, le buzzer, la LED RGB et le moteur pas-à-pas en direct).

---

## 1. Respect Strict des Spécifications Équipe (Docs / Backend)

Ce firmware implémente fidèlement les spécifications de [`docs/API.md`](../../docs/API.md) et [`docs/CONTRAT-MQTT.md`](../../docs/CONTRAT-MQTT.md) :

1. **Télémétrie Périodique (toutes les 2 s)** sur `sentinel/telemetry` :
   - Émission du JSON complet conforme avec `node_id`, `timestamp` (synchronisé en NTP sur `192.168.10.1`), `uptime_ms`.
   - `temperature_celsius` et `humidity_percent` envoyés avec `null` si le capteur échoue (pour ne pas polluer l'IA).
   - `gas_raw_ppm` (0 à 4095) et `presence_detected` (booléen).
   - `actuators_state.airlock_open` et `actuators_state.alarm_active`.
   - `system.wifi_rssi_dbm` et `system.free_heap_bytes`.
   - Tampon MQTT configuré à **1024 octets** pour garantir la transmission sans coupure.

2. **Alertes d'Urgence Immédiates** sur `POST /api/v1/alerts` et `sentinel/alerts` :
   - En-tête `Authorization: Bearer <API_DEVICE_TOKEN>` inclus.
   - Envoi immédiat en cas d'intrusion (`INTRUSION_DETECTED`), surchauffe (`THERMAL_RUNAWAY`) ou pic de gaz (`GAS_LEAK_WARNING`).

3. **Réception des Ordres Superviseur sur `sentinel/commands`** :
   - Traitement de `OPERATE_MOTOR` (`OPEN`, `CLOSE`, `STOP`).
   - Traitement de `CONTROL_MOTORS` (direction, angle en degrés, vitesse en tours/min).
   - Traitement de `EMERGENCY_STOP_ALL` (arrêt immédiat de toutes les bobines).
   - Traitement de `TRIGGER_ALARM` (pilotage sonore et visuel).

4. **Contrôle d'Accès sur `sentinel/access/response`** :
   - Si `access_granted` et `auto_unlock_door` sont à `true`, l'ESP déclenche l'ouverture automatique du sas via le moteur pas-à-pas et passe la LED en vert !

---

## 2. Brochage Matériel Actuel

| Composant | Broche ESP32 | Remarque |
| :--- | :--- | :--- |
| **Écran OLED HW-416A** | **GPIO 22** (SCL) / **GPIO 21** (SDA) | I2C sur 3.3V, adresse `0x3C` |
| **Capteur Gaz MH-MQ** | **GPIO 34** (ADC) | Mesure analogique continue |
| **Capteur Temp/Hum V182** | **GPIO 14** | DATA |
| **Capteur Présence PIR** | **GPIO 13** | OUT |
| **LED KS RGB** | **GPIO 25** (R), **GPIO 26** (G), **GPIO 27** (B) | Cathode commune |
| **Buzzer Actif YXDZ** | **GPIO 33** | Signal |
| **Moteur Pas-à-Pas (ULN2003)** | **GPIO 5** (IN1), **GPIO 4** (IN2), **GPIO 18** (IN3), **GPIO 19** (IN4) | Pilotage non-bloquant en direct |
