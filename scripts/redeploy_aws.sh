#!/usr/bin/env bash
set -euo pipefail

# AWS EC2 redeploy script for Forge backend.
# Usage:
#   chmod +x scripts/redeploy_aws.sh
#   ./scripts/redeploy_aws.sh
#
# Optional env overrides:
#   BRANCH=main
#   APP_NAME=forge-backend
#   IMAGE_NAME=forge-backend:latest
#   HOST_BIND=127.0.0.1
#   HOST_PORT=10000
#   CONTAINER_PORT=10000
#   MAX_PARALLEL_EXPORTS=1
#   TRIMESH_CLEAN_TIMEOUT_MS=120000
#   COLOR_3MF_TIMEOUT_MS=180000
#   SKIP_GIT_PULL=1

BRANCH="${BRANCH:-main}"
APP_NAME="${APP_NAME:-forge-backend}"
IMAGE_NAME="${IMAGE_NAME:-forge-backend:latest}"
HOST_BIND="${HOST_BIND:-127.0.0.1}"
HOST_PORT="${HOST_PORT:-10000}"
CONTAINER_PORT="${CONTAINER_PORT:-10000}"
MAX_PARALLEL_EXPORTS="${MAX_PARALLEL_EXPORTS:-1}"
TRIMESH_CLEAN_TIMEOUT_MS="${TRIMESH_CLEAN_TIMEOUT_MS:-120000}"
COLOR_3MF_TIMEOUT_MS="${COLOR_3MF_TIMEOUT_MS:-180000}"
SKIP_GIT_PULL="${SKIP_GIT_PULL:-0}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "[redeploy] app dir: ${APP_DIR}"
cd "${APP_DIR}"

if [[ "${SKIP_GIT_PULL}" != "1" ]]; then
  echo "[redeploy] updating git branch: ${BRANCH}"
  git fetch origin "${BRANCH}"
  git checkout "${BRANCH}"
  git pull --ff-only origin "${BRANCH}"
else
  echo "[redeploy] SKIP_GIT_PULL=1 (using current local code)"
fi

echo "[redeploy] building docker image: ${IMAGE_NAME}"
docker build -t "${IMAGE_NAME}" .

if docker ps -a --format '{{.Names}}' | grep -q "^${APP_NAME}$"; then
  echo "[redeploy] stopping old container: ${APP_NAME}"
  docker stop "${APP_NAME}" >/dev/null || true
  docker rm "${APP_NAME}" >/dev/null || true
fi

RUN_ARGS=(
  -d
  --name "${APP_NAME}"
  --restart unless-stopped
  -p "${HOST_BIND}:${HOST_PORT}:${CONTAINER_PORT}"
  -e "PORT=${CONTAINER_PORT}"
  -e "ASSET_ROOT=/app/assets"
  -e "PYTHON_BIN=/usr/bin/python3"
  -e "MAX_PARALLEL_EXPORTS=${MAX_PARALLEL_EXPORTS}"
  -e "TRIMESH_CLEAN_TIMEOUT_MS=${TRIMESH_CLEAN_TIMEOUT_MS}"
  -e "COLOR_3MF_TIMEOUT_MS=${COLOR_3MF_TIMEOUT_MS}"
)

if [[ -f ".env.aws" ]]; then
  echo "[redeploy] loading extra env from .env.aws"
  RUN_ARGS+=(--env-file ".env.aws")
fi

echo "[redeploy] starting new container: ${APP_NAME}"
docker run "${RUN_ARGS[@]}" "${IMAGE_NAME}"

echo "[redeploy] waiting for health..."
for i in {1..25}; do
  if curl -fsS "http://${HOST_BIND}:${HOST_PORT}/health" >/dev/null; then
    echo "[redeploy] health ok"
    break
  fi
  sleep 2
done

echo "[redeploy] deps check:"
curl -fsS "http://${HOST_BIND}:${HOST_PORT}/health/deps" || true
echo
echo "[redeploy] done"
