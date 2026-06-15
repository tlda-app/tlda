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

cd /app/server
# --i-am-tlda-cli authorizes launching the server directly (the guard otherwise
# refuses and tells you to use `tlda server start`). This is how the CLI launches it.
exec node unified-server.mjs --i-am-tlda-cli
