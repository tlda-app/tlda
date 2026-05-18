#!/bin/bash
# release.sh — Tag a release, wait for GitHub Actions to build it,
# update the Homebrew formula, and push the tap.
#
# Usage: ./bin/release.sh [version]
#   version defaults to v0.1.0 if not specified
#
# Prerequisites:
#   - gh CLI installed and authenticated
#   - ~/work/homebrew-tlda exists (the tap repo)

set -euo pipefail

VERSION="${1:-v0.1.0}"
TLDA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TAP_DIR="$HOME/work/homebrew-tlda"
FORMULA="$TAP_DIR/Formula/tlda.rb"

if [[ ! -d "$TAP_DIR" ]]; then
  echo "❌ Tap repo not found at $TAP_DIR"
  exit 1
fi

if ! command -v gh &>/dev/null; then
  echo "❌ gh CLI not installed. brew install gh"
  exit 1
fi

echo "=== Release $VERSION ==="

# 1. Tag and push
cd "$TLDA_DIR"
echo "→ Tagging $VERSION..."
git tag -f "$VERSION"
git push origin "$VERSION" --force

# 2. Wait for release workflow
echo "→ Waiting for release workflow to complete..."
echo "  (watching GitHub Actions — this takes 1-2 minutes)"

# Poll for the release to appear
MAX_WAIT=300
ELAPSED=0
while [[ $ELAPSED -lt $MAX_WAIT ]]; do
  RELEASE_URL=$(gh release view "$VERSION" --json assets --jq '.assets[0].url' 2>/dev/null || true)
  if [[ -n "$RELEASE_URL" ]]; then
    echo "  ✓ Release found"
    break
  fi
  sleep 10
  ELAPSED=$((ELAPSED + 10))
  echo "  ...waiting ($ELAPSED s)"
done

if [[ -z "$RELEASE_URL" ]]; then
  echo "❌ Release not found after ${MAX_WAIT}s. Check GitHub Actions."
  echo "   https://github.com/qtm285/tlda/actions"
  exit 1
fi

# 3. Download tarball and compute sha256
TARBALL_URL="https://github.com/qtm285/tlda/releases/download/$VERSION/tlda-$VERSION.tar.gz"
echo "→ Computing sha256..."
SHA256=$(curl -sL "$TARBALL_URL" | shasum -a 256 | cut -d' ' -f1)
echo "  sha256: $SHA256"

if [[ -z "$SHA256" || "$SHA256" == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" ]]; then
  echo "❌ Empty tarball or download failed"
  exit 1
fi

# 4. Update formula
echo "→ Updating Homebrew formula..."
cd "$TAP_DIR"
sed -i '' "s|url \".*\"|url \"$TARBALL_URL\"|" "$FORMULA"
sed -i '' "s|sha256 \".*\"|sha256 \"$SHA256\"|" "$FORMULA"

echo "  Updated $FORMULA"
grep -E "url|sha256" "$FORMULA" | head -2

# 5. Commit and push tap
git add Formula/tlda.rb
git commit -m "tlda $VERSION"
git push origin main

echo ""
echo "=== Done ==="
echo "Install: brew tap qtm285/tlda && brew install tlda"
echo "Update:  brew update && brew upgrade tlda"
