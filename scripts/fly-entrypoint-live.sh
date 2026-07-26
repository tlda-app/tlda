#!/bin/sh
# fly-entrypoint-live.sh — LIVE tlda backend entrypoint.
# Wires all mutable state onto the persistent Fly volume (mounted at
# /app/server/persist) so it survives deploys:
#   - projects/  (doc sources, build output)        -> persist/projects
#   - data/      (Yjs room persistence)             -> persist/data
#   - fleet.db   (hardcoded to ~/.config/tlda/...)  -> persist/tlda-config
# Auth tokens come from env (TLDA_TOKEN_READ / TLDA_TOKEN_RW via `fly secrets`),
# NOT from a config file — see server/lib/auth.mjs.
set -e

PERSIST=/app/server/persist
mkdir -p "$PERSIST/projects" "$PERSIST/data" "$PERSIST/tlda-config"

# fleet.db is hardcoded to ~/.config/tlda/fleet.db (server/lib/fleet-store.mjs).
# On Fly the home dir is /root, so point that whole dir at the volume.
mkdir -p /root/.config
if [ -e /root/.config/tlda ] && [ ! -L /root/.config/tlda ]; then
  rm -rf /root/.config/tlda
fi
ln -sfn "$PERSIST/tlda-config" /root/.config/tlda

# Projects + Yjs data live on the volume (nothing is baked into the live image).
ln -sfn "$PERSIST/projects" /app/server/projects
ln -sfn "$PERSIST/data" /app/server/data

# Source pushes from the browser commit into per-project git clones before
# pushing upstream. Fly runs as root in a fresh image, so configure a stable
# non-human identity instead of letting git abort at commit time.
git config --global user.name "${TLDA_GIT_USER_NAME:-tlda-friend-box}"
git config --global user.email "${TLDA_GIT_USER_EMAIL:-tlda-friend-box@local}"

# Ensure the strict server authority exists. The server resolves its active
# database/store pair from server.yaml at startup and fails loudly when it is
# absent. The Fly server's authority is deterministic: it tells browsers to sync
# against this machine. Friend boxes set TLDA_FLEET_SERVER to their own fly.dev
# URL, so rewrite the persisted authority on startup for those boxes instead of
# preserving a stale volume config from another app.
# (A tldraw license key is a client-side value shipped in window.__TLDA_CONFIG__
# to every browser — not a secret — so it lives here, not in `fly secrets`.)
SERVER_YAML=/root/.config/tlda/server.yaml
DAEMON_YAML=/root/.config/tlda/daemon.yaml
CONFIG_ENDPOINT="${TLDA_FLEET_SERVER:-https://tlda-fly.cormorant-matrix.ts.net}"
ENV_NAME="${TLDA_ENV:-testing}"
if [ ! -f "$SERVER_YAML" ] || [ -n "$TLDA_FLEET_SERVER" ]; then
  echo "[entrypoint] writing hosting-only Fly server config"
  : > "$SERVER_YAML"
fi
if [ ! -f "$DAEMON_YAML" ] || [ -n "$TLDA_FLEET_SERVER" ]; then
  echo "[entrypoint] writing canonical Fly daemon environment $ENV_NAME for $CONFIG_ENDPOINT"
  cat > "$DAEMON_YAML" <<'EOF'
machineId: fly
environments:
  default: __TLDA_ENV_NAME__
  values:
    __TLDA_ENV_NAME__:
      database: __TLDA_CONFIG_ENDPOINT__
      store: __TLDA_CONFIG_ENDPOINT__
      licenseKey: tldraw-david-hirshberg-2031-06-29/WyJpTW00VFpraCIsWyIqLmNvcm1vcmFudC1tYXRyaXgudHMubmV0Il0sOSwiMjAzMS0wNi0yOSJd.76nwqwOXRChl0rxuqrgwvwOqZ+Aztw8sC+qFOFixTWyVpH96riTXLDVOY83AFmW0GRcHodjkGpjUvdh/GouzzA
taskDoc:
  globalDir: /app/server/persist/fleet-task-doc
EOF
  sed -i "s|__TLDA_ENV_NAME__|$ENV_NAME|g" "$DAEMON_YAML"
  sed -i "s|__TLDA_CONFIG_ENDPOINT__|$CONFIG_ENDPOINT|g" "$DAEMON_YAML"
fi

