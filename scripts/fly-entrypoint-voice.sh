#!/bin/sh
# Entrypoint for the tlda VOICE box (fly app: tlda-voice).
#
# Joins Skip's tailnet so his browser can reach the Deepgram bridge directly,
# then runs the bridge. Tailnet membership IS the auth posture here — Skip,
# 2026-07-28: "It should be trust whoever reaches it. Right? Trust anyone on my
# tail net?" Anyone who can reach this box is already someone he has admitted,
# so there is deliberately NO per-connection token, credential, or shared secret
# on top. Do not add one.
set -eu

PERSIST=/app/persist
mkdir -p "$PERSIST/tailscale" /var/run/tailscale

# --- Tailscale: join the tailnet and terminate TLS on the .ts.net name ---
# State lives on the mounted volume, so this machine keeps ONE stable node
# identity across restarts. That matters twice over:
#
#  1. Without it, every restart registers a NEW node and Tailscale suffixes the
#     hostname (tlda-voice-1, -2, ...), silently moving his voice URL.
#  2. Because the identity persists, TS_AUTHKEY is needed ONLY for the very
#     first registration. So tailscaled always starts, and `up` only passes an
#     auth key when one is present. An already-registered node comes back on the
#     tailnet from its stored state with no key at all, which is what lets the
#     key be revoked after setup instead of living on as a standing secret.
#
# Gating this whole block on TS_AUTHKEY would mean a revoked key silently takes
# the box off the tailnet on its next restart — days later, with no obvious
# cause, exactly when Skip cannot talk. That is the failure this box exists to
# eliminate, so it must not be the thing that causes it.
tailscaled \
  --state="$PERSIST/tailscale/tailscaled.state" \
  --socket=/var/run/tailscale/tailscaled.sock \
  --tun=userspace-networking &

i=0
until tailscale --socket=/var/run/tailscale/tailscaled.sock status >/dev/null 2>&1 || [ $i -ge 30 ]; do
  i=$((i+1)); sleep 0.5
done

if [ -n "${TS_AUTHKEY:-}" ]; then
  echo "[entrypoint] registering with TS_AUTHKEY"
  AUTH_ARG="--authkey=$TS_AUTHKEY"
else
  echo "[entrypoint] no TS_AUTHKEY - coming up from stored node identity"
  AUTH_ARG=""
fi

# --timeout so an unregistered node with no key fails loudly instead of blocking
# forever on a login URL nobody is watching.
if tailscale --socket=/var/run/tailscale/tailscaled.sock up \
    $AUTH_ARG --hostname="${TS_HOSTNAME:-tlda-voice}" --accept-dns=false --timeout=45s; then
  # Valid cert on the .ts.net name; forwards to the bridge's plain ws on 8180.
  tailscale --socket=/var/run/tailscale/tailscaled.sock serve --bg --https=443 http://127.0.0.1:8180 \
    || echo "[entrypoint] ERROR: tailscale serve failed - browsers cannot reach this bridge"
else
  echo "[entrypoint] ERROR: tailscale up failed - browsers cannot reach this bridge"
fi

# The bridge starts regardless of how Tailscale went, and that is deliberate.
# It is still reachable over Fly's private network at tlda-voice.internal:8180,
# which is the app-server proxy route Skip's voice uses today. Refusing to start
# the bridge because the NEW path failed would take away the path that already
# works. These are two configured routes, not a silent fallback: the client uses
# whichever one config names.
exec node deepgram-runtime/deepgram-sdk-bridge.mjs
