#!/bin/bash
# Usage: ./scripts/open.sh <tex-file | project-dir | doc-name>
#
# Accepts:
#   /path/to/paper.tex       — tex file (doc name = filename stem)
#   /path/to/project/        — folder (finds main .tex file)
#   my-doc                   — doc name already in manifest
#
# Handles everything: builds SVGs if needed, starts services + watcher,
# builds diff, opens browser.

set -e

ARG="${1:?Usage: open.sh <tex-file | project-dir | doc-name>}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$DIR/public/docs/manifest.json"

# --- Resolve ARG into TEX_FILE and DOC ---

TEX_FILE=""
DOC=""

if [ -f "$ARG" ] && [[ "$ARG" == *.tex ]]; then
  # Given a .tex file directly
  TEX_FILE="$(cd "$(dirname "$ARG")" && pwd)/$(basename "$ARG")"
  DOC="$(basename "$ARG" .tex)"

elif [ -d "$ARG" ]; then
  # Given a project directory — find main .tex file
  # Prefer a .tex file matching the directory name
  DIRNAME="$(basename "$(cd "$ARG" && pwd)")"
  if [ -f "$ARG/$DIRNAME.tex" ]; then
    MAIN_TEX="$ARG/$DIRNAME.tex"
  else
    MAIN_TEX=$(grep -rl '\\documentclass' "$ARG"/*.tex 2>/dev/null | head -1)
  fi
  if [ -z "$MAIN_TEX" ]; then
    echo "Error: no .tex file with \\documentclass found in $ARG"
    exit 1
  fi
  TEX_FILE="$(cd "$(dirname "$MAIN_TEX")" && pwd)/$(basename "$MAIN_TEX")"
  DOC="$(basename "$MAIN_TEX" .tex)"

else
  # Assume it's a doc name — look up in manifest
  DOC="$ARG"
  if [ -f "$MANIFEST" ]; then
    TEX_FILE=$(node -e "
      const m = require('$MANIFEST');
      const doc = m.documents['$DOC'];
      if (doc && doc.texFile) console.log(doc.texFile);
    " 2>/dev/null)
  fi
fi

echo "Doc: $DOC"
[ -n "$TEX_FILE" ] && echo "TeX: $TEX_FILE"

# --- Build SVGs if doc not in manifest ---

IN_MANIFEST=""
if [ -f "$MANIFEST" ]; then
  IN_MANIFEST=$(node -e "
    const m = require('$MANIFEST');
    if (m.documents['$DOC']) console.log('yes');
  " 2>/dev/null)
fi

if [ -z "$IN_MANIFEST" ] && [ -n "$TEX_FILE" ]; then
  echo "Building SVGs (first time)..."
  "$DIR/build-svg.sh" "$TEX_FILE" "$DOC"
fi

# --- Start services if not running ---

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

# --- Build diff if needed ---

if [ -n "$TEX_FILE" ] && [ -f "$MANIFEST" ]; then
  HAS_DIFF=$(node -e "
    const m = require('$MANIFEST');
    if (m.documents['${DOC}-diff']) console.log('yes');
  " 2>/dev/null)
  if [ -z "$HAS_DIFF" ]; then
    echo "Building diff (first time)..."
    "$DIR/build-diff.sh" "$TEX_FILE" "$DOC" HEAD &
    DIFF_PID=$!
  fi
fi

# --- Open browser ---

open "http://localhost:5173/?doc=${DOC}"

# --- Wait for background builds ---

if [ -n "${DIFF_PID:-}" ]; then
  echo "Diff building in background (pid $DIFF_PID)..."
  wait "$DIFF_PID" 2>/dev/null && echo "Diff ready — reload the page to see it." || echo "Diff build failed."
fi
