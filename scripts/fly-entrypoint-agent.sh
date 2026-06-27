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
WORK_ROOT=/root/work
PROJECT_DIR=
if [ -n "${TLDA_FRIEND_PROJECT}" ]; then
  PROJECT_NAME=$(printf '%s' "${TLDA_FRIEND_PROJECT}" | tr -cs 'A-Za-z0-9._-' '-' | sed 's/^-//; s/-$//')
  PROJECT_DIR="$WORK_ROOT/${PROJECT_NAME:-project}"
fi
mkdir -p "$PERSIST/codex" "$PERSIST/tlda-config" "$PERSIST/claude" "$WORK_ROOT"
if [ -n "$PROJECT_DIR" ]; then
  mkdir -p "$PROJECT_DIR"
fi

# Persist codex auth + tlda daemon config on the volume so they survive redeploys.
mkdir -p /root/.config
ln -sfn "$PERSIST/codex" /root/.codex
ln -sfn "$PERSIST/tlda-config" /root/.config/tlda
# The fleet MCP's identity ledger opens ~/.claude/fleet-identity.sqlite (and a
# fleet-roster/ dir) and assumes ~/.claude exists — true on a Claude Code machine,
# but this box has no Claude Code. Point it at the volume so the dir exists AND the
# ledger persists across redeploys (codex rollout identity continuity).
ln -sfn "$PERSIST/claude" /root/.claude

# Optional operator-shipped agent config. `tlda-fly friend up --ship-config`
# packages the standard local config dirs into /app/tlda-fly/agent-config.tgz.
# This is user-supplied deployment input staged during image build, not content
# vendored into the tlda repo.
if [ -f /app/tlda-fly/agent-config.tgz ]; then
  mkdir -p "$PERSIST/shipped-config"
  tar -xzf /app/tlda-fly/agent-config.tgz -C "$PERSIST/shipped-config"
  if [ -d "$PERSIST/shipped-config/codex/skills" ]; then
    rm -rf /root/.codex/skills
    ln -s "$PERSIST/shipped-config/codex/skills" /root/.codex/skills
  fi
  if [ -f "$PERSIST/shipped-config/codex/AGENTS.md" ]; then
    rm -f /root/.codex/AGENTS.md
    ln -s "$PERSIST/shipped-config/codex/AGENTS.md" /root/.codex/AGENTS.md
  fi
  if [ -d "$PERSIST/shipped-config/claude/skills" ]; then
    rm -rf /root/.claude/skills
    ln -s "$PERSIST/shipped-config/claude/skills" /root/.claude/skills
  fi
  if [ -f "$PERSIST/shipped-config/claude/CLAUDE.md" ]; then
    rm -f /root/.claude/CLAUDE.md
    ln -s "$PERSIST/shipped-config/claude/CLAUDE.md" /root/.claude/CLAUDE.md
  fi
  if [ -d "$PERSIST/shipped-config/agents/skills" ]; then
    mkdir -p /root/.agents
    rm -rf /root/.agents/skills
    ln -s "$PERSIST/shipped-config/agents/skills" /root/.agents/skills
  fi
fi

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
  # shared/config.mjs requires every config to be COMPLETE: database, store, AND
  # licenseKey (no field optional). The agent box doesn't serve the tldraw SPA, so
  # licenseKey is unused here — but the field must be present (empty string ok) or
  # `tlda agent spawn` throws "field licenseKey must be a string (got undefined)".
  cat > /root/.config/tlda/config.json <<EOF
{ "defaultConfig": "default", "configs": { "default": { "database": "${TLDA_SERVER}", "store": "${TLDA_SERVER}", "licenseKey": "" } } }
EOF
fi

# Keep the daemon's route identity stable across redeploys. The daemon persists
# a derived host id when machineId is absent; a reused volume may already contain
# that derived id from an older boot, so force the per-friend id every time.
if [ -n "${TLDA_MACHINE_ID}" ]; then
  node -e 'const fs=require("fs"); const f=process.argv[1]; const id=process.argv[2]; const cfg=JSON.parse(fs.readFileSync(f,"utf8")); if (cfg.machineId !== id) { cfg.machineId = id; fs.writeFileSync(f, JSON.stringify(cfg, null, 2)); }' \
    /root/.config/tlda/config.json "${TLDA_MACHINE_ID}"
fi

# Codex auth. Precedence: an existing auth.json on the volume wins (it may hold a
# token codex auto-refreshed, newer than the secret). Otherwise seed it from the
# CODEX_AUTH_JSON Fly secret so a fresh box needs NO interactive device-auth — set
# the secret once (`fly secrets set CODEX_AUTH_JSON="$(cat ~/.codex/auth.json)"`)
# and every instance self-auths on boot. Falls back to a device-auth hint.
if [ ! -f /root/.codex/auth.json ]; then
  if [ -n "${CODEX_AUTH_JSON}" ]; then
    printf '%s' "${CODEX_AUTH_JSON}" > /root/.codex/auth.json
    chmod 600 /root/.codex/auth.json
    echo "[entrypoint] seeded /root/.codex/auth.json from CODEX_AUTH_JSON secret"
  else
    echo "[entrypoint] WARNING: no codex auth — set CODEX_AUTH_JSON secret, or run device-auth once:"
    echo "[entrypoint]   fly ssh console -a <this-app> -C 'codex login --device-auth'  (approve on chatgpt.com)"
  fi
fi

# tmux needs a sane TERM for the codex TUI to render in a pane.
export TERM="${TERM:-xterm-256color}"

# Friend-box Codex agents primarily need fleet chat/task tools. The full tlda MCP
# document tool catalog is large enough that Codex may not expose chat in the
# initial tool surface, making spawned agents unable to answer messages. Keep the
# agent-box MCP surface fleet-only so register/my_task/chat are always present.
export TLDA_MCP_FLEET_ONLY="${TLDA_MCP_FLEET_ONLY:-1}"

echo "[entrypoint] starting fleet-daemon → ${TLDA_SERVER} (machine_id=${TLDA_MACHINE_ID})"
if [ -n "$PROJECT_DIR" ]; then
  cd "$PROJECT_DIR"
else
  cd /app
fi
exec node /app/bin/fleet-daemon.mjs
