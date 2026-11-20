#!/usr/bin/env bash
# One tiny prompt per model through the running gateway: scripts/smoke.sh [model ...]
# shellcheck source=scripts/_lib.sh
source "$(dirname "$0")/_lib.sh"
need_secrets
docker compose ps --status running --services | grep -qx gateway || {
  echo "gateway not running: docker compose up -d --build gateway" >&2; exit 1; }
tool python /app/tools/smoke.py "$@"
