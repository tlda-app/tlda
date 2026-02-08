#!/bin/bash
# Usage: ./scripts/open.sh <doc-name>
# Opens the viewer for a document. Starts services if needed.

set -e

DOC="${1:?Usage: open.sh <doc-name>}"

# Check if dev server is running
if ! lsof -i :5173 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Starting collab services..."
  cd "$(dirname "$0")/.."
  npm run collab &
  # Wait for dev server to be ready
  for i in $(seq 1 30); do
    if lsof -i :5173 -sTCP:LISTEN >/dev/null 2>&1; then break; fi
    sleep 1
  done
fi

open "http://localhost:5173/?doc=${DOC}"
