#!/bin/sh
# Install tlda's git hooks into .git/hooks/.
# Run once after clone or after adding new hooks under bin/git-hooks/.

set -e

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOKS_DIR="$REPO_ROOT/.git/hooks"
SOURCE_DIR="$REPO_ROOT/bin/git-hooks"

if [ ! -d "$SOURCE_DIR" ]; then
  echo "no hooks to install — $SOURCE_DIR missing"
  exit 0
fi

for hook in "$SOURCE_DIR"/*; do
  name="$(basename "$hook")"
  cp "$hook" "$HOOKS_DIR/$name"
  chmod +x "$HOOKS_DIR/$name"
  echo "installed: $name"
done
