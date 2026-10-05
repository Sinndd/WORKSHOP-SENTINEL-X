#!/usr/bin/env bash
# Durcissement réseau/SSH de l'hôte SENTINEL-X (Raspberry Pi).
#
#   UFW : entrant refusé par défaut ; depuis le Wi-Fi de la table ($LAN_IF, $LAN_NET) :
#         SSH, MQTTS ($MQTT_PORT), API ($API_PORT), + DHCP/DNS/NTP du point d'accès ;
#         SSH aussi depuis $WAN_IF (eth0), avec limitation anti-bruteforce.
#   DOCKER-USER : Docker contourne UFW pour les ports publiés -> règles dédiées
#         (/etc/ufw/after.rules) : seuls 8883/API depuis $LAN_NET sur $LAN_IF passent.
#   SSH : authentification par clé uniquement, root interdit.
#   Rappel : ne pas mettre d'utilisateurs dans le groupe docker (= root) sans nécessité.
#
# Anti-coupure : refuse de désactiver les mots de passe sans clé autorisée, puis
# demande de confirmer depuis une NOUVELLE session SSH ; sans réponse sous 120 s, tout est annulé.
#
# Idempotent. Usage : sudo ./scripts/harden-host.sh [--dry-run] [--yes]
# Variables : LAN_IF=wlan0 LAN_NET=192.168.10.0/24 WAN_IF=eth0 SSH_FROM_WAN=yes
set -euo pipefail
cd "$(dirname "$0")/.."

DRY=0; YES=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --yes|-y) YES=1 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "Option inconnue : $arg" >&2; exit 2 ;;
  esac
done

[[ -f .env ]] && { set -a; . ./.env; set +a; }
LAN_IF="${LAN_IF:-wlan0}"; LAN_NET="${LAN_NET:-192.168.10.0/24}"
WAN_IF="${WAN_IF:-eth0}";  SSH_FROM_WAN="${SSH_FROM_WAN:-yes}"
MQTT_PORT="${MQTT_PORT:-8883}"; API_PORT="${API_PORT:-8000}"
SSHD_DROPIN=/etc/ssh/sshd_config.d/01-sentinel-hardening.conf   # "01" : prioritaire (1re valeur lue gagne)
AFTER_RULES=/etc/ufw/after.rules

log()  { echo "[harden] $*"; }
warn() { echo "[harden] ATTENTION : $*" >&2; }
run()  { if (( DRY )); then echo "  [dry-run] $*"; else echo "  + $*"; "$@"; fi; }
die()  { echo "[harden] ERREUR : $*" >&2; exit 1; }

(( DRY )) || [[ $EUID -eq 0 ]] || die "à lancer avec sudo (ou --dry-run)."

# --- Vérifications anti-coupure -------------------------------------------------
admin="${SUDO_USER:-$(id -un)}"
admin_home="$(getent passwd "$admin" | cut -d: -f6)"
keys="$admin_home/.ssh/authorized_keys"
DISABLE_PASSWORDS=1
if [[ ! -s "$keys" ]]; then
  warn "$keys absent ou vide : l'authentification par mot de passe est CONSERVÉE."
  warn "Copier d'abord une clé : ssh-copy-id $admin@<ip-du-pi>, puis relancer."
  DISABLE_PASSWORDS=0
fi
if [[ -n "${SSH_CONNECTION:-}" ]]; then
  read -r client_ip _ server_ip _ <<<"$SSH_CONNECTION"
  ssh_if="$(ip -o -4 addr show | awk -v ip="$server_ip" '$4 ~ "^"ip"/" { print $2 }')"
  log "Session SSH courante : $client_ip -> $server_ip ($ssh_if)"
  if [[ "$ssh_if" == "$WAN_IF" && "$SSH_FROM_WAN" != "yes" ]]; then
    die "votre session arrive par $WAN_IF mais SSH_FROM_WAN=$SSH_FROM_WAN : vous seriez coupé."
  fi
  if [[ "$ssh_if" != "$WAN_IF" && "$ssh_if" != "$LAN_IF" ]]; then
    die "session SSH via '$ssh_if' (ni $LAN_IF ni $WAN_IF) : ajuster LAN_IF/WAN_IF."
  fi
fi
for ifc in "$LAN_IF" "$WAN_IF"; do
  ip link show "$ifc" >/dev/null 2>&1 || warn "interface $ifc introuvable (normal si le point d'accès n'est pas encore configuré)."
done

cat <<EOF
[harden] Plan :
  - UFW : deny incoming / allow outgoing
  - $LAN_IF depuis $LAN_NET : 22/tcp, $MQTT_PORT/tcp, $API_PORT/tcp, 53, 123/udp ; 67/udp (DHCP)
  - $WAN_IF : 22/tcp (limité) = $SSH_FROM_WAN
  - DOCKER-USER : ports publiés joignables uniquement depuis $LAN_IF/$LAN_NET ($MQTT_PORT, $API_PORT)
  - SSH : mots de passe désactivés = $( (( DISABLE_PASSWORDS )) && echo oui || echo NON) ; root interdit
EOF
if (( ! DRY && ! YES )); then
  warn "gardez cette session ouverte ; une confirmation depuis une NOUVELLE session sera demandée."
  read -r -p "Appliquer ? (oui/non) " answer
  [[ "$answer" == "oui" ]] || { echo "Abandon."; exit 1; }
fi

