#!/bin/sh
# fly-entrypoint-edge.sh — the tailnet front door.
#
# This is everything that used to be the `--- Tailscale ---` block of
# fly-entrypoint-live.sh, moved onto a machine the app deploy does not replace.
# It holds the tailnet node (and therefore the .ts.net name browsers and
# the tldraw licence are bound to) and points it at fly-edge-proxy.mjs, which
# waits out an absent app machine instead of answering 502.
#
# It carries no volume of the app's, opens no database, and runs no server. The
# only state it needs is tailscaled's own node key, on its own small volume — a
# fresh node every boot would take a new hostname (tlda-fly-1, tlda-fly-2, ...)
# and the public URL would move.
set -e

STATE=/var/lib/tlda-edge
mkdir -p "$STATE/tailscale" /var/run/tailscale

if [ -n "${TLDA_EDGE_UPSTREAM_POINTER:-}" ] && [ ! -e "$TLDA_EDGE_UPSTREAM_POINTER" ]; then
  if [ -z "${TLDA_EDGE_UPSTREAM:-}" ]; then
    echo "edge: TLDA_EDGE_UPSTREAM is required to seed $TLDA_EDGE_UPSTREAM_POINTER" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$TLDA_EDGE_UPSTREAM_POINTER")"
  pending="${TLDA_EDGE_UPSTREAM_POINTER}.pending-$$"
  printf '%s\n' "$TLDA_EDGE_UPSTREAM" > "$pending"
  mv "$pending" "$TLDA_EDGE_UPSTREAM_POINTER"
fi

tailscaled \
  --state="$STATE/tailscale/tailscaled.state" \
  --socket=/var/run/tailscale/tailscaled.sock \
  --tun=userspace-networking &

# Wait for the daemon socket before `up`.
i=0; until tailscale --socket=/var/run/tailscale/tailscaled.sock status >/dev/null 2>&1 || [ $i -ge 30 ]; do i=$((i+1)); sleep 0.5; done

# The mounted state is the durable node identity. TS_AUTHKEY is needed only for
# first registration; a revoked setup key must not take an already-authorized
# node back off the tailnet on its next boot. This entrypoint used to exit 1
# when TS_AUTHKEY was unset, which on THIS machine is the worse failure of the
# two: the app machine no longer carries a tailnet node, so an edge that
# refuses to start is the whole app unreachable. Learned in
# fly-entrypoint-live.sh before the node moved here.
if [ -n "${TS_AUTHKEY:-}" ]; then
  echo "[edge] registering with TS_AUTHKEY"
  AUTH_ARG="--authkey=$TS_AUTHKEY"
else
  echo "[edge] no TS_AUTHKEY - coming up from stored node identity"
  AUTH_ARG=""
fi

# `serve` keeps the name tailnet-only and is the default for every deployment.
# `funnel` publishes the same name to the public internet and is opted into by
# TS_FUNNEL in one fly.*.toml. The hostname stays inside the configured tailnet
# either way — the tldraw licence is bound to that domain.
if tailscale --socket=/var/run/tailscale/tailscaled.sock up \
    $AUTH_ARG --hostname="${TS_HOSTNAME:-tlda-fly}" --accept-dns=false --timeout=45s; then
  TS_EXPOSE=serve
  [ -n "$TS_FUNNEL" ] && TS_EXPOSE=funnel
  tailscale --socket=/var/run/tailscale/tailscaled.sock "$TS_EXPOSE" --bg --https=443 "http://127.0.0.1:${TLDA_EDGE_LISTEN_PORT}" \
    || echo "[edge] ERROR: tailscale $TS_EXPOSE failed - browsers cannot reach this server"
else
  echo "[edge] ERROR: tailscale up failed - browsers cannot reach this server"
fi

# The proxy starts either way. A tailnet that is down is a reason to keep the
# thing that answers running, not a reason to exit: `fly ssh` and the health
# port below are how you find out which half is broken.

exec node /app/scripts/fly-edge-proxy.mjs
