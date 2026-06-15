#!/usr/bin/env bash
# Collab-box test — verify the daemon-side source binding (`tlda doc link`) works
# from a SEPARATE "machine" (a container with its own machine_id) against the host
# tlda server.
#
# PROVES: the collaborator's daemon watches/pushes ITS OWN local clone for a
# shared project name, driven by its local binding — NOT the server's sourceDir
# (which is the host's path, absent in the container). A file edited in the
# container's clone should trigger a build of the host's project.
#
# Prereqs: colima running (docker socket up). Run from anywhere:
#   bash test/collab-box/run.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOST_CLI="node $REPO_ROOT/cli/tlda.mjs"
SERVER="${COLLAB_TEST_SERVER:-https://host.docker.internal:5176}"   # container → Mac host
PROJECT="linktest-$(date +%s)"                                       # throwaway, unique
TOKEN="$(node -e "const c=require(require('os').homedir()+'/.config/tlda/config.json'); process.stdout.write(c.tokenRw||c.token||'')")"

# Under $HOME so colima's default mount exposes COLLAB to the container (-v).
TMP="$(mktemp -d "$HOME/.tlda-collab-test.XXXXXX")"; HOSTSRC="$TMP/host-src"; COLLAB="$TMP/collab-clone"

cleanup() {
  echo "== cleanup =="
  docker rm -f tlda-collab-run 2>/dev/null || true
  $HOST_CLI doc delete "$PROJECT" 2>/dev/null || true
  rm -rf "$TMP" 2>/dev/null || true
}
trap cleanup EXIT

echo "== 1. host: create a throwaway git-backed project =="
mkdir -p "$HOSTSRC" && ( cd "$HOSTSRC" && git init -q \
  && printf '\\documentclass{article}\n\\begin{document}hello\n\\end{document}\n' > main.tex \
  && git add -A && git -c user.email=t@t -c user.name=t commit -qm init )
$HOST_CLI doc create "$PROJECT" --dir "$HOSTSRC"

echo "== 2. collaborator: clone the source (= getting the code, shares git history) =="
git clone -q "$HOSTSRC" "$COLLAB"

echo "== 3. build the collab-box image =="
( cd "$REPO_ROOT" && docker build -f test/collab-box/Dockerfile -t tlda-collab . )

echo "== 4. run the collab daemon in the container, bound to ITS OWN clone =="
# VALIDATE on first run: host.docker.internal reachability; the localhost-only TLS
# cert means we bypass verification in the container (NODE_TLS_REJECT_UNAUTHORIZED).
# TLDA_DAEMON_CONFIG_DIR makes the daemon honor TLDA_SERVER/TLDA_TOKEN from env
# (and it equals the CLI's config dir, so `doc link` and the daemon share the
# source-bindings file). Run the fleet-daemon in the FOREGROUND so the container
# stays up.
docker run --rm -d --name tlda-collab-run \
  -v "$COLLAB":/work \
  -e TLDA_SERVER="$SERVER" \
  -e TLDA_TOKEN="$TOKEN" \
  -e TLDA_DAEMON_CONFIG_DIR=/root/.config/tlda \
  -e NODE_TLS_REJECT_UNAUTHORIZED=0 \
  tlda-collab \
  -lc "tlda doc link $PROJECT --dir /work && node /opt/tlda/bin/fleet-daemon.mjs"
sleep 8
echo "--- container daemon log (look for: watching source $PROJECT: /work (local binding)) ---"
docker logs tlda-collab-run 2>&1 | grep -iE "watching source|local binding|push|error|$PROJECT" | tail -20

echo "== 5. edit in the COLLABORATOR clone → expect it to reach the HOST's stored source =="
# Verify by SOURCE content, not build: SVG builds are demand-driven (need a viewer),
# so the build won't fire here — but the daemon's PUSH updates the server's stored
# source regardless. That's the real proof the container's /work binding drove it.
HOST_PROJECTS="$HOME/work/tlda/server/projects"
echo "% collab-box edit $(date +%s)" >> "$COLLAB/main.tex"
sleep 12
SRC="$HOST_PROJECTS/$PROJECT/source/main.tex"
echo "--- host stored source ($SRC) ---"
tail -4 "$SRC" 2>&1 | sed 's/^/  /'
echo
if grep -q "collab-box edit" "$SRC" 2>/dev/null; then
  echo "PASS — the container's edit reached the host's stored source via the daemon's"
  echo "own /work binding (the server's sourceDir path doesn't exist in the container)."
else
  echo "NOT YET — edit not in host source. Check the daemon log above: did it watch"
  echo "/work for $PROJECT, and was $PROJECT in its welcome project list?"
fi
