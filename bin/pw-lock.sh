#!/usr/bin/env bash
# Playwright single-user lock.
# Skip's machine can't handle two concurrent playwright sessions and the
# automation pops a giant browser window on his screen. Agents must
# acquire this lock before launching playwright, release it on close.
#
# Usage:
#   bin/pw-lock.sh acquire <agent-name>     # exit 0 if acquired, 1 if held
#   bin/pw-lock.sh release <agent-name>     # release lock if held by this agent
#   bin/pw-lock.sh status                   # print current holder
#   bin/pw-lock.sh steal <agent-name>       # force-take lock (last resort)
#
# Lock file: ~/.config/tlda/playwright.lock
# Format:    one line, "<agent-name>\t<unix-timestamp>"
# Stale:     considered stale after 10 minutes — anyone can re-acquire.

set -euo pipefail

# Lock lives inside the project tree so the fleet-agent rm shim (which
# blocks deletes outside ~/work) can clean it up. Override with TLDA_PW_LOCK.
LOCK="${TLDA_PW_LOCK:-$HOME/work/tlda/.pw.lock}"
STALE_SECS="${TLDA_PW_LOCK_STALE:-600}"

mkdir -p "$(dirname "$LOCK")"

cmd="${1:-status}"
who="${2:-}"

now=$(date +%s)

current_holder() {
  [ -f "$LOCK" ] || return 1
  awk -F'\t' -v now="$now" -v stale="$STALE_SECS" '
    { age = now - $2; if (age < stale) { print $1; print $2; exit } }
  ' "$LOCK"
}

case "$cmd" in
  acquire)
    [ -n "$who" ] || { echo "usage: pw-lock.sh acquire <agent-name>" >&2; exit 2; }
    holder_info=$(current_holder || true)
    if [ -n "$holder_info" ]; then
      holder=$(printf '%s\n' "$holder_info" | head -1)
      ts=$(printf '%s\n' "$holder_info" | sed -n '2p')
      age=$(( now - ts ))
      if [ "$holder" = "$who" ]; then
        printf '%s\t%s\n' "$who" "$now" > "$LOCK"
        echo "re-acquired by $who"
        exit 0
      fi
      echo "LOCKED by $holder (${age}s ago). Wait or run: bin/pw-lock.sh steal $who" >&2
      exit 1
    fi
    printf '%s\t%s\n' "$who" "$now" > "$LOCK"
    echo "acquired by $who"
    ;;
  release)
    [ -n "$who" ] || { echo "usage: pw-lock.sh release <agent-name>" >&2; exit 2; }
    if [ -f "$LOCK" ]; then
      holder=$(awk -F'\t' '{print $1; exit}' "$LOCK")
      if [ "$holder" = "$who" ]; then
        rm -f "$LOCK"
        echo "released by $who"
      else
        echo "not held by $who (held by ${holder:-none}); not releasing" >&2
        exit 1
      fi
    else
      echo "no lock to release"
    fi
    ;;
  status)
    holder_info=$(current_holder || true)
    if [ -n "$holder_info" ]; then
      holder=$(printf '%s\n' "$holder_info" | head -1)
      ts=$(printf '%s\n' "$holder_info" | sed -n '2p')
      age=$(( now - ts ))
      echo "$holder (acquired ${age}s ago)"
    else
      echo "unlocked"
    fi
    ;;
  steal)
    [ -n "$who" ] || { echo "usage: pw-lock.sh steal <agent-name>" >&2; exit 2; }
    printf '%s\t%s\n' "$who" "$now" > "$LOCK"
    echo "stolen by $who"
    ;;
  *)
    echo "usage: pw-lock.sh {acquire|release|status|steal} [agent-name]" >&2
    exit 2
    ;;
esac
