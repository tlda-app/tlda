#!/usr/bin/env bash
# Symlink the canonical fleet skills into Codex's native skill-lookup dir so a
# Codex agent reads each SKILL.md natively from the filesystem (and the read
# registers with the education gate via the …/skills/<name>/SKILL.md path match).
#
# Source of truth: ~/work/dot-claude/skills/<name>/SKILL.md  (where Skip authors)
# Codex native scan: $CODEX_HOME/skills/<name>/SKILL.md       (default ~/.codex)
#
# Idempotent + re-runnable. Codex's own builtin skills live under the special
# `.system/` namespace — this script never touches it. Run again after adding or
# removing a skill (Codex picks up changes on its next restart).
set -euo pipefail

SRC="${SKILLS_SRC:-$HOME/work/dot-claude/skills}"
DEST="${CODEX_HOME:-$HOME/.codex}/skills"

if [[ ! -d "$SRC" ]]; then
  echo "sync-codex-skills: source skills dir not found: $SRC" >&2
  exit 1
fi
mkdir -p "$DEST"

linked=0 skipped=0 pruned=0

# 1. Link every canonical skill (a dir containing SKILL.md) into DEST.
for dir in "$SRC"/*/; do
  [[ -f "$dir/SKILL.md" ]] || continue
  name="$(basename "$dir")"
  target="${dir%/}"
  link="$DEST/$name"
  if [[ -L "$link" && "$(readlink "$link")" == "$target" ]]; then
    skipped=$((skipped + 1)); continue
  fi
  if [[ -e "$link" && ! -L "$link" ]]; then
    echo "sync-codex-skills: refusing to clobber non-symlink $link" >&2
    continue
  fi
  ln -sfn "$target" "$link"
  linked=$((linked + 1))
done

# 2. Prune stale symlinks we previously created that now dangle or point at a
#    removed canonical skill. Never touch .system or real (non-symlink) entries.
for link in "$DEST"/*; do
  [[ -L "$link" ]] || continue
  base="$(basename "$link")"
  [[ "$base" == ".system" ]] && continue
  rl="$(readlink "$link")"
  case "$rl" in
    "$SRC"/*) [[ -d "$rl" && -f "$rl/SKILL.md" ]] || { rm -f "$link"; pruned=$((pruned + 1)); } ;;
  esac
done

echo "sync-codex-skills: linked=$linked unchanged=$skipped pruned=$pruned dest=$DEST"
