#!/usr/bin/env bash
# ==============================================================================
# SENTINEL-X — installation complète en une commande (Raspberry Pi)
#
#   1. vérifie les prérequis (Docker, openssl) et détecte le réseau (interface, sous-réseau, IP) ;
#   2. génère les secrets (.env, mots de passe MQTT) et la PKI interne (CA + certificat serveur,
#      dont le SAN couvre automatiquement les IP de la machine) ;
#   3. durcit l'hôte : setup-pi.sh (Pi seulement), harden-os.sh (mises à jour auto, fail2ban, sysctl, démon Docker),
#      harden-host.sh (UFW, chaîne DOCKER-USER, SSH par clé) ;
#   4. lance la stack Docker durcie (postgres -> migrations -> api, mosquitto, ingestor, ntp, proxy HTTPS) ;
#   5. attend que tous les services soient « healthy » puis lance l'audit de sécurité.
#
# Idempotent : on peut le relancer. Usage (utilisateur normal ayant accès à Docker ; sudo est demandé pour l'hôte) :
#   ./scripts/install.sh [--yes] [--dry-run] [--skip-host] [--skip-audit]
#                        [--bundle <dossier-du-paquet>] [--load-images images.tar.gz]
#                        [--lan-if wlan0] [--lan-net 192.168.10.0/24] [--extra-ip 10.0.0.5]...
#   Pi SANS Internet : sur une machine connectée, ./scripts/bundle-offline.sh crée un paquet unique (Docker, ufw, fail2ban,
#   images, dépôt) ; sur le Pi : tar xzf sentinel-offline-*.tar.gz && cd sentinel-offline && ./install.sh
#   (équivaut à --bundle) : installe Docker et les paquets hors ligne, charge les images, puis déroule toutes les étapes.
#   --skip-host : ne touche pas à l'OS ni au pare-feu (poste de dev) ; --yes : aucune confirmation
#   (sans --yes, harden-host.sh demande de confirmer l'accès SSH depuis une NOUVELLE session : garde-fou anti-coupure).
# ==============================================================================
set -euo pipefail
SELF="$(readlink -f "$0")"; ORIG_ARGS=("$@")
cd "$(dirname "$0")/.."

YES=0; DRY=0; SKIP_HOST=0; SKIP_AUDIT=0; IMAGES_FILE=""; BUNDLE=""; LAN_IF="${LAN_IF:-}"; LAN_NET="${LAN_NET:-}"; EXTRA_IPS=()
while (( $# )); do
  case "$1" in
    --yes|-y) YES=1 ;;
    --dry-run) DRY=1 ;;
    --skip-host) SKIP_HOST=1 ;;
    --skip-audit) SKIP_AUDIT=1 ;;
    --bundle) BUNDLE="$(readlink -f "${2:?--bundle attend le dossier du paquet}")"; shift ;;
    --load-images) IMAGES_FILE="${2:?--load-images attend un fichier .tar.gz}"; shift ;;
    --lan-if) LAN_IF="${2:?--lan-if attend une interface}"; shift ;;
    --lan-net) LAN_NET="${2:?--lan-net attend un CIDR}"; shift ;;
    --extra-ip) EXTRA_IPS+=("${2:?--extra-ip attend une adresse}"); shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "Option inconnue : $1" >&2; exit 2 ;;
  esac
  shift
done

G='\033[0;32m'; B='\033[0;34m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
step() { echo -e "\n${B}==> $*${N}"; }
ok()   { echo -e "${G}✓ $*${N}"; }
warn() { echo -e "${Y}! $*${N}" >&2; }
die()  { echo -e "${R}✗ $*${N}" >&2; exit 1; }
run()  { if (( DRY )); then echo "  [dry-run] $*"; else "$@"; fi; }
SUDO=""; [[ $EUID -ne 0 ]] && (( ! DRY )) && SUDO="sudo"
YESFLAG=""; (( YES )) && YESFLAG="--yes"

# --- 1. Prérequis et réseau ------------------------------------------------------------------
step "1/5 Prérequis et détection du réseau"
[[ $EUID -ne 0 ]] || die "ne pas lancer en root : la stack tourne sous votre UID (sudo est demandé quand il le faut)."
# Paquet hors ligne : installe d'abord Docker, ufw, fail2ban... depuis les .deb du paquet.
if [[ -n "$BUNDLE" ]]; then
  [[ -d "$BUNDLE/debs" && -f "$BUNDLE/images.tar.gz" ]] || die "$BUNDLE n'est pas un paquet valide (debs/ et images.tar.gz attendus)."
  if [[ -f "$BUNDLE/SHA256SUMS" ]]; then
    (cd "$BUNDLE" && sha256sum -c --quiet SHA256SUMS) || die "contrôle d'intégrité du paquet échoué : fichier corrompu ou modifié."
    ok "Intégrité du paquet vérifiée"
  fi
  IMAGES_FILE="$BUNDLE/images.tar.gz"
  if (( DRY )); then echo "  [dry-run] sudo ./scripts/install-debs.sh $BUNDLE/debs"
  else
    $SUDO ./scripts/install-debs.sh "$BUNDLE/debs"
    # Le groupe docker vient d'être ajouté à l'utilisateur : la session courante ne le voit pas encore.
    if ! docker info >/dev/null 2>&1 && [[ -z "${SENTINEL_REEXEC:-}" ]] && id -nG "$(id -un)" | grep -qw docker; then
      exec sg docker -c "SENTINEL_REEXEC=1 $(printf '%q ' "$SELF" "${ORIG_ARGS[@]}")"
    fi
  fi
