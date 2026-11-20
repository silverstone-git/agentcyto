#!/usr/bin/env bash
# Idempotent exposure helper for agentcyto at /agentcyto/.
# Usage: bash agentcyto/scripts/deploy.sh
# Never prints AUTHKEY or any provider secret.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VHOST="/etc/nginx/sites-available/t.aryan.cfd"
HTPASSWD="/etc/nginx/.htpasswd-agentcyto"
SUDO="$(command -v sudo || true)"

run_priv() { if [ -n "$SUDO" ] && [ "$(id -u)" -ne 0 ]; then "$SUDO" "$@"; else "$@"; fi; }

AUTHKEY_VALUE="$(grep -E '^AUTHKEY=' "$ROOT/.env" | tail -n1 | cut -d= -f2- | tr -d '\r')"
AUTHKEY_VALUE="${AUTHKEY_VALUE%\"}"
AUTHKEY_VALUE="${AUTHKEY_VALUE#\"}"
AUTHKEY_VALUE="${AUTHKEY_VALUE%\'}"
AUTHKEY_VALUE="${AUTHKEY_VALUE#\'}"
if [ -z "$AUTHKEY_VALUE" ]; then
  echo "AUTHKEY missing from root .env" >&2
  exit 1
fi

if ! command -v htpasswd >/dev/null 2>&1; then
  run_priv apt-get update -qq
  run_priv apt-get install -y -qq apache2-utils >/dev/null
fi

printf '%s' "$AUTHKEY_VALUE" | run_priv htpasswd -i -c "$HTPASSWD" agentcyto >/dev/null
run_priv chmod 640 "$HTPASSWD"
run_priv chgrp www-data "$HTPASSWD"
echo "htpasswd refreshed (value not shown)"

if ! grep -q 'location /agentcyto/' "$VHOST"; then
  echo "nginx /agentcyto route missing — patch $VHOST first" >&2
  exit 1
fi

run_priv nginx -t
run_priv systemctl reload nginx
echo "nginx reloaded"
