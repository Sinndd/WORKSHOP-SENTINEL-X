#!/usr/bin/env bash
# ==============================================================================
# MISSION SENTINEL-X — Démarrage sécurisé en une seule commande
# ==============================================================================
# Cette commande initialise l'environnement, vérifie les prérequis de sécurité,
# génère les certificats TLS / mots de passe si besoin, et lance la stack Docker.
# ==============================================================================

set -euo pipefail
cd "$(dirname "$0")/.."

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}======================================================================${NC}"
echo -e "${BLUE}🛡️  MISSION SENTINEL-X — INITIALISATION DU SYSTÈME SÉCURISÉ${NC}"
echo -e "${BLUE}======================================================================${NC}"

# 1. Vérification de Docker / Compose
DOCKER_CMD=""
if command -v docker &>/dev/null && docker compose version &>/dev/null; then
  DOCKER_CMD="docker compose"
elif command -v podman &>/dev/null && podman compose version &>/dev/null; then
  DOCKER_CMD="podman compose"
else
  echo -e "${RED}[ERREUR] Ni 'docker compose' ni 'podman compose' n'est disponible sur ce système.${NC}"
  echo -e "Si vous êtes sur votre machine de développement, vous pouvez lancer l'API locale avec :"
  echo -e "  ${YELLOW}cd api && .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000${NC}"
  exit 1
fi

# 2. Génération de l'environnement sécurisé (.env)
if [[ ! -f .env || ! -f mosquitto/secrets/passwd ]]; then
  echo -e "${YELLOW}[1/4] Génération des secrets cryptographiques (.env)...${NC}"
  ./scripts/gen-env.sh
else
  echo -e "${GREEN}[1/4] Fichier .env présent et vérifié (mode 600).${NC}"
fi

# Refus des secrets déjà publiés dans l'historique Git
./scripts/check-secrets.sh

# 3. Génération de l'autorité de certification et des certificats TLS
if [[ ! -f mosquitto/certs/ca.crt || ! -f mosquitto/certs/server.crt ]]; then
  echo -e "${YELLOW}[2/4] Création de la PKI interne et des certificats TLS MQTTS...${NC}"
  ./scripts/gen-certs.sh
else
  echo -e "${GREEN}[2/4] Chaîne de certificats TLS P-256 présente et valide.${NC}"
fi

# 4. Compilation du Dashboard React
echo -e "${BLUE}[3/4] Vérification du build du Dashboard React...${NC}"
if [[ ! -f api/app/static/dashboard/index.html ]]; then
  echo -e "Compilation des assets statiques du Dashboard..."
  (cd dashboard && npm run build)
  mkdir -p api/app/static/dashboard
  cp -r dashboard/dist/* api/app/static/dashboard/
fi
echo -e "${GREEN}✓ Dashboard prêt.${NC}"

# 5. Lancement de la stack Docker durcie
echo -e "${BLUE}[4/4] Démarrage de la stack de conteneurs isolés...${NC}"
# PostgreSQL d'abord : les migrations (comptes, sessions, journal de sécurité) doivent précéder l'API.
$DOCKER_CMD up -d postgres
for _ in $(seq 1 30); do
  $DOCKER_CMD exec -T postgres sh -c 'pg_isready -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"' && break
  sleep 2
done
./scripts/migrate-db.sh
# Hors ligne (SENTINEL_OFFLINE=1, cf. install.sh) : images préchargées (docker load), aucun build ni téléchargement.
BUILD_FLAG="--build"; [[ "${SENTINEL_OFFLINE:-0}" == "1" ]] && BUILD_FLAG="--no-build"
$DOCKER_CMD up -d $BUILD_FLAG

echo -e "\n${GREEN}======================================================================${NC}"
echo -e "${GREEN}✅ SYSTÈME SENTINEL-X OPÉRATIONNEL & DURCI${NC}"
echo -e "${GREEN}======================================================================${NC}"
echo -e "🌐 Dashboard Tactique   : ${BLUE}https://localhost/dashboard/${NC}"
echo -e "📄 Documentation API    : ${BLUE}https://localhost/docs${NC}"
echo -e "🔒 Broker MQTTS         : ${BLUE}port 8883 (TLS 1.2+ obligatoire)${NC}"
echo -e "👤 Premier accès         : compte ${YELLOW}admin${NC} (DASHBOARD_USER), mot de passe temporaire = DASHBOARD_PASS dans .env"
echo -e "   Changement de mot de passe imposé à la 1re connexion, puis créez les comptes dans l'onglet Utilisateurs."
echo -e "\nPour voir l'état des services : ${YELLOW}./scripts/status.sh${NC}"
echo -e "Pour suivre les journaux      : ${YELLOW}$DOCKER_CMD logs -f${NC}"
