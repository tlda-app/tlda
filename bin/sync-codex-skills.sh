#!/usr/bin/env bash
# Symlink the canonical fleet skills into Codex's native skill-lookup dir so a
# Codex agent reads each SKILL.md natively from the filesystem (and the read
# registers with the education gate via the …/skills/<name>/SKILL.md path match).
#
# Source of truth: ~/work/dot-claude/skills/<name>/SKILL.md  (where Skip authors)
# Codex native scan: $CODEX_HOME/skills/<name>/SKILL.md       (default ~/.codex)
#
# Only CORE skills are symlinked into the scan dir so Codex injects only their
# descriptions at startup (preventing context burn from the full ~96-skill catalog).
# The remaining skills are available on-demand via ~/work/dot-claude/skills/<name>/
# and are listed in $CODEX_HOME/skill-index.md (NOT inside skills/, so not injected).
#
# Idempotent + re-runnable. Codex's own builtin skills live under the special
# `.system/` namespace — this script never touches it. Run again after adding or
# removing a skill (Codex picks up changes on its next restart).
set -euo pipefail

SRC="${SKILLS_SRC:-$HOME/work/dot-claude/skills}"
CODEX_BASE="${CODEX_HOME:-$HOME/.codex}"
DEST="$CODEX_BASE/skills"
INDEX="$CODEX_BASE/skill-index.md"

# ---------------------------------------------------------------------------
# CORE allowlist — always-on Codex skills (symlinked into the scan dir).
# Membership is tunable: add/remove names here and re-run the script.
# Everything else is available on-demand; see $CODEX_HOME/skill-index.md.
# ---------------------------------------------------------------------------
CORE=(
  self-sufficiency
  respond-before-acting
  history-is-evidence-not-instruction
  recover-thread-context
  am-i-being-an-asshole
  verification-before-completion
  three-beat-corrections
  subagents
  tlda-orientation
)

# Helper: is_core <name> — returns 0 if <name> is in CORE, 1 otherwise.
# Uses a simple loop; works with bash 3.x (macOS system bash).
is_core() {
  local _n="$1" _c
  for _c in "${CORE[@]}"; do
    [[ "$_c" == "$_n" ]] && return 0
  done
  return 1
}

if [[ ! -d "$SRC" ]]; then
  echo "sync-codex-skills: source skills dir not found: $SRC" >&2
  exit 1
fi
mkdir -p "$DEST"

linked=0 skipped=0 pruned=0

# 1. Link CORE skills into DEST (skip non-dirs, skip non-SKILL.md, skip .system).
for dir in "$SRC"/*/; do
  [[ -f "$dir/SKILL.md" ]] || continue
  name="$(basename "$dir")"
  [[ "$name" == ".system" ]] && continue
  is_core "$name" || continue   # skip non-core
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

# 2. Prune stale symlinks: dangling, removed canonical skill, OR no longer in CORE.
#    Never touch .system or real (non-symlink) entries.
for link in "$DEST"/*; do
  [[ -e "$link" || -L "$link" ]] || continue
  [[ -L "$link" ]] || continue
  base="$(basename "$link")"
  [[ "$base" == ".system" ]] && continue
  rl="$(readlink "$link")"
  case "$rl" in
    "$SRC"/*)
      # Prune if: source dir gone, SKILL.md gone, or name no longer in CORE.
      if [[ ! -d "$rl" || ! -f "$rl/SKILL.md" ]] || ! is_core "$base"; then
        rm -f "$link"
        pruned=$((pruned + 1))
      fi
      ;;
    # Symlinks pointing elsewhere are not ours — leave them alone.
  esac
done

# ---------------------------------------------------------------------------
# 3. Emit discovery index: $CODEX_HOME/skill-index.md
#    Lists EVERY canonical skill (core + non-core) with a one-line description
#    extracted from its SKILL.md frontmatter. Placed directly under CODEX_HOME
#    (NOT inside skills/) so Codex does NOT auto-inject it.
# ---------------------------------------------------------------------------

# Helper: extract first line of description from SKILL.md frontmatter.
_get_desc() {
  local file="$1"
  awk '
    /^---/ { fm++; next }
    fm == 1 && /^description:/ {
      val = substr($0, index($0, ":") + 2)
      gsub(/^[ \t]+|[ \t]+$/, "", val)
      if (val == ">-" || val == ">" || val == "") {
        # block scalar or empty: grab first indented continuation line
        while ((getline line) > 0) {
          gsub(/^[ \t]+/, "", line)
          if (line != "") { val = line; break }
        }
      } else {
        # strip optional surrounding quotes
        gsub(/^["'"'"']|["'"'"']$/, "", val)
      }
      if (length(val) > 120) val = substr(val, 1, 120) "..."
      print val
      exit
    }
    fm >= 2 { exit }
  ' "$file"
}

{
  echo "# Codex Skill Index"
  echo "#"
  echo "# All loadable skills — read on demand by fetching the full SKILL.md."
  echo "# Load path: ~/work/dot-claude/skills/<name>/SKILL.md"
  echo "# Only CORE skills are injected at startup (symlinked into \$CODEX_HOME/skills/)."
  echo "# To load any skill below, read its SKILL.md at the path above."
  echo ""
  echo "## Core (always injected)"
  echo ""
  for dir in "$SRC"/*/; do
    [[ -f "$dir/SKILL.md" ]] || continue
    name="$(basename "$dir")"
    is_core "$name" || continue
    desc="$(_get_desc "$dir/SKILL.md")"
    echo "- **$name**: $desc"
  done
  echo ""
  echo "## On-demand (not injected — read SKILL.md to activate)"
  echo ""
  for dir in "$SRC"/*/; do
    [[ -f "$dir/SKILL.md" ]] || continue
    name="$(basename "$dir")"
    is_core "$name" && continue
    desc="$(_get_desc "$dir/SKILL.md")"
    echo "- $name: $desc"
  done
} > "$INDEX"

# Count totals for summary.
total_core=${#CORE[@]}
total_skills=0
for dir in "$SRC"/*/; do
  [[ -f "$dir/SKILL.md" ]] && total_skills=$((total_skills + 1))
done
total_ondemand=$((total_skills - total_core))

echo "sync-codex-skills: linked=$linked unchanged=$skipped pruned=$pruned dest=$DEST"
echo "sync-codex-skills: core=$total_core on-demand=$total_ondemand total=$total_skills index=$INDEX"
