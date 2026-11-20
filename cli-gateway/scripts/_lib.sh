# shellcheck shell=bash
# Shared helpers. Sourced by the other scripts; not run directly.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export root
cd "$root"

need_secrets() {
  [ -f secrets/gateway.env ] || {
    echo "secrets/gateway.env missing: cp secrets/gateway.env.example secrets/gateway.env && chmod 600 secrets/gateway.env" >&2
    exit 1
  }
}

# Read one value from secrets/gateway.env without sourcing or echoing it.
secret() { grep -E "^$1=" secrets/gateway.env | tail -n1 | cut -d= -f2-; }

# Run a command in the on-demand tool container (same image, volumes and env as the gateway).
tool() { docker compose --profile tools run --rm --no-deps cli "$@"; }
