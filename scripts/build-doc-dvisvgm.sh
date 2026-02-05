#!/bin/bash
# Build SVG pages using dvisvgm via DVI (better synctex coordinate alignment)
# Usage: ./scripts/build-doc-dvisvgm.sh /path/to/document.tex [output-dir]

set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <tex-file> [output-dir]"
  exit 1
fi

TEX_FILE="$1"
TEX_DIR=$(dirname "$TEX_FILE")
TEX_NAME=$(basename "$TEX_FILE" .tex)
OUTPUT_DIR="${2:-public/docs}"

echo "Building $TEX_NAME with dvisvgm (via DVI)..."

# Compile LaTeX to DVI with synctex
echo "Compiling LaTeX to DVI..."
cd "$TEX_DIR"
# Use latex (not pdflatex) to get DVI output
latex -synctex=1 -interaction=nonstopmode "$TEX_NAME.tex" > /dev/null 2>&1 || true
latex -synctex=1 -interaction=nonstopmode "$TEX_NAME.tex" > /dev/null 2>&1 || true
cd - > /dev/null

DVI_FILE="$TEX_DIR/$TEX_NAME.dvi"

if [ ! -f "$DVI_FILE" ]; then
  echo "Error: DVI not generated (document may use pdflatex-only features)"
  echo "Falling back to pdf2svg..."
  exec ./scripts/build-doc.sh "$@"
fi

# Get page count from DVI
PAGE_COUNT=$(dvisvgm --page=- "$DVI_FILE" 2>&1 | grep -o 'processing page [0-9]*' | tail -1 | grep -o '[0-9]*' || echo "1")
# Alternative: just convert all and count output files
echo "Converting DVI to SVG..."

# Create output directory
mkdir -p "$OUTPUT_DIR"

# Convert DVI to SVG using dvisvgm
# Options:
#   --page: select page(s) - use ranges or individual
#   --bbox=papersize: use paper size for bounding box (matches synctex coords)
#   --no-fonts=1: convert fonts to paths (better cross-browser compat)
#   --precision=2: 2 decimal places for coordinates
echo "Converting pages to SVG with dvisvgm..."

# Convert all pages at once, using output pattern
# dvisvgm uses %p for page number, %2p for 2-digit padded
dvisvgm \
  --page=1- \
  --bbox=papersize \
  --no-fonts=1 \
  --precision=2 \
  --output="$OUTPUT_DIR/page-%2p.svg" \
  "$DVI_FILE" 2>&1 | grep -E '(processing|output written)' || true

# Count generated files
PAGE_COUNT=$(ls -1 "$OUTPUT_DIR"/page-*.svg 2>/dev/null | wc -l | tr -d ' ')
echo "Generated $PAGE_COUNT SVG pages"

# Extract preamble and convert to JSON
echo "Extracting preamble macros..."
node scripts/extract-preamble.js "$TEX_FILE" "$OUTPUT_DIR/macros.json"

# Show SVG dimensions for verification
echo ""
echo "SVG viewBox check (should be ~612x792 for US Letter):"
head -5 "$OUTPUT_DIR/page-01.svg" | grep -oE '(viewBox|width|height)="[^"]*"' | head -3 || echo "  (attributes not found in first 5 lines)"

echo ""
echo "Done! Output in $OUTPUT_DIR"
echo "  - $PAGE_COUNT SVG pages"
echo "  - macros.json"
