#!/bin/bash
# release.sh — Tag a release, wait for GitHub Actions to build it,
# update the Homebrew formula, and push the tap.
#
# Usage: ./bin/release.sh vX.Y.Z [--dry-run]
#
# Prerequisites:
#   - gh CLI installed and authenticated
#   - ~/work/homebrew-tlda exists (the tap repo)

set -euo pipefail

VERSION="${1:-}"
DRY_RUN="${2:-}"
TLDA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TAP_DIR="$HOME/work/homebrew-tlda"
FORMULA="$TAP_DIR/Formula/tlda.rb"
SOURCE_REPO="tlda-app/tlda"

if [[ ! "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: $0 vX.Y.Z [--dry-run]"
  exit 1
fi

if [[ -n "$DRY_RUN" && "$DRY_RUN" != "--dry-run" ]]; then
  echo "Usage: $0 vX.Y.Z [--dry-run]"
  exit 1
fi

PACKAGE_VERSION=$(node -p "require('$TLDA_DIR/package.json').version")
if [[ "$VERSION" != "v$PACKAGE_VERSION" ]]; then
  echo "❌ Tag $VERSION does not match package version $PACKAGE_VERSION"
  exit 1
fi

cd "$TLDA_DIR"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "❌ Release checkout is not clean"
  exit 1
fi

if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "❌ Releases must run from main"
  exit 1
fi

ORIGIN_URL=$(git remote get-url origin)
if [[ "$ORIGIN_URL" != "git@github.com:$SOURCE_REPO.git" &&
      "$ORIGIN_URL" != "https://github.com/$SOURCE_REPO.git" ]]; then
  echo "❌ origin is $ORIGIN_URL, expected github.com/$SOURCE_REPO"
  exit 1
fi

if git rev-parse --verify --quiet "refs/tags/$VERSION" >/dev/null; then
  echo "❌ Tag $VERSION already exists locally"
  exit 1
fi

if ! REMOTE_TAG=$(git ls-remote --tags origin "refs/tags/$VERSION"); then
  echo "❌ Could not read tags from origin"
  exit 1
fi
if [[ -n "$REMOTE_TAG" ]]; then
  echo "❌ Tag $VERSION already exists on origin"
  exit 1
fi

if ! REMOTE_MAIN=$(git ls-remote origin refs/heads/main); then
  echo "❌ Could not read main from origin"
  exit 1
fi
REMOTE_MAIN_SHA=${REMOTE_MAIN%%[[:space:]]*}
LOCAL_SHA=$(git rev-parse HEAD)
if [[ -z "$REMOTE_MAIN_SHA" || "$LOCAL_SHA" != "$REMOTE_MAIN_SHA" ]]; then
  echo "❌ Local main $LOCAL_SHA does not match origin/main ${REMOTE_MAIN_SHA:-missing}"
  exit 1
fi

if [[ "$DRY_RUN" == "--dry-run" ]]; then
  echo "✓ Release preflight passed for $VERSION at $LOCAL_SHA"
  echo "  Source release: https://github.com/$SOURCE_REPO"
  echo "  Homebrew tap: $TAP_DIR"
  exit 0
fi

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
echo "→ Tagging $VERSION..."
git tag -a "$VERSION" -m "tlda $VERSION"
git push origin "$VERSION"

# 2. Wait for release workflow
echo "→ Waiting for release workflow to complete..."
echo "  (watching GitHub Actions — this takes 1-2 minutes)"

# Poll for the release to appear
MAX_WAIT=300
ELAPSED=0
while [[ $ELAPSED -lt $MAX_WAIT ]]; do
  RELEASE_URL=$(gh release view "$VERSION" --repo "$SOURCE_REPO" --json assets --jq '.assets[0].url' 2>/dev/null || true)
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
  echo "   https://github.com/$SOURCE_REPO/actions"
  exit 1
fi

# 3. Download tarball and compute sha256
TARBALL_URL="https://github.com/$SOURCE_REPO/releases/download/$VERSION/tlda-$VERSION.tar.gz"
echo "→ Computing sha256..."
SHA256=$(curl -fsSL "$TARBALL_URL" | shasum -a 256 | cut -d' ' -f1)
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
