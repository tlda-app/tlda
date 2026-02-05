#!/bin/bash
# Build SVG pages and extract preamble from a LaTeX document
# Usage: ./scripts/build-doc.sh /path/to/document.tex [output-dir]

set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <tex-file> [output-dir]"
  exit 1
fi

TEX_FILE="$1"
TEX_DIR=$(dirname "$TEX_FILE")
TEX_NAME=$(basename "$TEX_FILE" .tex)
OUTPUT_DIR="${2:-public/docs}"

echo "Building $TEX_NAME..."

# Compile LaTeX to PDF (run twice for references)
echo "Compiling LaTeX..."
cd "$TEX_DIR"
pdflatex -interaction=nonstopmode "$TEX_NAME.tex" > /dev/null
pdflatex -interaction=nonstopmode "$TEX_NAME.tex" > /dev/null
cd - > /dev/null

PDF_FILE="$TEX_DIR/$TEX_NAME.pdf"

if [ ! -f "$PDF_FILE" ]; then
  echo "Error: PDF not generated"
  exit 1
fi

# Get page count
PAGE_COUNT=$(pdfinfo "$PDF_FILE" | grep Pages | awk '{print $2}')
echo "PDF has $PAGE_COUNT pages"

# Create output directory
mkdir -p "$OUTPUT_DIR"

# Convert each page to SVG using pdf2svg
echo "Converting pages to SVG..."
for i in $(seq 1 $PAGE_COUNT); do
  PAGE_NUM=$(printf "%02d" $i)
  echo "  Page $PAGE_NUM..."
  pdf2svg "$PDF_FILE" "$OUTPUT_DIR/page-$PAGE_NUM.svg" $i
done

# Extract preamble and convert to JSON
echo "Extracting preamble macros..."
node scripts/extract-preamble.js "$TEX_FILE" "$OUTPUT_DIR/macros.json"

echo "Done! Output in $OUTPUT_DIR"
echo "  - $PAGE_COUNT SVG pages"
echo "  - macros.json"
