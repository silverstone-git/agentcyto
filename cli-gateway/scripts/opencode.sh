#!/usr/bin/env bash
# Render opencode/opencode.json for this machine. The gateway key goes into
# secrets/opencode.key (chmod 600) and OpenCode reads it with {file:...}, so it never
# sits in your shell environment or in the JSON.
# shellcheck source=scripts/_lib.sh
source "$(dirname "$0")/_lib.sh"
need_secrets
key="$(secret LITELLM_MASTER_KEY)"
[ -n "$key" ] || { echo "LITELLM_MASTER_KEY is empty in secrets/gateway.env" >&2; exit 1; }
umask 077
printf '%s' "$key" > secrets/opencode.key
port="$(grep -E '^GATEWAY_PORT=' .env 2>/dev/null | cut -d= -f2- || true)"
sed -e "s#__PORT__#${port:-4000}#g" -e "s#__KEYFILE__#$root/secrets/opencode.key#g" \
  opencode/opencode.template.json > opencode/opencode.json
chmod 644 opencode/opencode.json
echo "wrote opencode/opencode.json"
echo "use it per project:  cp $root/opencode/opencode.json <project>/opencode.json"
echo "or merge its \"provider\" block into ~/.config/opencode/opencode.json"
