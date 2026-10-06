#!/usr/bin/env bash
# Durcissement système de l'hôte SENTINEL-X (Raspberry Pi OS / Debian), complément de harden-host.sh (pare-feu + SSH) :
#   - mises à jour de sécurité automatiques (unattended-upgrades) ;
#   - fail2ban sur SSH (bannissement des tentatives répétées) ;
#   - sysctl réseau/noyau : SYN cookies, anti-spoofing (rp_filter), pas de redirections ICMP ni de source routing,
#     noyau moins bavard (kptr_restrict, dmesg_restrict), liens/FIFO protégés ;
#   - démon Docker : no-new-privileges par défaut, live-restore, journaux plafonnés.
#     (IP forwarding NON touché : Docker en a besoin.)
#
# Idempotent. Usage : sudo ./scripts/harden-os.sh [--dry-run]
set -euo pipefail

DRY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Option inconnue : $arg" >&2; exit 2 ;;
  esac
done

log()  { echo "[harden-os] $*"; }
run()  { if (( DRY )); then echo "  [dry-run] $*"; else echo "  + $*"; "$@"; fi; }
(( DRY )) || [[ $EUID -eq 0 ]] || { echo "À lancer avec sudo (ou --dry-run)." >&2; exit 1; }

# Le Pi n'a normalement pas Internet : sans réseau, on n'installe rien (les paquets doivent déjà être présents).
online() { timeout 4 bash -c '</dev/tcp/deb.debian.org/80' >/dev/null 2>&1; }
# write_file <chemin> <contenu> : n'écrit que si le contenu diffère ; code retour 0 = modifié.
write_file() {
  if [[ -f "$1" && "$(cat "$1")" == "$2" ]]; then log "$1 déjà à jour"; return 1; fi
  if (( DRY )); then echo "  [dry-run] écrire $1 :"; sed 's/^/      /' <<<"$2"; return 0; fi
  mkdir -p "$(dirname "$1")"; printf '%s\n' "$2" > "$1"; echo "  + écrit $1"
}

# --- 1. Mises à jour de sécurité automatiques ------------------------------------------------
if ! dpkg -s unattended-upgrades >/dev/null 2>&1 && online; then
  run apt-get update -qq
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unattended-upgrades
fi
if dpkg -s unattended-upgrades >/dev/null 2>&1; then
  write_file /etc/apt/apt.conf.d/20auto-upgrades 'APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";' || true
else
  log "unattended-upgrades ignoré (hors ligne : sans Internet, pas de mises à jour automatiques ; mettre à jour le Pi à la main quand il est connecté)."
fi

# --- 2. fail2ban (SSH) -------------------------------------------------------------------------
if ! dpkg -s fail2ban >/dev/null 2>&1 && online; then
  run apt-get update -qq
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq fail2ban
fi
if ! dpkg -s fail2ban >/dev/null 2>&1; then
  log "ATTENTION : fail2ban absent et pas d'Internet : installer le paquet avant de couper le réseau (sudo apt install fail2ban)."
elif write_file /etc/fail2ban/jail.d/sentinel.local '[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
backend  = systemd

[sshd]
enabled = true'; then
  if (( ! DRY )); then systemctl enable fail2ban >/dev/null 2>&1; systemctl restart fail2ban; fi
fi

# --- 3. sysctl ---------------------------------------------------------------------------------
if write_file /etc/sysctl.d/99-sentinel-hardening.conf '# SENTINEL-X — durcissement noyau/réseau (scripts/harden-os.sh)
net.ipv4.tcp_syncookies = 1
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv4.conf.all.log_martians = 1
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.icmp_ignore_bogus_error_responses = 1
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1
kernel.unprivileged_bpf_disabled = 1
fs.protected_hardlinks = 1
fs.protected_symlinks = 1
fs.protected_fifos = 2
fs.protected_regular = 2'; then
  (( DRY )) || sysctl --system >/dev/null
fi

# --- 4. Démon Docker -------------------------------------------------------------------------------
DAEMON=/etc/docker/daemon.json
if command -v docker >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
  new="$(python3 - "$DAEMON" <<'PY'
import json, os, sys
p = sys.argv[1]
cfg = json.load(open(p)) if os.path.exists(p) and os.path.getsize(p) else {}
cfg.update({"no-new-privileges": True, "live-restore": True,
            "log-driver": "json-file", "log-opts": {"max-size": "5m", "max-file": "2"}})
print(json.dumps(cfg, indent=2, sort_keys=True))
PY
)"
  if write_file "$DAEMON" "$new"; then
    # live-restore garde les conteneurs en vie pendant le rechargement ; seul un redémarrage complet prend en compte no-new-privileges.
    (( DRY )) || { systemctl restart docker; log "Docker redémarré (les conteneurs repartent : restart: unless-stopped)."; }
  fi
else
  log "Docker ou python3 absent : durcissement du démon ignoré."
fi

log "Terminé."