# --- 1. UFW ------------------------------------------------------------------------
command -v ufw >/dev/null || { run apt-get update -qq; run apt-get install -y -qq ufw; }
run ufw default deny incoming
run ufw default allow outgoing
run ufw allow in on "$LAN_IF" from "$LAN_NET" to any port 22 proto tcp comment 'SSH depuis le Wi-Fi table'
[[ "$SSH_FROM_WAN" == "yes" ]] && run ufw limit in on "$WAN_IF" to any port 22 proto tcp comment 'SSH admin eth0'
run ufw allow in on "$LAN_IF" from "$LAN_NET" to any port "$MQTT_PORT" proto tcp comment 'MQTTS'
run ufw allow in on "$LAN_IF" from "$LAN_NET" to any port "$API_PORT" proto tcp comment 'API'
run ufw allow in on "$LAN_IF" to any port 67 proto udp comment 'DHCP point d acces'
run ufw allow in on "$LAN_IF" from "$LAN_NET" to any port 53 comment 'DNS point d acces'
run ufw allow in on "$LAN_IF" from "$LAN_NET" to any port 123 proto udp comment 'NTP pour ESP8266'

# --- 2. Chaîne DOCKER-USER (Docker contourne les règles INPUT d'UFW) -------------------
# --ctorigdstport : port publié d'origine (avant la traduction DNAT de Docker).
block="# BEGIN SENTINEL-X DOCKER-USER
*filter
:DOCKER-USER - [0:0]
-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
-A DOCKER-USER -i $LAN_IF -s $LAN_NET -p tcp -m conntrack --ctorigdstport $MQTT_PORT -j RETURN
-A DOCKER-USER -i $LAN_IF -s $LAN_NET -p tcp -m conntrack --ctorigdstport $API_PORT -j RETURN
-A DOCKER-USER -i $LAN_IF -j DROP
-A DOCKER-USER -i $WAN_IF -j DROP
-A DOCKER-USER -j RETURN
COMMIT
# END SENTINEL-X DOCKER-USER"
current="$(sed -n '/^# BEGIN SENTINEL-X DOCKER-USER$/,/^# END SENTINEL-X DOCKER-USER$/p' "$AFTER_RULES" 2>/dev/null || true)"
if [[ "$current" == "$block" ]]; then
  log "$AFTER_RULES : bloc DOCKER-USER déjà à jour"
elif (( DRY )); then
  echo "  [dry-run] (re)placer dans $AFTER_RULES :"; sed 's/^/      /' <<<"$block"
else
  cp "$AFTER_RULES" "$AFTER_RULES.sentinel.bak"
  sed -i '/^# BEGIN SENTINEL-X DOCKER-USER$/,/^# END SENTINEL-X DOCKER-USER$/d' "$AFTER_RULES"
  printf '\n%s\n' "$block" >> "$AFTER_RULES"
  echo "  + bloc DOCKER-USER écrit dans $AFTER_RULES"
fi

# --- 3. SSH ------------------------------------------------------------------------------
sshd_conf="# SENTINEL-X — durcissement SSH (scripts/harden-host.sh)
PermitRootLogin no
PubkeyAuthentication yes
MaxAuthTries 3
X11Forwarding no"
(( DISABLE_PASSWORDS )) && sshd_conf+="
PasswordAuthentication no
KbdInteractiveAuthentication no"
SSHD_CHANGED=0
if [[ -f "$SSHD_DROPIN" && "$(cat "$SSHD_DROPIN")" == "$sshd_conf" ]]; then
  log "$SSHD_DROPIN déjà à jour"
elif (( DRY )); then
  echo "  [dry-run] écrire $SSHD_DROPIN :"; sed 's/^/      /' <<<"$sshd_conf"
else
  [[ -f "$SSHD_DROPIN" ]] && cp "$SSHD_DROPIN" "$SSHD_DROPIN.bak"
  printf '%s\n' "$sshd_conf" > "$SSHD_DROPIN"
  if ! sshd -t; then
    rm -f "$SSHD_DROPIN"; die "configuration sshd invalide : drop-in retiré, rien n'a changé."
  fi
  SSHD_CHANGED=1
fi

# --- 4. Activation + confirmation depuis une nouvelle session ------------------------
if (( DRY )); then
  echo "  [dry-run] ufw --force enable && ufw reload ; systemctl reload ssh"
else
  ufw --force enable >/dev/null && ufw reload >/dev/null
  (( SSHD_CHANGED )) && systemctl reload ssh
  if [[ -n "${SSH_CONNECTION:-}" && $YES -eq 0 ]]; then
    echo
    warn "ouvrez MAINTENANT une nouvelle session SSH vers ce Pi pour vérifier l'accès."
    if read -r -t 120 -p "Accès confirmé depuis une nouvelle session ? (oui) " ok && [[ "$ok" == "oui" ]]; then
      log "Accès confirmé."
    else
      warn "pas de confirmation : RETOUR ARRIÈRE (ufw désactivé, drop-in SSH retiré)."
      ufw --force disable >/dev/null
      if (( SSHD_CHANGED )); then
        if [[ -f "$SSHD_DROPIN.bak" ]]; then mv "$SSHD_DROPIN.bak" "$SSHD_DROPIN"; else rm -f "$SSHD_DROPIN"; fi
        systemctl reload ssh
      fi
      exit 1
    fi
  fi
fi

# --- 5. Groupe docker -------------------------------------------------------------------
members="$(getent group docker | cut -d: -f4 || true)"   # groupe absent : code 2
if [[ -n "$members" ]]; then
  warn "membres du groupe docker : $members"
  warn "appartenir au groupe docker = être root sur l'hôte. Retirer si inutile : sudo gpasswd -d <user> docker"
else
  log "groupe docker vide (OK : utiliser sudo docker ...)"
fi

if (( ! DRY )); then
  ufw status verbose
  iptables -S DOCKER-USER 2>/dev/null || true
fi
