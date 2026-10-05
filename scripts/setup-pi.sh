#!/usr/bin/env bash
# Préparation du Raspberry Pi 3 B+ (Raspberry Pi OS Lite 64-bit) pour SENTINEL-X.
#
#   - vérifie l'OS 64-bit (aarch64) et le cgroup mémoire (sans lui, mem_limit est ignoré) ;
#   - swap en RAM compressée (zram), plus de fichier d'échange sur la carte SD ;
#   - vm.swappiness adapté à zram, écritures disque regroupées ;
#   - journald en RAM (volatile, 32 Mo max) ;
#   - désactive les services inutiles (bluetooth, avahi, triggerhappy, ModemManager, cups) ;
#   - gpu_mem=16 (Pi sans écran : ~60 Mo de RAM rendus à Linux) ;
#   - affiche la RAM disponible.
#
# Idempotent. Usage : sudo ./scripts/setup-pi.sh [--dry-run] [--yes] [--keep-avahi]
set -euo pipefail

DRY=0; YES=0; KEEP_AVAHI=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --yes|-y) YES=1 ;;
    --keep-avahi) KEEP_AVAHI=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "Option inconnue : $arg" >&2; exit 2 ;;
  esac
done

REBOOT=0
log()  { echo "[setup-pi] $*"; }
warn() { echo "[setup-pi] ATTENTION : $*" >&2; }
run()  { if (( DRY )); then echo "  [dry-run] $*"; else echo "  + $*"; "$@"; fi; }
unit_exists() { [[ -n "$(systemctl list-unit-files --no-legend "$1" 2>/dev/null)" ]]; }
# write_file <chemin> <contenu> : n'écrit que si le contenu diffère.
write_file() {
  if [[ -f "$1" && "$(cat "$1")" == "$2" ]]; then log "$1 déjà à jour"; return; fi
  if (( DRY )); then echo "  [dry-run] écrire $1 :"; sed 's/^/      /' <<<"$2"; return; fi
  mkdir -p "$(dirname "$1")"; printf '%s\n' "$2" > "$1"; echo "  + écrit $1"
}
# ensure_line <fichier> <ligne> : ajoute la ligne si absente.
ensure_line() {
  grep -qxF "$2" "$1" 2>/dev/null && { log "$1 contient déjà '$2'"; return 1; }
  if (( DRY )); then echo "  [dry-run] ajouter '$2' à $1"; else printf '%s\n' "$2" >> "$1"; echo "  + '$2' ajouté à $1"; fi
}

# --- Vérifications préalables ------------------------------------------------
arch="$(uname -m)"
[[ "$arch" == "aarch64" ]] || { echo "OS non 64-bit (uname -m = $arch) : installer Raspberry Pi OS Lite 64-bit." >&2; exit 1; }
log "Architecture : $arch (OK)"
(( DRY )) || [[ $EUID -eq 0 ]] || { echo "À lancer avec sudo (ou --dry-run)." >&2; exit 1; }

BOOT=/boot/firmware; [[ -f $BOOT/config.txt ]] || BOOT=/boot
CONFIG_TXT="$BOOT/config.txt"; CMDLINE_TXT="$BOOT/cmdline.txt"

if (( ! DRY && ! YES )); then
  read -r -p "Appliquer la configuration SENTINEL-X à ce Pi ? (oui/non) " answer
  [[ "$answer" == "oui" ]] || { echo "Abandon."; exit 1; }
fi

# --- 1. Cgroup mémoire (limites Docker) ------------------------------------------
if grep -qw memory /sys/fs/cgroup/cgroup.controllers 2>/dev/null; then
  log "cgroup mémoire actif (OK)"
elif [[ -f "$CMDLINE_TXT" ]]; then
  if grep -q 'cgroup_enable=memory' "$CMDLINE_TXT"; then
    log "cgroup mémoire déjà demandé dans $CMDLINE_TXT (redémarrage en attente ?)"
  else
    warn "cgroup mémoire inactif : les mem_limit Docker seraient ignorés."
    # cmdline.txt doit rester sur UNE seule ligne.
    run sed -i '1 s/$/ cgroup_enable=memory cgroup_memory=1/' "$CMDLINE_TXT"
  fi
  REBOOT=1
