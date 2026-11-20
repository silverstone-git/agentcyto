#!/usr/bin/env bash
# Key sanity check: lengths only, HTTP status per provider, and whether our model ids exist.
# shellcheck source=scripts/_lib.sh
source "$(dirname "$0")/_lib.sh"
need_secrets
tool python /app/tools/check_keys.py