fi
command -v openssl >/dev/null || die "openssl est requis."
command -v docker >/dev/null && docker compose version >/dev/null 2>&1 \
  || die "docker compose est requis (https://docs.docker.com/engine/install/debian/)."
docker info >/dev/null 2>&1 || die "Docker inaccessible pour $(id -un) : ajoutez-vous au groupe docker ou relancez avec les droits adaptés."
ok "Docker et openssl disponibles"

# Le Pi n'a pas Internet en production : on le détecte et on n'essaie rien de réseau.
if timeout 4 bash -c '</dev/tcp/registry-1.docker.io/443' >/dev/null 2>&1; then OFFLINE=0; else OFFLINE=1; fi
export SENTINEL_OFFLINE="$OFFLINE"
if (( OFFLINE )); then warn "pas d'Internet : mode HORS LIGNE (images préchargées, aucun build ni téléchargement)."; else ok "Internet disponible"; fi

# Sans RTC ni Internet, un Pi peut démarrer en 1970 : certificats invalides, 2FA et journaux faux (cf. docs/AUDIT-SECURITE.md §4).
if [[ "$(date +%Y)" -lt 2025 ]]; then
  die "horloge incohérente ($(date)) : régler l'heure (sudo date -s 'AAAA-MM-JJ HH:MM:SS') puis relancer."
fi

if [[ -n "$IMAGES_FILE" ]]; then
  [[ -f "$IMAGES_FILE" ]] || die "$IMAGES_FILE introuvable."
  if [[ -f "$IMAGES_FILE.sha256" ]]; then (cd "$(dirname "$IMAGES_FILE")" && sha256sum -c "$(basename "$IMAGES_FILE").sha256") || die "somme SHA-256 invalide : fichier corrompu ou modifié."; fi
  echo "  chargement des images Docker (peut prendre quelques minutes)..."
  if (( DRY )); then echo "  [dry-run] docker load -i $IMAGES_FILE"; else gunzip -c "$IMAGES_FILE" | docker load >/dev/null; fi
  ok "Images chargées"
fi

# Réseau de la table = point d'accès wlan0 (le défaut de harden-host.sh) ; sinon l'interface de la route par défaut.
if [[ -z "$LAN_IF" ]] && ip -4 -o addr show dev wlan0 2>/dev/null | grep -q inet; then LAN_IF=wlan0; fi
if [[ -z "$LAN_IF" ]]; then LAN_IF="$(ip -4 route show default 2>/dev/null | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -1)"; fi
[[ -n "$LAN_IF" ]] || die "interface réseau introuvable : utiliser --lan-if."
if [[ -z "$LAN_NET" ]]; then
  cidr="$(ip -4 -o addr show dev "$LAN_IF" | awk '{print $4}' | head -1)"
  [[ -n "$cidr" ]] || die "pas d'adresse IPv4 sur $LAN_IF : utiliser --lan-net."
  LAN_NET="$(python3 -c "import ipaddress,sys; print(ipaddress.ip_interface(sys.argv[1]).network)" "$cidr")"
fi
HOST_IPS="$(ip -4 -o addr show scope global | awk '$2 !~ /^(docker|br-|veth|cni|podman)/ {sub("/.*","",$4); print $4}' | tr '\n' ' ')"
echo "  interface LAN : $LAN_IF   sous-réseau : $LAN_NET   IP de la machine : ${HOST_IPS:-aucune}"

# --- 2. Secrets et PKI ---------------------------------------------------------------------------
step "2/5 Secrets (.env) et certificats (CA interne + serveur)"
if (( DRY )); then
  echo "  [dry-run] ./scripts/gen-env.sh ; ajout des IP ($HOST_IPS ${EXTRA_IPS[*]:-}) à SENTINEL_EXTRA_IPS ; ./scripts/gen-certs.sh"
else
  ./scripts/gen-env.sh
  # IP de la machine (+ IP demandées) ajoutées au SAN : le navigateur et l'ESP vérifient l'adresse utilisée.
  python3 - ".env" "$HOST_IPS ${EXTRA_IPS[*]:-}" <<'PY'
