#!/bin/sh
# fly-entrypoint-edge.sh — the tailnet front door.
#
# This is everything that used to be the `--- Tailscale ---` block of
# fly-entrypoint-live.sh, moved onto a machine the app deploy does not replace.
# It holds the tailnet node (and therefore the .ts.net name Skip's browser and
# the tldraw licence are bound to) and points it at fly-edge-proxy.mjs, which
# waits out an absent app machine instead of answering 502.
#
# It carries no volume of the app's, opens no database, and runs no server. The
# only state it needs is tailscaled's own node key, on its own small volume — a
# fresh node every boot would take a new hostname (tlda-fly-1, tlda-fly-2, ...)
# and Skip's URL would move.
set -e

if [ -z "$TS_AUTHKEY" ]; then
  echo "[edge] FATAL: TS_AUTHKEY is not set — without it this machine never joins the tailnet and nothing can reach the app" >&2
  exit 1
fi

STATE=/var/lib/tlda-edge
mkdir -p "$STATE/tailscale" /var/run/tailscale

tailscaled \
  --state="$STATE/tailscale/tailscaled.state" \
  --socket=/var/run/tailscale/tailscaled.sock \
  --tun=userspace-networking &

# Wait for the daemon socket before `up`.
i=0; until tailscale --socket=/var/run/tailscale/tailscaled.sock status >/dev/null 2>&1 || [ $i -ge 30 ]; do i=$((i+1)); sleep 0.5; done

tailscale --socket=/var/run/tailscale/tailscaled.sock up \
  --authkey="$TS_AUTHKEY" --hostname="${TS_HOSTNAME:-tlda-fly}" --accept-dns=false

# `serve` keeps the name tailnet-only and is the default for every deployment.
# `funnel` publishes the same name to the public internet and is opted into by
# TS_FUNNEL in one fly.*.toml. The hostname stays inside *.cormorant-matrix.ts.net
# either way — the tldraw licence is bound to that domain.
TS_EXPOSE=serve
[ -n "$TS_FUNNEL" ] && TS_EXPOSE=funnel
tailscale --socket=/var/run/tailscale/tailscaled.sock "$TS_EXPOSE" --bg --https=443 "http://127.0.0.1:${TLDA_EDGE_LISTEN_PORT}"

exec node /app/scripts/fly-edge-proxy.mjs