else
  warn "cgroup mémoire inactif et $CMDLINE_TXT introuvable : vérifier à la main."
fi

# --- 2. Swap : zram au lieu d'un fichier sur la carte SD ------------------------
if unit_exists dphys-swapfile.service; then
  if systemctl is-enabled --quiet dphys-swapfile.service; then
    run dphys-swapfile swapoff
    run systemctl disable --now dphys-swapfile.service
  fi
  [[ -f /var/swap ]] && run rm -f /var/swap
fi
if dpkg -s rpi-swap >/dev/null 2>&1; then
  log "rpi-swap détecté (Raspberry Pi OS Trixie) : zram déjà géré par l'OS"
else
  dpkg -s zram-tools >/dev/null 2>&1 || { run apt-get update -qq; run apt-get install -y -qq zram-tools; }
  write_file /etc/default/zramswap "# SENTINEL-X : swap compressé en RAM (aucune écriture sur la carte SD)
ALGO=zstd
PERCENT=50
PRIORITY=100"
  run systemctl enable zramswap.service
  run systemctl restart zramswap.service
fi

# --- 3. Noyau : swappiness (zram) et écritures regroupées ---------------------------
write_file /etc/sysctl.d/90-sentinel.conf "# SENTINEL-X
# Avec zram, swapper est peu coûteux (compression en RAM) : on préfère garder le cache.
vm.swappiness = 100
# Écriture différée toutes les 15 s au lieu de 5 s : moins d'usure de la carte SD.
vm.dirty_writeback_centisecs = 1500"
run sysctl -q --system

# --- 4. journald en RAM ---------------------------------------------------------------
write_file /etc/systemd/journald.conf.d/90-sentinel.conf "[Journal]
Storage=volatile
RuntimeMaxUse=32M"
run systemctl restart systemd-journald

# --- 5. Services inutiles ---------------------------------------------------------------
services=(bluetooth.service hciuart.service triggerhappy.service triggerhappy.socket
          ModemManager.service cups.service cups-browsed.service)
(( KEEP_AVAHI )) || services+=(avahi-daemon.service avahi-daemon.socket)
for unit in "${services[@]}"; do
  if unit_exists "$unit" && systemctl is-enabled --quiet "$unit" 2>/dev/null; then
    run systemctl disable --now "$unit"
  else
    log "$unit absent ou déjà désactivé"
  fi
done
(( KEEP_AVAHI )) || log "avahi désactivé : 'sentinel.local' doit être résolu par le DNS du point d'accès (dnsmasq : address=/sentinel.local/192.168.10.1)."

# --- 6. Mémoire GPU / Bluetooth (config.txt) -------------------------------------------------
if [[ -f "$CONFIG_TXT" ]]; then
  ensure_line "$CONFIG_TXT" "gpu_mem=16" && REBOOT=1 || true
  ensure_line "$CONFIG_TXT" "dtoverlay=disable-bt" && REBOOT=1 || true
fi

# --- 7. Docker -----------------------------------------------------------------------------
if command -v docker >/dev/null; then
  log "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?') installé"
  [[ -f /etc/docker/daemon.json ]] || write_file /etc/docker/daemon.json '{
  "log-driver": "json-file",
  "log-opts": { "max-size": "5m", "max-file": "2" }
}'
else
  warn "Docker absent : https://docs.docker.com/engine/install/debian/ (dépôt officiel, paquets arm64)."
fi
[[ "$(findmnt -no OPTIONS /)" == *noatime* ]] || warn "/ n'est pas monté en noatime (ajouter noatime dans /etc/fstab)."

# --- Bilan ---------------------------------------------------------------------------------
echo
log "Mémoire :"
command -v free >/dev/null && free -m
swapon --show 2>/dev/null || true
awk '/MemAvailable/ { printf "[setup-pi] RAM disponible : %d Mo\n", $2 / 1024 }' /proc/meminfo
(( REBOOT )) && warn "redémarrage nécessaire pour appliquer cgroup/gpu_mem/bluetooth : sudo reboot"
exit 0