import re, sys
path, new = sys.argv[1], sys.argv[2].split()
text = open(path).read()
m = re.search(r"^SENTINEL_EXTRA_IPS=(.*)$", text, re.M)
cur = re.sub(r"\s+#.*$", "", m.group(1)).strip().strip('"').split() if m else []
merged = cur + [ip for ip in new if ip not in cur]
line = 'SENTINEL_EXTRA_IPS="' + " ".join(merged) + '"'
text = re.sub(r"^SENTINEL_EXTRA_IPS=.*$", line, text, flags=re.M) if m else text + "\n" + line + "\n"
open(path, "w").write(text)
print("  SENTINEL_EXTRA_IPS =", " ".join(merged))
PY
  ./scripts/gen-certs.sh
fi
ok "Secrets et certificats prêts (CA : mosquitto/certs/ca.crt)"

# --- 3. Durcissement de l'hôte ---------------------------------------------------------------
step "3/5 Durcissement de l'hôte"
if (( SKIP_HOST )); then
  warn "--skip-host : OS et pare-feu non modifiés."
else
  DRYFLAG=""; (( DRY )) && DRYFLAG="--dry-run"
  if [[ "$(uname -m)" == "aarch64" ]]; then
    $SUDO ./scripts/setup-pi.sh --yes $DRYFLAG
  else
    warn "architecture $(uname -m) (pas un Pi 64-bit) : setup-pi.sh ignoré."
  fi
  $SUDO ./scripts/harden-os.sh $DRYFLAG
  $SUDO env LAN_IF="$LAN_IF" LAN_NET="$LAN_NET" ./scripts/harden-host.sh $YESFLAG $DRYFLAG
  ok "Hôte durci (UFW, DOCKER-USER, SSH, fail2ban, sysctl, Docker)"
fi

# --- 4. Stack Docker --------------------------------------------------------------------------
step "4/5 Lancement de la stack"
if (( OFFLINE && ! DRY )); then
  imgs="$(docker compose config --images 2>/dev/null || true)"
  [[ -n "$imgs" ]] || die "liste d'images illisible (docker compose config)."
  missing=""
  while read -r img; do docker image inspect "$img" >/dev/null 2>&1 || missing+=" $img"; done <<<"$imgs"
  [[ -z "$missing" ]] || die "images absentes :$missing — préparer le paquet avec ./scripts/bundle-offline.sh sur une machine connectée, puis --load-images."
fi
if (( DRY )); then
  echo "  [dry-run] ./scripts/start.sh"
else
  ./scripts/start.sh
fi

# --- 5. Santé et audit ----------------------------------------------------------------------------
step "5/5 Vérifications"
if (( DRY )); then
  echo "  [dry-run] attente des services healthy ; ./scripts/audit-security.sh"
else
  deadline=$((SECONDS + 240))
  while :; do
    not_ready="$(docker compose ps --format '{{.Service}} {{.Status}}' | grep -v '(healthy)' || true)"
    [[ -z "$not_ready" ]] && break
    (( SECONDS < deadline )) || { warn "services pas encore healthy :"; echo "$not_ready" >&2; break; }
    sleep 5
  done
  [[ -z "$not_ready" ]] && ok "Tous les services sont healthy"
  if (( ! SKIP_AUDIT )); then ./scripts/audit-security.sh || warn "l'audit signale des échecs (voir ci-dessus)."; fi
fi

main_ip="$(awk '{print $1}' <<<"$HOST_IPS")"
echo -e "\n${G}======================================================================${N}"
echo -e "${G}SENTINEL-X installé${N}"
echo -e "${G}======================================================================${N}"
echo -e " Dashboard : ${B}https://${main_ip:-<ip-du-pi>}/${N}   (le port 80 redirige vers HTTPS)"
echo -e " MQTTS     : ${main_ip:-<ip-du-pi>}:8883       NTP : ${main_ip:-<ip-du-pi>}:123/udp"
echo -e " ${Y}Navigateur${N} : importer ${B}mosquitto/certs/ca.crt${N} comme autorité de confiance (sinon avertissement)."
echo -e " ${Y}Firmware ESP${N} : copier mosquitto/certs/ca_cert.h dans firmware/sentinel_core/, SERVER_HOST = IP ci-dessus,"
echo -e "                MQTT_PASS / API_DEVICE_TOKEN du .env dans secrets.h, puis reflasher."
echo -e " ${Y}Sauvegarde${N} : sortir mosquitto/certs/ca.key du Pi (clé USB / coffre), puis la supprimer du Pi."
echo -e " Premier accès : compte ${Y}admin${N}, mot de passe temporaire DASHBOARD_PASS dans .env (changement imposé)."
echo -e " État : ./scripts/status.sh    Journaux : docker compose logs -f"
