#!/bin/sh
# fly-entrypoint-agent.sh — AGENT-box entrypoint.
#
# An agent box runs the fleet-daemon (NOT the tlda server) and codex agents in
# tmux. It connects over WebSocket to a render box (TLDA_SERVER) and spawns route
# to it by machine_id. The container IS the sandbox (one friend, one paper), so
# no macOS `fence` is used.
#
# Persistent state wired to the volume (mounted at /app/server/persist):
#   ~/.codex/        (auth.json from `codex login` + config.toml)  -> persist/codex
#   ~/.config/tlda/  (daemon config + machine id)                  -> persist/tlda-config
#
# Required env (set in fly.agent.toml):
#   TLDA_SERVER       — the render box URL the daemon connects to
#   TLDA_MACHINE_ID   — a distinct id per friend's agent box (ownership dedup)
set -e

PERSIST=/app/server/persist
mkdir -p "$PERSIST/codex" "$PERSIST/tlda-config"

# Persist codex auth + tlda daemon config on the volume so they survive redeploys.
mkdir -p /root/.config
ln -sfn "$PERSIST/codex" /root/.codex
ln -sfn "$PERSIST/tlda-config" /root/.config/tlda

# Seed the codex MCP entry once (per-agent env is injected via -c at spawn time;
# the static entry just needs command + args). Don't clobber an existing config.
if [ ! -f /root/.codex/config.toml ]; then
  cat > /root/.codex/config.toml <<EOF
[mcp_servers.tlda]
command = "node"
args = ["/app/mcp-server/index.mjs"]
EOF
fi

# Minimal daemon config. TLDA_SERVER env overrides the server URL; the daemon WS
# is unauthenticated server-side, so no token is strictly required. machine_id
# comes from TLDA_MACHINE_ID (distinct per friend so daemons don't evict each
# other on the render box).
if [ ! -f /root/.config/tlda/config.json ]; then
  cat > /root/.config/tlda/config.json <<EOF
{ "defaultConfig": "default", "configs": { "default": { "database": "${TLDA_SERVER}", "store": "${TLDA_SERVER}" } } }
EOF
fi

if [ ! -f /root/.codex/auth.json ]; then
  echo "[entrypoint] WARNING: /root/.codex/auth.json missing — run 'codex login' once"
  echo "[entrypoint]   fly ssh console -a <this-app> -C 'codex login'  (approve on chatgpt.com)"
fi

# tmux needs a sane TERM for the codex TUI to render in a pane.
export TERM="${TERM:-xterm-256color}"

echo "[entrypoint] starting fleet-daemon → ${TLDA_SERVER} (machine_id=${TLDA_MACHINE_ID})"
cd /app
exec node bin/fleet-daemon.mjs
