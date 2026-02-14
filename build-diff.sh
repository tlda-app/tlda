#!/bin/bash
# Build a diff visualization between current and old version of a LaTeX paper
#
# Usage: ./build-diff.sh /path/to/paper.tex doc-name [git-ref]
#
# - Compiles the old version to DVI → SVG
# - Copies current version's SVGs from public/docs/{doc-name}/
# - Runs compute-diff-pairing.mjs to produce diff-info.json
# - Registers {doc-name}-diff in manifest with format: "diff"

set -e

TEX_FILE="$1"
DOC_NAME="$2"
GIT_REF="${3:-HEAD~1}"

if [ -z "$TEX_FILE" ] || [ -z "$DOC_NAME" ]; then
  echo "Usage: $0 <tex-file> <doc-name> [git-ref]"
  echo ""
  echo "Examples:"
  echo "  $0 ~/papers/bregman.tex bregman HEAD~1"
  echo "  $0 ~/papers/bregman.tex bregman abc1234"
  exit 1
fi

if [ ! -f "$TEX_FILE" ]; then
  echo "Error: $TEX_FILE not found"
  exit 1
fi

TEX_DIR="$(cd "$(dirname "$TEX_FILE")" && pwd)"
TEX_BASE="$(basename "$TEX_FILE" .tex)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CURRENT_DOC_DIR="$SCRIPT_DIR/public/docs/$DOC_NAME"
DIFF_DOC_NAME="${DOC_NAME}-diff"
OUTPUT_DIR="$SCRIPT_DIR/public/docs/$DIFF_DOC_NAME"
MANIFEST="$SCRIPT_DIR/public/docs/manifest.json"
TMPDIR="$(mktemp -d)"

# Check current doc exists
if [ ! -d "$CURRENT_DOC_DIR" ]; then
  echo "Error: Current document not built yet. Run build-svg.sh first."
  echo "  ./build-svg.sh $TEX_FILE $DOC_NAME"
  exit 1
fi

echo "Building diff: $DOC_NAME (current) vs $GIT_REF"
echo "  Tex file: $TEX_FILE"
echo "  Current doc: $CURRENT_DOC_DIR"
echo "  Output: $OUTPUT_DIR"
echo "  Temp: $TMPDIR"

# Create output directory
mkdir -p "$OUTPUT_DIR"

# --- Step 1: Extract old version ---
echo ""
echo "Extracting old version ($GIT_REF)..."
cd "$TEX_DIR"

# Get the relative path of the tex file within the repo
TEX_REL="$(git ls-files --full-name "$TEX_BASE.tex" 2>/dev/null || echo "$TEX_BASE.tex")"

# Extract old tex file
git show "$GIT_REF:$TEX_REL" > "$TMPDIR/old-$TEX_BASE.tex"

# Also extract any .bib files, .sty, .cls that might be needed
for ext in bib sty cls; do
  for f in *."$ext"; do
    if [ -f "$f" ]; then
      # Try to get old version, fall back to current
      git show "$GIT_REF:$(git ls-files --full-name "$f" 2>/dev/null || echo "$f")" > "$TMPDIR/$f" 2>/dev/null || cp "$f" "$TMPDIR/$f"
    fi
  done
done

# Copy any other support files the build might need (images, etc.)
# Just symlink the tex directory contents as fallback
for f in "$TEX_DIR"/*; do
  bf="$(basename "$f")"
  [ -e "$TMPDIR/$bf" ] || ln -sf "$f" "$TMPDIR/$bf" 2>/dev/null || true
done

# --- Step 2: Compile old version ---
echo ""
echo "Compiling old version..."
cd "$TMPDIR"
latexmk -dvi -latex="pdflatex --output-format=dvi -synctex=1 %O %S" -interaction=batchmode "old-$TEX_BASE.tex" 2>&1 | tail -5

OLD_DVI="$TMPDIR/old-$TEX_BASE.dvi"
if [ ! -f "$OLD_DVI" ]; then
  echo "Error: Old DVI file not created"
  rm -rf "$TMPDIR"
  exit 1
fi

# --- Step 3: Convert old version to SVG ---
echo ""
echo "Converting old DVI to SVG..."
dvisvgm --page=1- --font-format=woff2 --bbox=papersize \
  --output="$OUTPUT_DIR/old-page-%p.svg" \
  "$OLD_DVI"

OLD_PAGE_COUNT=$(ls -1 "$OUTPUT_DIR"/old-page-*.svg 2>/dev/null | wc -l | tr -d ' ')
echo "Old version: $OLD_PAGE_COUNT pages"

# --- Step 4: Extract synctex for old version ---
echo ""
echo "Extracting synctex for old version..."
# The old synctex file references old-$TEX_BASE.tex but we need to point it at the right file
# Create a proper PDF for synctex (latexmk made one alongside the DVI)
cd "$SCRIPT_DIR"
node scripts/extract-synctex-lookup.mjs "$TMPDIR/old-$TEX_BASE.tex" "$OUTPUT_DIR/old-lookup.json"

# --- Step 5: Copy current version files ---
echo ""
echo "Copying current version files..."
CURRENT_PAGE_COUNT=$(ls -1 "$CURRENT_DOC_DIR"/page-*.svg 2>/dev/null | wc -l | tr -d ' ')
echo "Current version: $CURRENT_PAGE_COUNT pages"

# Copy current SVGs
for f in "$CURRENT_DOC_DIR"/page-*.svg; do
  cp "$f" "$OUTPUT_DIR/$(basename "$f")"
done

# Copy current lookup.json
if [ -f "$CURRENT_DOC_DIR/lookup.json" ]; then
  cp "$CURRENT_DOC_DIR/lookup.json" "$OUTPUT_DIR/lookup.json"
fi

# Copy macros.json
if [ -f "$CURRENT_DOC_DIR/macros.json" ]; then
  cp "$CURRENT_DOC_DIR/macros.json" "$OUTPUT_DIR/macros.json"
fi

# --- Step 6: Compute diff pairing ---
echo ""
echo "Computing diff pairing..."
cd "$SCRIPT_DIR"
node scripts/compute-diff-pairing.mjs \
  "$TEX_DIR" "$TEX_BASE.tex" "$GIT_REF" \
  "$OUTPUT_DIR/lookup.json" "$OUTPUT_DIR/old-lookup.json" \
  "$OUTPUT_DIR/diff-info.json" \
  "$CURRENT_PAGE_COUNT" "$OLD_PAGE_COUNT"

# --- Step 7: Update manifest ---
echo ""
echo "Updating manifest..."
node "$SCRIPT_DIR/scripts/manifest.mjs" set "$DIFF_DOC_NAME" \
  --name "$DOC_NAME diff vs $GIT_REF" --pages "$CURRENT_PAGE_COUNT" \
  --format diff --texFile "$TEX_DIR/$TEX_BASE.tex" --sourceDoc "$DOC_NAME"

# Cleanup
rm -rf "$TMPDIR"

echo ""
echo "Done! Access at: ?doc=$DIFF_DOC_NAME"
echo ""
echo "  Current: $CURRENT_PAGE_COUNT pages"
echo "  Old ($GIT_REF): $OLD_PAGE_COUNT pages"
