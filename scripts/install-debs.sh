#!/usr/bin/env bash
# Installe HORS LIGNE les paquets Debian du paquet (Docker Engine, compose, ufw, fail2ban...) depuis un dossier de .deb.
# Politique : installe les paquets ABSENTS ; ne met à jour que ceux de Docker (docker-*, containerd.io). Les autres paquets déjà
# présents (systemd, python3, libc...) ne sont jamais touchés : pas de mise à jour système partielle hors ligne.
# Usage : sudo ./scripts/install-debs.sh <dossier-debs>      (appelé par install.sh --bundle)
set -euo pipefail
DIR="${1:?usage : $0 <dossier-debs>}"
[[ $EUID -eq 0 ]] || { echo "À lancer avec sudo." >&2; exit 1; }
compgen -G "$DIR/*.deb" >/dev/null || { echo "Aucun .deb dans $DIR" >&2; exit 1; }

# La suite Debian du paquet doit correspondre à celle du Pi (les dépendances sont résolues pour elle).
manifest="$DIR/../MANIFEST"
if [[ -f "$manifest" ]]; then
  want="$(sed -n 's/^suite=//p' "$manifest")"; have="$(. /etc/os-release; echo "${VERSION_CODENAME:-?}")"
  [[ "$want" == "$have" ]] || { echo "Paquet préparé pour '$want' mais ce système est '$have' : refaire ./scripts/bundle-offline.sh --suite $have" >&2; exit 1; }
fi

todo=()
for f in "$DIR"/*.deb; do
  pkg="$(dpkg-deb -f "$f" Package)"; ver="$(dpkg-deb -f "$f" Version)"
  cur="$(dpkg-query -W -f='${Version}' "$pkg" 2>/dev/null || true)"
  if [[ -n "$cur" ]]; then
    case "$pkg" in docker-*|containerd.io) dpkg --compare-versions "$cur" ge "$ver" && continue ;; *) continue ;; esac
  fi
  todo+=("$f")
done
if (( ${#todo[@]} )); then
  echo "[install-debs] Installation de ${#todo[@]} paquet(s)..."
  DEBIAN_FRONTEND=noninteractive dpkg -i "${todo[@]}"
else
  echo "[install-debs] Tous les paquets sont déjà installés."
fi

systemctl enable --now docker >/dev/null 2>&1 || true
user="${SUDO_USER:-}"
if [[ -n "$user" && "$user" != root ]] && ! id -nG "$user" | grep -qw docker; then
  usermod -aG docker "$user"
  echo "[install-debs] $user ajouté au groupe docker (équivaut à root sur l'hôte, cf. harden-host.sh)."
fi
echo "[install-debs] Terminé."
