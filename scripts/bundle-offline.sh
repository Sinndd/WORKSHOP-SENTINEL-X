#!/usr/bin/env bash
# Prépare, SUR UNE MACHINE CONNECTÉE À INTERNET, un paquet unique pour installer SENTINEL-X sur un Pi SANS Internet :
#   debs/    Docker Engine + plugin compose, ufw, fail2ban, openssl, python3, curl... et toutes leurs dépendances (arm64)
#   images   images Docker de la stack (api + dashboard, ingestor, ntp, caddy, postgres, mosquitto), arm64
#   repo/    le dépôt (sans .git, node_modules, .env, certificats, clés)
# Résultat : sentinel-offline-<suite>-arm64.tar.gz (+ .sha256) à copier sur le Pi (clé USB, scp).
#
# La suite Debian doit être celle du Pi :  grep VERSION_CODENAME /etc/os-release   (Raspberry Pi OS actuel : trixie ; avant : bookworm)
# Prérequis : docker (buildx) ; si la machine n'est pas arm64 : émulation
#   docker run --privileged --rm tonistiigi/binfmt --install arm64
# Usage : ./scripts/bundle-offline.sh [--suite trixie|bookworm] [--out fichier.tar.gz] [--skip-images] [--skip-debs]
set -euo pipefail
cd "$(dirname "$0")/.."

SUITE=trixie; OUT=""; SKIP_IMAGES=0; SKIP_DEBS=0; PLATFORM="${BUNDLE_PLATFORM:-linux/arm64}"
while (( $# )); do
  case "$1" in
    --suite) SUITE="${2:?--suite attend trixie ou bookworm}"; shift ;;
    --out) OUT="${2:?--out attend un fichier}"; shift ;;
    --skip-images) SKIP_IMAGES=1 ;;
    --skip-debs) SKIP_DEBS=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "Option inconnue : $1" >&2; exit 2 ;;
  esac
  shift
done
ARCH="${PLATFORM#linux/}"
OUT="${OUT:-sentinel-offline-$SUITE-$ARCH.tar.gz}"
command -v docker >/dev/null && docker compose version >/dev/null 2>&1 || { echo "docker compose requis." >&2; exit 1; }

# Émulation : une machine non arm64 doit pouvoir exécuter des conteneurs arm64 (qemu-user + binfmt), sinon « Exec format error ».
if [[ "$ARCH" == "arm64" && "$(uname -m)" != "aarch64" ]]; then
  if ! docker run --rm --platform "$PLATFORM" docker.io/library/alpine:3.22 true >/dev/null 2>&1; then
    cat >&2 <<MSG
[bundle] ERREUR : cette machine ($(uname -m)) ne sait pas exécuter de conteneurs arm64 (émulation absente).
  Fedora/RHEL : sudo dnf install qemu-user-static          Debian/Ubuntu : sudo apt install qemu-user-static binfmt-support
  Autre / Docker : docker run --privileged --rm tonistiigi/binfmt --install arm64
  Puis relancer ce script.
MSG
    exit 1
  fi
