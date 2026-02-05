#!/bin/bash
# Build LaTeX to SVG pages for tldraw viewer
#
# Usage: ./build-svg.sh /path/to/document.tex doc-name "Document Title"
#
# - Runs latexmk -dvi for proper reference resolution
# - Converts DVI to SVG with dvisvgm
# - Extracts preamble macros for KaTeX
# - Updates manifest.json

set -e

TEX_FILE="$1"
DOC_NAME="${2:-$(basename "$TEX_FILE" .tex)}"
DOC_TITLE="${3:-$DOC_NAME}"

if [ -z "$TEX_FILE" ]; then
  echo "Usage: $0 <tex-file> [doc-name] [\"Document Title\"]"
  echo ""
  echo "Examples:"
  echo "  $0 ~/papers/my-paper.tex"
  echo "  $0 ~/papers/my-paper.tex my-paper \"My Paper Title\""
  exit 1
fi

if [ ! -f "$TEX_FILE" ]; then
  echo "Error: $TEX_FILE not found"
  exit 1
fi

TEX_DIR="$(cd "$(dirname "$TEX_FILE")" && pwd)"
TEX_BASE="$(basename "$TEX_FILE" .tex)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="$SCRIPT_DIR/public/docs/$DOC_NAME"
MANIFEST="$SCRIPT_DIR/public/docs/manifest.json"

echo "Building $TEX_FILE → $OUTPUT_DIR"
echo "  Doc name: $DOC_NAME"
echo "  Title: $DOC_TITLE"

# Create output directory
mkdir -p "$OUTPUT_DIR"

# Build DVI with latexmk (handles biber, multiple passes, etc.)
echo ""
echo "Running latexmk..."
cd "$TEX_DIR"
latexmk -dvi -interaction=nonstopmode "$TEX_BASE.tex"

DVI_FILE="$TEX_DIR/$TEX_BASE.dvi"
if [ ! -f "$DVI_FILE" ]; then
  echo "Error: DVI file not created"
  exit 1
fi

# Convert to SVG
echo ""
echo "Converting DVI to SVG..."
dvisvgm --page=1- --font-format=woff2 --exact-bbox \
  --output="$OUTPUT_DIR/page-%02p.svg" \
  "$DVI_FILE"

# Count pages
PAGE_COUNT=$(ls -1 "$OUTPUT_DIR"/page-*.svg 2>/dev/null | wc -l | tr -d ' ')
echo "Generated $PAGE_COUNT pages"

# Extract preamble macros
echo ""
echo "Extracting preamble macros..."
cd "$SCRIPT_DIR"
node scripts/extract-preamble.js "$TEX_FILE" "$OUTPUT_DIR/macros.json"

# Update manifest
echo ""
echo "Updating manifest..."
if [ ! -f "$MANIFEST" ]; then
  echo '{"documents":{}}' > "$MANIFEST"
fi

# Use node to update JSON properly
node -e "
const fs = require('fs');
const manifest = JSON.parse(fs.readFileSync('$MANIFEST', 'utf8'));
manifest.documents['$DOC_NAME'] = {
  name: '$DOC_TITLE',
  pages: $PAGE_COUNT,
  basePath: '/docs/$DOC_NAME/'
};
fs.writeFileSync('$MANIFEST', JSON.stringify(manifest, null, 2));
console.log('Manifest updated');
"

echo ""
echo "Done! Access at: ?doc=$DOC_NAME"
echo ""
echo "Available documents:"
node -e "
const fs = require('fs');
const m = JSON.parse(fs.readFileSync('$MANIFEST', 'utf8'));
Object.entries(m.documents).forEach(([k,v]) => console.log('  ' + k + ': ' + v.name + ' (' + v.pages + ' pages)'));
"
