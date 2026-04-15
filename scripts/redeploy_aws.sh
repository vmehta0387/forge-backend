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
#   EXPORT_TIMEOUT_MS=360000
#   MAX_PARALLEL_EXPORTS=1
#   FAST_EXPORT_TIMEOUT_MS=120000
#   FAST_DECIMATE_RATIO=0.88
#   EXPORT_MODE=robust
#   ALLOW_LITE_FALLBACK=1
#   MAX_PARALLEL_QUEUED_EXPORTS=1
#   MAX_QUEUED_JOBS=100
#   MAX_STORED_JOBS=400
#   JOB_RETENTION_MS=86400000
#   JOB_NOTIFY_WEBHOOK_URL=https://your-webhook-url
#   SKIP_GIT_PULL=1

BRANCH="${BRANCH:-main}"
APP_NAME="${APP_NAME:-forge-backend}"
IMAGE_NAME="${IMAGE_NAME:-forge-backend:latest}"
HOST_BIND="${HOST_BIND:-127.0.0.1}"
HOST_PORT="${HOST_PORT:-10000}"
CONTAINER_PORT="${CONTAINER_PORT:-10000}"
EXPORT_TIMEOUT_MS="${EXPORT_TIMEOUT_MS:-360000}"
MAX_PARALLEL_EXPORTS="${MAX_PARALLEL_EXPORTS:-1}"
FAST_EXPORT_TIMEOUT_MS="${FAST_EXPORT_TIMEOUT_MS:-120000}"
FAST_DECIMATE_RATIO="${FAST_DECIMATE_RATIO:-0.88}"
EXPORT_MODE="${EXPORT_MODE:-robust}"
ALLOW_LITE_FALLBACK="${ALLOW_LITE_FALLBACK:-1}"
MAX_PARALLEL_QUEUED_EXPORTS="${MAX_PARALLEL_QUEUED_EXPORTS:-1}"
MAX_QUEUED_JOBS="${MAX_QUEUED_JOBS:-100}"
MAX_STORED_JOBS="${MAX_STORED_JOBS:-400}"
JOB_RETENTION_MS="${JOB_RETENTION_MS:-86400000}"
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
  -e "BLENDER_BIN=/usr/bin/blender"
  -e "EXPORT_TIMEOUT_MS=${EXPORT_TIMEOUT_MS}"
  -e "MAX_PARALLEL_EXPORTS=${MAX_PARALLEL_EXPORTS}"
  -e "FAST_EXPORT_TIMEOUT_MS=${FAST_EXPORT_TIMEOUT_MS}"
  -e "FAST_DECIMATE_RATIO=${FAST_DECIMATE_RATIO}"
  -e "EXPORT_MODE=${EXPORT_MODE}"
  -e "ALLOW_LITE_FALLBACK=${ALLOW_LITE_FALLBACK}"
  -e "MAX_PARALLEL_QUEUED_EXPORTS=${MAX_PARALLEL_QUEUED_EXPORTS}"
  -e "MAX_QUEUED_JOBS=${MAX_QUEUED_JOBS}"
  -e "MAX_STORED_JOBS=${MAX_STORED_JOBS}"
  -e "JOB_RETENTION_MS=${JOB_RETENTION_MS}"
)

if [[ -f ".env.aws" ]]; then
  echo "[redeploy] loading extra env from .env.aws"
  RUN_ARGS+=(--env-file ".env.aws")
fi

if [[ -n "${JOB_NOTIFY_WEBHOOK_URL:-}" ]]; then
  RUN_ARGS+=(-e "JOB_NOTIFY_WEBHOOK_URL=${JOB_NOTIFY_WEBHOOK_URL}")
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
