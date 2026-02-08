#!/bin/bash
# Usage: ./scripts/open.sh <doc-name>
# Opens the viewer for a document. Starts services if needed.
# Builds diff automatically if the doc has a texFile but no diff entry.

set -e

DOC="${1:?Usage: open.sh <doc-name>}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$DIR/public/docs/manifest.json"

# Check if dev server is running
if ! lsof -i :5173 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Starting collab services..."
  nohup npm run --prefix "$DIR" collab </dev/null >>"$DIR/collab.log" 2>&1 &
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
if [ -f "$MANIFEST" ]; then
  DIFF_NEEDED=$(node -e "
    const m = require('$MANIFEST');
    const doc = m.documents['$DOC'];
    const diff = m.documents['${DOC}-diff'];
    if (doc && doc.texFile && !diff) {
      console.log(doc.texFile);
    }
  " 2>/dev/null)
  if [ -n "$DIFF_NEEDED" ]; then
    echo "Building diff (first time)..."
    "$DIR/build-diff.sh" "$DIFF_NEEDED" "$DOC" HEAD~1 &
    DIFF_PID=$!
  fi
fi

open "http://localhost:5173/?doc=${DOC}"

# If diff is building, wait for it and signal reload
if [ -n "${DIFF_PID:-}" ]; then
  echo "Diff building in background (pid $DIFF_PID)..."
  wait "$DIFF_PID" 2>/dev/null && echo "Diff ready — reload the page to see it." || echo "Diff build failed."
fi
