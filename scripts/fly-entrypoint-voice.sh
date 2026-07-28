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
# The state lives on the mounted volume so this machine keeps ONE stable node
# identity across restarts. Without that, every restart registers a new node and
# Tailscale suffixes the hostname (tlda-voice-1, -2, ...), which would silently
# move the URL out from under the browser.
if [ -n "${TS_AUTHKEY:-}" ]; then
  tailscaled \
    --state="$PERSIST/tailscale/tailscaled.state" \
    --socket=/var/run/tailscale/tailscaled.sock \
    --tun=userspace-networking &

  i=0
  until tailscale --socket=/var/run/tailscale/tailscaled.sock status >/dev/null 2>&1 || [ $i -ge 30 ]; do
    i=$((i+1)); sleep 0.5
  done

  if tailscale --socket=/var/run/tailscale/tailscaled.sock up \
      --authkey="$TS_AUTHKEY" --hostname="${TS_HOSTNAME:-tlda-voice}" --accept-dns=false; then
    # Valid cert on the .ts.net name; forwards to the bridge's plain ws on 8180.
    tailscale --socket=/var/run/tailscale/tailscaled.sock serve --bg --https=443 http://127.0.0.1:8180 \
      || echo "[entrypoint] ERROR: tailscale serve failed - browsers cannot reach this bridge"
  else
    echo "[entrypoint] ERROR: tailscale up failed - browsers cannot reach this bridge"
  fi
else
  echo "[entrypoint] ERROR: TS_AUTHKEY unset - this box is not on the tailnet, so no browser can reach it directly"
fi

# The bridge starts regardless of how Tailscale went, and that is deliberate.
# It is still reachable over Fly's private network at tlda-voice.internal:8180,
# which is the app-server proxy route Skip's voice uses today. Refusing to start
# the bridge because the NEW path failed would take away the path that already
# works. These are two configured routes, not a silent fallback: the client uses
# whichever one config names.
exec node deepgram-runtime/deepgram-sdk-bridge.mjs
