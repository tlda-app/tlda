#!/bin/bash
# Usage: ./scripts/open.sh <doc-name>
# Opens the viewer for a document. Starts services if needed.

set -e

DOC="${1:?Usage: open.sh <doc-name>}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"

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

open "http://localhost:5173/?doc=${DOC}"
