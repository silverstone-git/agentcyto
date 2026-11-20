#!/usr/bin/env bash
# List or clear the chat -> CLI session map: scripts/sessions.sh [list|clear]
# shellcheck source=scripts/_lib.sh
source "$(dirname "$0")/_lib.sh"
need_secrets
tool python /app/tools/sessions.py "${1:-list}"
