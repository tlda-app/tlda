#!/bin/bash
# Test: verify panel tab switching (TOC <-> Notes)
# Extracted from MCP session — tests that panel tabs render and switch correctly
#
# Usage: bash tests/verify-panel-tabs.sh [doc] [token]
# Outputs screenshots to /tmp/playwright-test-output/

set -e
DOC=${1:-bregman}
TOKEN=${2:-c5e4726ab77972fc7312f3a703f9cf1c}
OUT=/tmp/playwright-test-output
mkdir -p "$OUT"

echo "=== Panel Tab Test (doc=$DOC) ==="

# 1. Open browser + navigate
echo "Step 1: Open browser + navigate..."
playwright-cli open > /dev/null 2>&1 || true
playwright-cli goto "http://localhost:5176/?doc=$DOC&token=$TOKEN" > /dev/null

# 2. Wait for load + initial screenshot
sleep 2
echo "Step 2: Initial screenshot..."
playwright-cli screenshot --filename "$OUT/01-initial.png" > /dev/null

# 3. Snapshot and find refs dynamically
echo "Step 3: Finding button refs..."
playwright-cli snapshot --filename "$OUT/snap.yml" > /dev/null

NOTES_REF=$(grep 'button "Notes"' "$OUT/snap.yml" | grep -o 'ref=e[0-9]*' | head -1 | cut -d= -f2)
TOC_REF=$(grep 'button "TOC"' "$OUT/snap.yml" | grep -o 'ref=e[0-9]*' | head -1 | cut -d= -f2)

if [ -z "$NOTES_REF" ] || [ -z "$TOC_REF" ]; then
  echo "FAIL: Could not find tab buttons (Notes=$NOTES_REF, TOC=$TOC_REF)"
  exit 1
fi
echo "  Notes=$NOTES_REF, TOC=$TOC_REF"

# 4. Click Notes tab + screenshot
echo "Step 4: Click Notes..."
playwright-cli click "$NOTES_REF" > /dev/null
playwright-cli screenshot --filename "$OUT/02-notes.png" > /dev/null

# 5. Click TOC tab + screenshot
echo "Step 5: Click TOC..."
playwright-cli click "$TOC_REF" > /dev/null
playwright-cli screenshot --filename "$OUT/03-toc.png" > /dev/null

# 6. Console errors
echo "Step 6: Console errors..."
playwright-cli console error > "$OUT/console-errors.txt" 2>&1 || true
ERROR_COUNT=$(wc -l < "$OUT/console-errors.txt" | tr -d ' ')

echo ""
echo "=== DONE ==="
echo "Screenshots: $OUT/01-initial.png, 02-notes.png, 03-toc.png"
echo "Console errors: $ERROR_COUNT lines (see $OUT/console-errors.txt)"