fi
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK" 2>/dev/null || true' EXIT
B="$WORK/sentinel-offline"; mkdir -p "$B/debs" "$B/repo"
log() { echo "[bundle] $*"; }
# Nom complet de l'image : podman refuse les noms courts et nommerait les images locales « localhost/... » ; Docker
# normalise docker.io/library/x et docker.io/sentinel/x en x et sentinel/x au chargement : le compose les retrouve.
qualify() {
  case "$1" in
    */*) [[ "${1%%/*}" == *.* || "${1%%/*}" == *:* || "${1%%/*}" == localhost ]] && echo "$1" || echo "docker.io/$1" ;;
    *) echo "docker.io/library/$1" ;;
  esac
}

# --- 1. Paquets Debian (arm64) : résolus et téléchargés dans un conteneur de la même suite ---------------------
if (( ! SKIP_DEBS )); then
  log "Paquets Debian ($SUITE, $ARCH) : Docker Engine, compose, ufw, fail2ban..."
  chmod 777 "$B/debs"
  docker run --rm --platform "$PLATFORM" --security-opt label=disable -v "$B/debs:/out" -e SUITE="$SUITE" -e ARCH="$ARCH" "docker.io/library/debian:$SUITE" bash -euxc '
    rm -f /etc/apt/apt.conf.d/docker-clean                 # sinon apt supprime les .deb téléchargés
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl gnupg >/dev/null
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
    echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $SUITE stable" > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y --download-only docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
      ufw fail2ban openssl python3 curl iptables
    cp /var/cache/apt/archives/*.deb /out/
    chmod -R a+rwX /out
  ' >/dev/null
  log "$(ls "$B/debs" | wc -l) paquets .deb"
fi

# --- 2. Images Docker (arm64) ------------------------------------------------------------------------------------
if (( ! SKIP_IMAGES )); then
  export DOCKER_DEFAULT_PLATFORM="$PLATFORM"
  # Les variables obligatoires du compose (${VAR:?}) reçoivent des valeurs factices : on ne lit que la liste d'images.
  ENVF="$WORK/dummy.env"
  grep -oE '\$\{[A-Z0-9_]+:\?' docker-compose.yml | tr -d '${:?' | sort -u | sed 's/$/=x/' > "$ENVF"
  # `docker compose pull/build` exige le démon Docker (ou un socket podman actif) ; on lit seulement la définition des
  # services (compose config, sans démon) puis on tire/construit chaque image avec le CLI docker simple.
  JSON="$(docker compose --env-file "$ENVF" config --format json 2>/dev/null)"
  mapfile -t PLAN < <(python3 -c '
import json, sys
raw = sys.stdin.read()
for name, svc in json.loads(raw[raw.index("{"):])["services"].items():
    img = svc["image"]; b = svc.get("build")
    if b: print("build", img, b["context"], b.get("dockerfile", "Dockerfile"), sep="|")
    else: print("pull", img, sep="|")
' <<<"$JSON")
  IMAGES=()
  for line in "${PLAN[@]}"; do
    IFS='|' read -r action img ctx dockerfile <<<"$line"
    img="$(qualify "$img")"
    IMAGES+=("$img")
    if [[ "$action" == build ]]; then
      log "Construction de $img ($ARCH)..."
      docker build --platform "$PLATFORM" -t "$img" -f "$ctx/$dockerfile" "$ctx"
    else
      log "Téléchargement de $img ($ARCH)..."
      docker pull --platform "$PLATFORM" "$img"
    fi
  done
  for img in "${IMAGES[@]}"; do
    a="$(docker image inspect "$img" --format '{{.Architecture}}')"
    [[ "$a" == "$ARCH" ]] || { echo "[bundle] ERREUR : $img est en $a ($ARCH attendu). Activer l'émulation (voir en-tête)." >&2; exit 1; }
  done
  log "Enregistrement des images : ${IMAGES[*]}"
  # podman : sans --multi-image-archive, `save` de plusieurs images range TOUS les noms sur la première image.
  SAVE_FLAGS=(); docker save --help 2>&1 | grep -q -- '--multi-image-archive' && SAVE_FLAGS=(--multi-image-archive)
  docker save "${SAVE_FLAGS[@]}" "${IMAGES[@]}" | gzip > "$B/images.tar.gz"
  # Contrôle : une entrée distincte par image, chacune avec son nom.
  gunzip -c "$B/images.tar.gz" | tar -xOf - manifest.json | python3 -c '
import json, sys
want = set(sys.argv[1:])
entries = json.load(sys.stdin)
got = [e.get("RepoTags") or [] for e in entries]
bad = [w for w in want if sum(w in tags for tags in got) != 1] + [t for t in got if len(t) != 1]
if len(entries) != len(want) or bad:
    sys.exit("[bundle] ERREUR : archive images incohérente (%d entrées pour %d images) : %s" % (len(entries), len(want), got))
' "${IMAGES[@]}"
fi

# --- 3. Dépôt (sans secrets ni dépendances) --------------------------------------------------------------------------
log "Copie du dépôt..."
tar --exclude=.git --exclude=node_modules --exclude=.env --exclude='mosquitto/certs/*' --exclude='mosquitto/secrets/*' \
    --exclude='*.tar.gz' --exclude='*.key' --exclude='*.pem' --exclude=backups --exclude=__pycache__ --exclude=.venv \
    --exclude='firmware/sentinel_core/secrets.h' -cf - . | tar -xf - -C "$B/repo"
mkdir -p "$B/repo/mosquitto/certs" "$B/repo/mosquitto/secrets"; touch "$B/repo/mosquitto/certs/.gitkeep" "$B/repo/mosquitto/secrets/.gitkeep"

# --- 4. Manifeste, sommes de contrôle, lanceur ------------------------------------------------------------------------
printf 'suite=%s\narch=%s\ndate=%s\n' "$SUITE" "$ARCH" "$(date -Iseconds)" > "$B/MANIFEST"
cat > "$B/install.sh" <<'LAUNCH'
#!/usr/bin/env bash
# Lanceur : à exécuter depuis le dossier décompressé, sur le Pi.   ./install.sh [options de scripts/install.sh]
cd "$(dirname "$0")/repo" && exec ./scripts/install.sh --bundle .. "$@"
LAUNCH
chmod +x "$B/install.sh"
(cd "$B" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)

log "Écriture de $OUT ..."
tar -C "$WORK" -czf "$OUT" sentinel-offline
sha256sum "$OUT" | tee "$OUT.sha256"
log "Terminé : $(du -h "$OUT" | cut -f1). Sur le Pi : tar xzf $OUT && cd sentinel-offline && ./install.sh"
