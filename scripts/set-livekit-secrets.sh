#!/usr/bin/env bash
# Set LiveKit secrets on a Fly app from ~/.livekit
#
# ~/.livekit is an env file with:
#   LIVEKIT_URL=wss://<project>.livekit.cloud
#   LIVEKIT_API_KEY=...
#   LIVEKIT_API_SECRET=...
#
# Usage:
#   scripts/set-livekit-secrets.sh <fly-app>
#   scripts/set-livekit-secrets.sh tldraw-sync-skip           # live
#   scripts/set-livekit-secrets.sh tldraw-sync-skip-stable    # stable/test
#
# Note: setting secrets restarts the app (brief cold-start). Values are read
# from ~/.livekit and passed straight to `fly secrets set` — never echoed.
set -euo pipefail

APP="${1:-}"
if [ -z "$APP" ]; then
  echo "usage: $0 <fly-app>  (e.g. tldraw-sync-skip or tldraw-sync-skip-stable)" >&2
  exit 2
fi

LIVEKIT_ENV="${LIVEKIT_ENV:-$HOME/.livekit}"
if [ ! -f "$LIVEKIT_ENV" ]; then
  echo "missing $LIVEKIT_ENV (expected an env file with LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET)" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$LIVEKIT_ENV"
set +a

if [ -z "${LIVEKIT_URL:-}" ] || [ -z "${LIVEKIT_API_KEY:-}" ] || [ -z "${LIVEKIT_API_SECRET:-}" ]; then
  echo "$LIVEKIT_ENV is missing one of LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET" >&2
  exit 1
fi

echo "Setting LiveKit secrets on app '$APP' (url: ${LIVEKIT_URL})..."
fly secrets set \
  LIVEKIT_URL="$LIVEKIT_URL" \
  LIVEKIT_API_KEY="$LIVEKIT_API_KEY" \
  LIVEKIT_API_SECRET="$LIVEKIT_API_SECRET" \
  --app "$APP"

echo "Done. Verify with: curl -s https://<app-host>/api/livekit/config  (expect {\"configured\":true,...})"
