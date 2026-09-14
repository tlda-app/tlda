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
node /app/scripts/install-private-environment-url.mjs /root/.config/tlda/daemon.yaml /root/.config/tlda/server.yaml

# Static files this deployment serves in place of the ones in dist/ — the icon
# set and the web manifest, so the class sites carry their own mark rather than
# tlda's. The built dist/ is one artifact shared by every deployment, and the
# names it serves (tlda-mark.svg, apple-touch-icon.png, tlda-icon-{192,512}.png,
# manifest.webmanifest) are written into index.html at build time, so an
# override replaces the file rather than adding a name.
#
# A deployment with no dist-overrides/ directory is left exactly as built.
if [ -d "$DEPLOYMENT_DIR/dist-overrides" ]; then
  echo "[entrypoint] applying dist overrides for deployment '$TLDA_DEPLOYMENT': $(ls "$DEPLOYMENT_DIR/dist-overrides" | tr '\n' ' ')"
  cp -R "$DEPLOYMENT_DIR/dist-overrides/." /app/dist/
fi

# Live and PIC have separate edge processes holding their tailnet identities.
# The other deployments still use this single-process entrypoint, so they keep
# their tailnet node beside the app until they are explicitly given an edge.
if [ "$TLDA_DEPLOYMENT" != "live" ] && [ "$TLDA_DEPLOYMENT" != "pic" ]; then
  mkdir -p "$PERSIST/tailscale" /var/run/tailscale
  tailscaled \
    --state="$PERSIST/tailscale/tailscaled.state" \
    --socket=/var/run/tailscale/tailscaled.sock \
    --tun=userspace-networking &

  i=0
  until tailscale --socket=/var/run/tailscale/tailscaled.sock status >/dev/null 2>&1 || [ $i -ge 30 ]; do
    i=$((i+1))
    sleep 0.5
  done

  if [ -n "${TS_AUTHKEY:-}" ]; then
    echo "[entrypoint] registering with TS_AUTHKEY"
    AUTH_ARG="--authkey=$TS_AUTHKEY"
  else
    echo "[entrypoint] no TS_AUTHKEY - coming up from stored node identity"
    AUTH_ARG=""
  fi

  if tailscale --socket=/var/run/tailscale/tailscaled.sock up \
      $AUTH_ARG --hostname="${TS_HOSTNAME:-tlda-fly}" --accept-dns=false --timeout=45s; then
    TS_EXPOSE=serve
    [ -n "${TS_FUNNEL:-}" ] && TS_EXPOSE=funnel
    tailscale --socket=/var/run/tailscale/tailscaled.sock "$TS_EXPOSE" --bg --https=443 "http://127.0.0.1:${PORT:-5176}" \
      || echo "[entrypoint] ERROR: tailscale $TS_EXPOSE failed - browsers cannot reach this server"
  else
    echo "[entrypoint] ERROR: tailscale up failed - browsers cannot reach this server"
  fi
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

# Build executor, only where a deployment has opted in.
#
# OPT-IN BY INTENT, NOT BY IDENTITY. The condition is TLDA_BUILD_EXECUTOR_ENABLE
# rather than `TLDA_DEPLOYMENT = pic-dev`, so a box renders for others because
# someone said it should and not because of what it is called. Every image ships
# this block; only a deployment that sets the variable runs it.
#
# SUPERVISED, BECAUSE THE ALTERNATIVE FAILS SILENTLY. The server is this
# container's PID 1 and its health is what the machine reports. An unsupervised
# executor that dies would leave the box healthy while every build sent to it
# fails -- promptly rather than hanging (the transport surfaces ECONNREFUSED in
# ~60ms, measured), but with nothing on this side saying why. The loop restarts
# it and names each exit, so "builds started failing at 04:12" has an entry to
# match rather than a silence.
#
# It is NOT a process supervisor and should not grow into one. A dedicated build
# machine wants its own process group and its own health check; this is the
# transitional form for a box that serves and renders at once.
if [ -n "${TLDA_BUILD_EXECUTOR_ENABLE:-}" ]; then
  # Bind the Fly private (6PN) address, resolved here rather than written down.
  #
  # Not the tailnet: tailscale runs `--tun=userspace-networking` on these
  # machines, so it creates no interface and another Fly app cannot route to a
  # 100.x address at all -- measured, testing could not ping pic-dev's tailnet
  # IP or resolve its MagicDNS name. 6PN is how these apps already reach each
  # other; `deepgramBridgeUrl: ws://tlda-voice.internal:8180` is the same move.
  #
  # And not a hostname: `tlda-pic-dev` does not resolve ON tlda-pic-dev, whose
  # hostname is its machine id. Binding to it fails at listen(), which under the
  # supervisor below is an unbounded restart of a process that cannot come up.
  export TLDA_BUILD_EXECUTOR_HOST="${TLDA_BUILD_EXECUTOR_HOST:-${FLY_PRIVATE_IP:-}}"
  echo "[entrypoint] build executor enabled; starting supervised on [${TLDA_BUILD_EXECUTOR_HOST:-every interface}]:${TLDA_BUILD_EXECUTOR_PORT:-7711}"
  (
    while true; do
      node /app/bin/build-executor.mjs
      status=$?
      echo "[entrypoint] build-executor exited with status ${status}; restarting in 2s"
      sleep 2
    done
  ) &
fi

cd /app/server
# --import tsx lets the server import TypeScript library modules directly (no build
# artifact) — the algo-refactor splits server logic into .ts modules. tsx loads
# plain .mjs unchanged, so this is a no-op until .ts modules land. tsx is a runtime
# dependency (server/package.json) so `npm install --production` puts it in the image.
# --i-am-tlda-cli authorizes launching the server directly (the guard otherwise
# refuses and tells you to use `tlda server start`). This is how the CLI launches it.
exec node --import tsx unified-server.mjs --i-am-tlda-cli
