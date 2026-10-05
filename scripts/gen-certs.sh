#!/usr/bin/env bash
# Génère la PKI interne : CA (ECDSA P-256) + certificat serveur Mosquitto.
#
# Idempotent :
#   - la CA n'est créée que si elle n'existe pas (la régénérer obligerait à reflasher l'ESP) ;
#   - le certificat serveur est (re)créé s'il manque, si le SAN a changé, s'il expire
#     dans moins de 30 jours ou s'il n'est plus signé par la CA. --force-server le force.
#
# SAN : IP 192.168.10.1, sentinel.local, $SENTINEL_HOSTNAME, mosquitto (nom Docker),
#       localhost/127.0.0.1, et "192.168.10.1" aussi en dNSName car BearSSL (ESP8266)
#       ne compare que les dNSName.
#
# Usage : ./scripts/gen-certs.sh [--force-server]
set -euo pipefail
cd "$(dirname "$0")/.."

FORCE_SERVER=0
[[ "${1:-}" == "--force-server" ]] && FORCE_SERVER=1

[[ -f .env ]] && { set -a; . ./.env; set +a; }
HOST="${SENTINEL_HOSTNAME:-$(hostname -s)}"
AP_IP="${SENTINEL_AP_IP:-192.168.10.1}"
DIR=mosquitto/certs
SAN="IP:${AP_IP},DNS:${AP_IP},DNS:sentinel.local,DNS:${HOST},DNS:mosquitto,DNS:localhost,IP:127.0.0.1"

umask 077
mkdir -p "$DIR"
ext="$(mktemp)"; trap 'rm -f "$ext" "$DIR/server.csr"' EXIT

# --- CA ----------------------------------------------------------------------
if [[ -f "$DIR/ca.key" && -f "$DIR/ca.crt" ]]; then
  echo "[gen-certs] CA existante conservée."
else
  echo "[gen-certs] Création de la CA (ECDSA P-256, 10 ans)."
  openssl ecparam -name prime256v1 -genkey -noout -out "$DIR/ca.key"
  cat > "$ext" <<EOF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = SENTINEL-X Root CA
O  = EPSI Workshop SENTINEL-X
[v3_ca]
basicConstraints     = critical,CA:TRUE,pathlen:0
keyUsage             = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
EOF
  openssl req -x509 -new -key "$DIR/ca.key" -sha256 -days 3650 \
    -config "$ext" -extensions v3_ca -out "$DIR/ca.crt"
  FORCE_SERVER=1
fi

# --- Certificat serveur ---------------------------------------------------------
need_server=$FORCE_SERVER
if [[ $need_server -eq 0 ]]; then
  if [[ ! -f "$DIR/server.crt" || ! -f "$DIR/server.key" ]]; then need_server=1
  elif [[ "$(cat "$DIR/server.san" 2>/dev/null)" != "$SAN" ]]; then need_server=1; echo "[gen-certs] SAN modifié."
  elif ! openssl x509 -in "$DIR/server.crt" -noout -checkend 2592000 >/dev/null; then need_server=1; echo "[gen-certs] Expiration < 30 j."
  elif ! openssl verify -CAfile "$DIR/ca.crt" "$DIR/server.crt" >/dev/null 2>&1; then need_server=1; echo "[gen-certs] Non signé par la CA courante."
  fi
fi

if [[ $need_server -eq 1 ]]; then
  echo "[gen-certs] Création du certificat serveur (ECDSA P-256, 825 j)."
  echo "[gen-certs] SAN = $SAN"
  openssl ecparam -name prime256v1 -genkey -noout -out "$DIR/server.key"
  openssl req -new -key "$DIR/server.key" -subj "/CN=sentinel.local/O=EPSI Workshop SENTINEL-X" -out "$DIR/server.csr"
  cat > "$ext" <<EOF
basicConstraints       = critical,CA:FALSE
keyUsage               = critical,digitalSignature
extendedKeyUsage       = serverAuth
subjectAltName         = ${SAN}
subjectKeyIdentifier   = hash
authorityKeyIdentifier = keyid
EOF
  openssl x509 -req -in "$DIR/server.csr" -CA "$DIR/ca.crt" -CAkey "$DIR/ca.key" \
    -CAcreateserial -sha256 -days 825 -extfile "$ext" -out "$DIR/server.crt"
  rm -f "$DIR/ca.srl"
  printf '%s' "$SAN" > "$DIR/server.san"
else
  echo "[gen-certs] Certificat serveur valide conservé."
fi

# Clés privées : lisibles uniquement par l'utilisateur hôte (= utilisateur de Mosquitto, cf. PUID).
chmod 600 "$DIR/ca.key" "$DIR/server.key"
chmod 644 "$DIR/ca.crt" "$DIR/server.crt"

# --- CA au format C pour le firmware ESP8266 (BearSSL::X509List accepte le PEM) --
{
  echo "// Généré par scripts/gen-certs.sh le $(date -Iseconds)."
  echo "// CA publique SENTINEL-X : pas un secret, mais propre à CE Raspberry Pi."
  echo "// SHA-256 : $(openssl x509 -in "$DIR/ca.crt" -noout -fingerprint -sha256 | cut -d= -f2)"
  echo "#pragma once"
  echo "#include <pgmspace.h>"
  echo "static const char SENTINEL_CA_PEM[] PROGMEM = R\"EOF("
  cat "$DIR/ca.crt"
  echo ")EOF\";"
} > "$DIR/ca_cert.h"
chmod 644 "$DIR/ca_cert.h"

openssl x509 -in "$DIR/server.crt" -noout -subject -enddate -ext subjectAltName 2>/dev/null \
  || openssl x509 -in "$DIR/server.crt" -noout -subject -enddate
cat <<EOF

[gen-certs] Fichiers dans $DIR :
  ca.crt       -> à distribuer (ingestor, API, script IA, mosquitto_pub/sub)
  ca_cert.h    -> à copier dans le firmware ESP8266 (#include "ca_cert.h")
  ca.key       -> SECRET : à sortir du Pi après génération (clé USB / coffre)
  server.key   -> SECRET : lu par Mosquitto uniquement
Variante DER pour un tableau d'octets :  openssl x509 -in $DIR/ca.crt -outform der | xxd -i -n sentinel_ca_der
EOF
