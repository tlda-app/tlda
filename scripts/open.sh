#!/bin/bash
# Usage: ./scripts/open.sh <doc-name>
# Opens the viewer for a document. Starts services if needed.
# Builds diff automatically if the doc has a texFile but no diff entry.

set -e

DOC="${1:?Usage: open.sh <doc-name>}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$DIR/public/docs/manifest.json"

# Resolve texFile from manifest (used for --watch and diff)
TEX_FILE=""
if [ -f "$MANIFEST" ]; then
  TEX_FILE=$(node -e "
    const m = require('$MANIFEST');
    const doc = m.documents['$DOC'];
    if (doc && doc.texFile) console.log(doc.texFile);
  " 2>/dev/null)
fi

# Check if dev server is running
if ! lsof -i :5173 -sTCP:LISTEN >/dev/null 2>&1; then
  COLLAB_ARGS=""
  if [ -n "$TEX_FILE" ]; then
    COLLAB_ARGS="-- --watch $TEX_FILE $DOC"
    echo "Starting collab services with watcher..."
  else
    echo "Starting collab services..."
  fi
  nohup npm run --prefix "$DIR" collab $COLLAB_ARGS </dev/null >>"$DIR/collab.log" 2>&1 &
  disown
  # Wait for dev server to be ready (up to 30s)
  for i in $(seq 1 30); do
    if lsof -i :5173 -sTCP:LISTEN >/dev/null 2>&1; then
      echo "Services ready."
      break
    fi
    sleep 1
  done
fi

# Build diff if needed (source doc has texFile but no -diff entry)
if [ -n "$TEX_FILE" ] && [ -f "$MANIFEST" ]; then
  HAS_DIFF=$(node -e "
    const m = require('$MANIFEST');
    if (m.documents['${DOC}-diff']) console.log('yes');
  " 2>/dev/null)
  if [ -z "$HAS_DIFF" ]; then
    echo "Building diff (first time)..."
    "$DIR/build-diff.sh" "$TEX_FILE" "$DOC" HEAD~1 &
    DIFF_PID=$!
  fi
fi

open "http://localhost:5173/?doc=${DOC}"

# If diff is building, wait for it and signal reload
if [ -n "${DIFF_PID:-}" ]; then
  echo "Diff building in background (pid $DIFF_PID)..."
  wait "$DIFF_PID" 2>/dev/null && echo "Diff ready — reload the page to see it." || echo "Diff build failed."
fi
