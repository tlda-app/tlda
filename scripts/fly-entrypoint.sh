#!/bin/sh
# Fly.io entrypoint: seed project data from image, preserve sync snapshots on volume.
#
# Volume mounts at /app/server/persist. Sync snapshots live there so student
# annotations survive deploys. Project metadata and build output are copied
# fresh from the Docker image on each deploy.

PERSIST=/app/server/persist
PROJECTS=/app/server/projects
SEED=/app/server/seed

mkdir -p "$PERSIST" "$PROJECTS"

# For each seeded project: create project dir, copy metadata + output,
# but symlink sync-snapshot.json to the persistent volume.
for proj in "$SEED"/*/; do
  name=$(basename "$proj")
  dest="$PROJECTS/$name"
  mkdir -p "$dest/output"

  # Copy project.json and output/ (fresh from image)
  cp -f "$proj/project.json" "$dest/project.json" 2>/dev/null
  cp -rf "$proj/output/." "$dest/output/" 2>/dev/null

  # Sync snapshot: use persistent volume, symlink into project dir
  snap="$PERSIST/${name}-sync-snapshot.json"
  link="$dest/sync-snapshot.json"
  rm -f "$link"  # remove stale file or symlink
  if [ ! -f "$snap" ]; then
    # First deploy or volume was reset — seed from image if available
    if [ -f "$proj/sync-snapshot.json" ]; then
      cp "$proj/sync-snapshot.json" "$snap"
    fi
  fi
  # Symlink so the server reads/writes the persistent copy
  if [ -f "$snap" ]; then
    ln -s "$snap" "$link"
  fi
done

exec node unified-server.mjs
