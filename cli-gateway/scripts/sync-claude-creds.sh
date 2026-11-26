#!/usr/bin/env bash
# Heal the container's Claude credentials from the host login.
#
# The container mounts cli-gateway/secrets/cli-state/claude/, a staged copy of
# ~/.claude. When that copy's refresh token is empty/expired the claude-agent
# model fails with "OAuth session expired and could not be refreshed".
#
# Safety rule: copy host -> staged only when the staged copy is unusable AND the
# host copy is usable. A valid staged copy is never overwritten, so a stale host
# file cannot clobber a token the container refreshed on its own.
#
# Never prints token values. Exit 0 = ok/no-op, 1 = manual login required.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOST_CREDS="${CLAUDE_HOST_CREDS:-$HOME/.claude/.credentials.json}"
STAGED_CREDS="${CLAUDE_STAGED_CREDS:-$ROOT/cli-gateway/secrets/cli-state/claude/.credentials.json}"

# Serialise runs (systemd timer + a manual run should not race). Best effort:
# if the lock cannot be opened we still proceed rather than skip a needed heal.
LOCK="${CLAUDE_CREDS_LOCK:-$ROOT/cli-gateway/secrets/.claude-creds-sync.lock}"
if command -v flock >/dev/null 2>&1 && { exec 9>"$LOCK"; } 2>/dev/null; then
  flock -n 9 || { echo "another sync is already running"; exit 0; }
fi

# Prints "valid" or "invalid: <reason>" for a credentials file.
creds_state() {
  python3 - "$1" <<'PY'
import json, sys, time
p = sys.argv[1]
try:
    d = json.load(open(p))
except FileNotFoundError:
    print("invalid: missing"); raise SystemExit
except Exception:
    print("invalid: unreadable"); raise SystemExit
o = d.get("claudeAiOauth") or {}
ref = str(o.get("refreshToken") or "")
try:
    rexp = int(o.get("refreshTokenExpiresAt") or 0)
except Exception:
    rexp = 0
now = time.time() * 1000
if not ref:
    print("invalid: no refresh token")
elif rexp and rexp < now:
    print("invalid: refresh token expired")
else:
    # The access token may be near/after expiry; the CLI refreshes it itself.
    print("valid")
PY
}

staged="$(creds_state "$STAGED_CREDS")"
if [ "$staged" = "valid" ]; then
  echo "staged Claude credentials valid — nothing to do"
  exit 0
fi

host="$(creds_state "$HOST_CREDS")"
if [ "$host" != "valid" ]; then
  echo "staged copy unusable ($staged) and host copy unusable ($host); run scripts/login.sh claude" >&2
  exit 1
fi

mkdir -p "$(dirname "$STAGED_CREDS")"
ts="$(date +%Y%m%d-%H%M%S)"
if [ -f "$STAGED_CREDS" ]; then
  cp -a "$STAGED_CREDS" "$STAGED_CREDS.bak-$ts"
fi
cp "$HOST_CREDS" "$STAGED_CREDS"
chmod 600 "$STAGED_CREDS"
# Match the rest of the mounted dir (APP_UID=1001) so the container can read/write it.
chown 1001:1001 "$STAGED_CREDS" 2>/dev/null || true
echo "staged Claude credentials refreshed from host login (backup: .credentials.json.bak-$ts)"
