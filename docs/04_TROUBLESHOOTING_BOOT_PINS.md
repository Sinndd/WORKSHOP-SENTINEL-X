# GUIDE DE RÉSOLUTIONS DE PANNES & BROCHES DE BOOT (ESP8266)

Ce guide résume les pièges matériels spécifiques à l'ESP8266 rencontrés durant les phases de test et les solutions industrielles appliquées.

---

## 1. Le Piège des Broches de Démarrage (Strapping Pins)

Sur l'ESP8266, certaines broches GPIO possèdent un rôle matériel déterminant lors de la mise sous tension. Si ces broches sont tirées au mauvais potentiel lors du boot, la carte refuse de démarrer le micrologiciel utilisateur :

| Broche Physique | GPIO Interne | État requis au Boot | Risque si mauvais câblage |
| :--- | :--- | :--- | :--- |
| **D3** | **GPIO0** | **HIGH (3.3V)** | Si reliée à la masse (ex: LED sans pull-up), la carte bascule en **mode Flash/UART** et le code ne démarre jamais. |
| **D4** | **GPIO2** | **HIGH (3.3V)** | Doit être maintenue haute au démarrage. |
| **D8** | **GPIO15** | **LOW (0V)** | Doit être maintenue basse au démarrage. |

### Règle d'or appliquée pour Sentinel-X :
* **Ne jamais brancher de LED vers la masse sur D3 ou D4**.
* Pour les LEDs ou actionneurs, utiliser en priorité **D5, D6, D7** qui sont totalement neutres au boot.
* Les capteurs à pull-up (DHT) peuvent aller sur **D4**. Le **PIR HC-SR501 ne doit PAS aller sur D3/D4** : sa sortie est *push-pull* et basse au repos, donc à chaque reset GPIO0 est lu à 0 et l'ESP reste en mode flash. Il est branché sur **D0 (GPIO16)**.
* Le PIR s'alimente en **5 V (VIN)** : en 3,3 V son régulateur ne fonctionne pas correctement et la sortie devient erratique. Attendre ~60 s de chauffe après la mise sous tension.

---

## 2. Problématique des Niveaux de Tension (3.3V vs 5V)

* **Alimentation du Capteur de Gaz MH-MQ :**  
  Le capteur intègre un élément chauffant (filament). S'il est alimenté en 3.3V, sa tension de chauffe est insuffisante et les lectures restent bloquées à des valeurs très basses (11-12 ppm). Il doit être alimenté sur la broche **VIN (5V)** ou directement sur le rail 5V USB.

* **Alimentation du Contrôleur de Moteur ULN2003 :**  
  Le moteur pas-à-pas 28BYJ-48 nécessite du 5V pour fournir son couple mécanique de rotation. Sur du 3.3V, les LEDs témoins clignotent mais l'axe du moteur risque de vibrer sans tourner.

* **Attention au Module RFID-RC522 :**  
  Ce module n'est **PAS tolérant au 5V**. Il doit toujours être alimenté par la broche **3V3**.

---

## 3. Checklist Express de Diagnostic sur Banc d'Essai

1. **La carte ne répond plus après flashage ?**  
   Débrancher le fil sur **D3** et redémarrer la carte (bouton Reset).
2. **L'écran OLED ne s'allume pas ?**  
   Vérifier le bus I2C : SCL sur **D1** et SDA sur **D2**, adresse `0x3C`.
3. **Le capteur de gaz ne réagit pas au briquet ?**  
   Vérifier que la Power LED rouge du module MQ est allumée et que le capteur devient tiède au toucher après 1 minute.
4. **Moteur qui vibre sans tourner ?**  
   Vérifier la séquence des bobines : IN1 (D1), IN2 (D2), IN3 (D5), IN4 (D6).
