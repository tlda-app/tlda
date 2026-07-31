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

# Install this deployment's committed configuration.
#
# TLDA_DEPLOYMENT names a directory under config/deployments/, baked into the
# image, holding this deployment's server.yaml and daemon.yaml. Both are copied
# over whatever is on the volume, every boot, so the image is the authority and
# what is running is what is in git.
#
# These files used to be ASSEMBLED HERE from environment variables, with shell
# defaults filling in whatever was unset — `${TLDA_FLEET_SERVER:-https://...}`
# and `${TLDA_ENV:-testing}`. That is the bug this replaces: an absent value did
# not fail, it silently became someone else's default. The same shape one layer
# up is how a live box ran an evening with no Deepgram bridge configured.
#
# A missing or misspelled TLDA_DEPLOYMENT stops the boot here, naming what it
# looked for, instead of starting a server configured as something else.
if [ -z "$TLDA_DEPLOYMENT" ]; then
  echo "[entrypoint] FATAL: TLDA_DEPLOYMENT is not set — it names the directory under config/deployments/ holding this deployment's server.yaml and daemon.yaml" >&2
  exit 1
fi
DEPLOYMENT_DIR="/app/config/deployments/$TLDA_DEPLOYMENT"
if [ ! -d "$DEPLOYMENT_DIR" ]; then
  echo "[entrypoint] FATAL: no deployment config at $DEPLOYMENT_DIR (TLDA_DEPLOYMENT=$TLDA_DEPLOYMENT). Available:" >&2
  ls /app/config/deployments >&2 || true
  exit 1
fi
for f in server.yaml daemon.yaml; do
  if [ ! -f "$DEPLOYMENT_DIR/$f" ]; then
    echo "[entrypoint] FATAL: $DEPLOYMENT_DIR/$f is missing" >&2
    exit 1
  fi
done
echo "[entrypoint] installing committed config for deployment '$TLDA_DEPLOYMENT'"
cp "$DEPLOYMENT_DIR/server.yaml" /root/.config/tlda/server.yaml
cp "$DEPLOYMENT_DIR/daemon.yaml" /root/.config/tlda/daemon.yaml

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
