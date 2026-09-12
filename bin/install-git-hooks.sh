#!/bin/sh
# Install tlda's git hooks into .git/hooks/.
# Run once after clone or after adding new hooks under bin/git-hooks/.

set -e

REPO_ROOT="$(git rev-parse --show-toplevel)"

# `--git-common-dir`, never "$REPO_ROOT/.git": in a WORKTREE .git is a FILE
# pointing at the real gitdir, so "$REPO_ROOT/.git/hooks" is a path under a file
# and cp fails with "Not a directory". This script could therefore only be run
# from the canonical checkout -- and nearly all work in this repo happens in
# worktrees, because the shared checkout is where someone else is standing.
#
# `--git-common-dir` also resolves to the SHARED hooks directory rather than a
# per-worktree one, which is what we want: hooks are per-clone, so installing
# from any worktree installs for all of them.
GIT_COMMON="$(git rev-parse --git-common-dir)"
case "$GIT_COMMON" in
  /*) ;;
  *) GIT_COMMON="$REPO_ROOT/$GIT_COMMON" ;;
esac
HOOKS_DIR="$GIT_COMMON/hooks"
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
