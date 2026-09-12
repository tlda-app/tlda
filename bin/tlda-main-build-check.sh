#!/bin/sh
# Compile main and report. Run detached by bin/git-hooks/post-merge; see that
# file for why this check exists at all.
#
# Separate script, taking arguments, deliberately. The first version inlined
# this as `nohup sh -c '...'` inside the hook — the quoted body does not inherit
# the caller's variables, so every path arrived empty and it announced
# "main does not compile at " with no sha, no errors and no log, on a tree that
# compiled fine. A checker that cries wolf gets muted, and a muted checker
# protects nothing. Arguments cannot be got wrong that way.
#
#   $1 repo root   $2 status file   $3 log file   $4 short sha
set -u

REPO_ROOT="${1:-}"
STATUS="${2:-}"
LOG="${3:-}"
SHA="${4:-}"

# Refuse to run half-configured rather than reporting nonsense. Every one of
# these being present is what the inlined version silently lacked.
[ -n "$REPO_ROOT" ] && [ -n "$STATUS" ] && [ -n "$LOG" ] && [ -n "$SHA" ] || exit 0
cd "$REPO_ROOT" || exit 0

STARTED=$(date +%s)

# `tsc -b`, not `npm ci && vite build`. npm ci measured THIRTEEN MINUTES on a
# quiet box during the deploy of the same day; a check that costs that is turned
# off or worked around, and then it protects nothing. tsc -b catches both of the
# real breaks this was written for. On a contended box it still takes minutes —
# the honest figure is "minutes, load-dependent", not "seconds".
if npx --no-install tsc -b >"$LOG" 2>&1; then
  printf 'ok %s %s %ss\n' "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(( $(date +%s) - STARTED ))" >"$STATUS"
  exit 0
fi

printf 'BROKEN %s %s %ss\n' "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(( $(date +%s) - STARTED ))" >"$STATUS"

# Loud, and on stderr so a pipeline reading stdout cannot swallow it.
{
  printf '\n'
  printf '  main does not compile at %s\n' "$SHA"
  printf '  ---------------------------------------------\n'
  grep -m 5 'error TS' "$LOG" 2>/dev/null | sed 's/^/  /'
  printf '  ---------------------------------------------\n'
  printf '  full output: %s\n' "$LOG"
  printf '  Everyone who lands on top of this inherits it, and the next\n'
  printf '  deploy will refuse whoever pushes — probably not you.\n\n'
} >&2

exit 1
