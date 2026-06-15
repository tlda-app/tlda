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
ln -sfn "$PERSIST/tlda-config" /root/.config/tlda

# Projects + Yjs data live on the volume (nothing is baked into the live image).
ln -sfn "$PERSIST/projects" /app/server/projects
ln -sfn "$PERSIST/data" /app/server/data

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

cd /app/server
# --i-am-tlda-cli authorizes launching the server directly (the guard otherwise
# refuses and tells you to use `tlda server start`). This is how the CLI launches it.
exec node unified-server.mjs --i-am-tlda-cli
