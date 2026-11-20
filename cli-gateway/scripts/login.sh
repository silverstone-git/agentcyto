#!/usr/bin/env bash
# Sign the CLIs in, inside the container, so their state lands in the named volumes.
#   scripts/login.sh claude   -> prints a long-lived token; paste it into secrets/gateway.env
#   scripts/login.sh agy      -> interactive Antigravity sign-in; type /quit when done
# shellcheck source=scripts/_lib.sh
source "$(dirname "$0")/_lib.sh"
need_secrets
case "${1:-}" in
  claude)
    tool claude setup-token
    echo
    echo "Put the token in secrets/gateway.env as CLAUDE_CODE_OAUTH_TOKEN=..., then: docker compose up -d gateway"
    ;;
  agy)
    tool bash -lc 'cd /scratch && agy'
    echo "If sign-in worked, credentials are stored in the agy-config volume. Check: scripts/smoke.sh agy-cli"
    ;;
  *) echo "usage: $0 claude|agy" >&2; exit 2 ;;
esac
