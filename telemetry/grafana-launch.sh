#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/tlda"
PASSWORD_FILE="$CONFIG_DIR/grafana-admin-password"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"
if [[ ! -s "$PASSWORD_FILE" ]]; then
  umask 077
  openssl rand -base64 24 > "$PASSWORD_FILE"
fi
chmod 600 "$PASSWORD_FILE"
IFS= read -r GRAFANA_ADMIN_PASSWORD < "$PASSWORD_FILE"
[[ -n "$GRAFANA_ADMIN_PASSWORD" ]] || { echo "Grafana admin password is empty" >&2; exit 1; }

export GRAFANA_ADMIN_PASSWORD
export GF_AUTH_ANONYMOUS_ENABLED=true
export GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer
exec "$ROOT/telemetry/stack.sh" run