# --- Tailscale: join Skip's tailnet so the server is reachable privately ---
# When TS_AUTHKEY is set (via `fly secrets`), this Fly machine joins the tailnet
# as a node and serves the app over the tailnet's HTTPS (valid cert on the
# .ts.net name). Fail-soft: if Tailscale doesn't come up, the server still starts
# (the public fly.dev stays up during the cutover until the tailnet path is proven).
if [ -n "$TS_AUTHKEY" ]; then
  mkdir -p "$PERSIST/tailscale" /var/run/tailscale
  tailscaled \
    --state="$PERSIST/tailscale/tailscaled.state" \
    --socket=/var/run/tailscale/tailscaled.sock \
    --tun=userspace-networking &
  # Wait for the daemon socket before `up`.
  i=0; until tailscale --socket=/var/run/tailscale/tailscaled.sock status >/dev/null 2>&1 || [ $i -ge 30 ]; do i=$((i+1)); sleep 0.5; done
  tailscale --socket=/var/run/tailscale/tailscaled.sock up \
    --authkey="$TS_AUTHKEY" --hostname="${TS_HOSTNAME:-tlda-fly}" --accept-dns=false \
    || echo "[entrypoint] tailscale up failed — continuing (public stays up)"
  # Proxy the tailnet HTTPS to the local server (valid cert on the .ts.net name).
  tailscale --socket=/var/run/tailscale/tailscaled.sock serve --bg --https=443 http://127.0.0.1:5176 \
    || echo "[entrypoint] tailscale serve failed — continuing"
fi

# --- Run-once: merge pre-cutover chat history into fleet.db ---
# Runs here, BEFORE the server opens the DB, so the merge has exclusive access
# (zero event loss, no SQLite corruption). Guarded: only runs if the history file
# is staged on the volume and the merge hasn't already happened. The merge script
# takes a consistent backup first; on any failure we restore it and start anyway.
HIST_DB=/root/.config/tlda/local-history.db
MERGED_FLAG=/root/.config/tlda/.history-merged
if [ -f "$HIST_DB" ] && [ ! -f "$MERGED_FLAG" ]; then
  echo "[entrypoint] one-time history merge starting..."
  if node /app/scripts/merge-history.mjs /root/.config/tlda/fleet.db "$HIST_DB"; then
    touch "$MERGED_FLAG"
    echo "[entrypoint] history merge complete."
  else
    echo "[entrypoint] history merge FAILED — restoring pre-merge backup, starting without it"
    if [ -f /root/.config/tlda/fleet.db.pre-history-merge.bak ]; then
      cp /root/.config/tlda/fleet.db.pre-history-merge.bak /root/.config/tlda/fleet.db || true
    fi
    rm -f /root/.config/tlda/fleet.db-wal /root/.config/tlda/fleet.db-shm || true
  fi
fi

# --- Feelings export: periodic chat + attachments -> Skip's Google Drive ---
# Skip-authorized PII export. The rclone remote (feelings-drive, scoped to a single
# Drive folder) is provisioned as a Fly secret holding the base64 of its rclone.conf
# section, so the OAuth token never lands in any image layer or transcript. Decode it
# to rclone.conf, then run the export on an interval in the background. Fail-soft: if
# the secret is absent or a run fails, the server still starts and keeps serving.
if [ -n "$FEELINGS_RCLONE_CONF_B64" ]; then
  echo "[entrypoint] feelings-export: provisioning rclone remote + starting interval loop"
  mkdir -p /root/.config/rclone
  printf '%s' "$FEELINGS_RCLONE_CONF_B64" | base64 -d > /root/.config/rclone/rclone.conf
  (
    sleep 90   # let the server bind + settle first
    while true; do
      node /app/bin/feelings-export.mjs --db /root/.config/tlda/fleet.db \
        >> /root/.config/tlda/feelings-export.log 2>&1 || \
        echo "[feelings-export] run failed (continuing)" >> /root/.config/tlda/feelings-export.log
      sleep "${FEELINGS_INTERVAL_SECONDS:-21600}"   # default 6h
    done
  ) &
else
  echo "[entrypoint] feelings-export: FEELINGS_RCLONE_CONF_B64 not set — skipping"
fi

cd /app/server
# --import tsx lets the server import TypeScript library modules directly (no build
# artifact) — the algo-refactor splits server logic into .ts modules. tsx loads
# plain .mjs unchanged, so this is a no-op until .ts modules land. tsx is a runtime
# dependency (server/package.json) so `npm install --production` puts it in the image.
# --i-am-tlda-cli authorizes launching the server directly (the guard otherwise
# refuses and tells you to use `tlda server start`). This is how the CLI launches it.
exec node --import tsx unified-server.mjs --i-am-tlda-cli
