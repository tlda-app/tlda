#!/usr/bin/env bash
# Playwright single-user lock — PID-aware, renewable, queue-not-steal.
#
# Skip's machine can't handle two concurrent playwright sessions and the
# automation pops a giant browser window on his screen. Agents must acquire
# this lock before launching playwright, release it on close.
#
# Why PID-aware: the old lock went stale purely on a timestamp, so a single
# long-running `tlda-dev pw` verb (a multi-minute eval/proof) that issued no
# intermediate verbs let the lock expire and get STOLEN mid-eval — the stealer
# then reaped the shared browser. Now a lock whose HOLDER PROCESS is still alive
# is never stale (its liveness IS the heartbeat), so an active proof can't be
# stolen; only a genuinely dead/idle holder's lock frees. A second agent should
# `acquire --wait` to QUEUE behind the live holder rather than steal+reap.
#
# Usage:
#   bin/pw-lock.sh acquire <agent> [--pid <PID>] [--wait[=SECS]]
#       acquire the lock. --pid records a liveness PID (the agent/session
#       process); while that PID is alive the lock never goes stale. --wait
#       QUEUES (polls) until a live holder releases or dies, up to SECS
#       (default 600), instead of failing. exit 0 acquired, 1 held/timed-out.
#   bin/pw-lock.sh renew <agent>            # refresh timestamp if held by agent (heartbeat)
#   bin/pw-lock.sh release <agent>          # release if held by this agent
#   bin/pw-lock.sh status                   # print current holder
#   bin/pw-lock.sh steal <agent> [--pid N]  # force-take (last resort, for a dead holder)
#
# Lock file: $TLDA_PW_LOCK (default ~/work/tlda/.pw.lock — inside the tree so the
#            fleet-agent rm shim can clean it up).
# Format:    one line, "<agent>\t<unix-timestamp>\t<pid>"  (pid 0 = none).
# Stale:     timestamp older than $TLDA_PW_LOCK_STALE (default 90s) AND the
#            holder pid is absent/dead. A live pid keeps the lock fresh forever.

set -euo pipefail

LOCK="${TLDA_PW_LOCK:-$HOME/work/tlda/.pw.lock}"
STALE_SECS="${TLDA_PW_LOCK_STALE:-90}"
WAIT_POLL_SECS="${TLDA_PW_LOCK_POLL:-2}"
WAIT_MAX_DEFAULT="${TLDA_PW_LOCK_WAIT:-600}"

mkdir -p "$(dirname "$LOCK")"

now() { date +%s; }

pid_alive() { [ -n "${1:-}" ] && [ "$1" != "0" ] && kill -0 "$1" 2>/dev/null; }

# Populate HOLDER/TS/PID from the lock file. Returns 1 if there is no lock file.
read_lock() {
  HOLDER=''; TS=0; PID=0
  [ -f "$LOCK" ] || return 1
  IFS=$'\t' read -r HOLDER TS PID < "$LOCK" || return 1
  TS="${TS:-0}"; PID="${PID:-0}"
  return 0
}

# Is the lock currently ACTIVE (held by a still-valid holder, not stealable)?
#
# Liveness-FIRST: when a holder PID is recorded, that pid's liveness IS the
# heartbeat — a live pid keeps the lock active forever (a long verb can't be
# stolen), and a DEAD recorded pid makes the lock stale IMMEDIATELY regardless of
# timestamp. That last part is the fix for the wedge: a `tlda-dev pw` verb whose
# wrapper was killed mid-flight used to keep the lock "fresh" by timestamp for the
# full stale window, so every other agent's acquire timed out and they
# re-hibernated without ever getting a browser. Now the next agent sees the dead
# pid and takes the lock at once. Only when NO pid was recorded (pid 0 — e.g. a
# manual steal) do we fall back to the timestamp heartbeat.
lock_active() {
  read_lock || return 1
  if [ -n "$PID" ] && [ "$PID" != "0" ]; then
    pid_alive "$PID" && return 0
    return 1
  fi
  local age=$(( $(now) - TS ))
  [ "$age" -lt "$STALE_SECS" ] && return 0
  return 1
}

write_lock() { printf '%s\t%s\t%s\n' "$1" "$2" "${3:-0}" > "$LOCK"; }

# ---- arg parsing ----
cmd="${1:-status}"
shift || true
who=''
pid_arg='0'
wait_mode=0
wait_max="$WAIT_MAX_DEFAULT"
while [ $# -gt 0 ]; do
  case "$1" in
    --pid) shift; pid_arg="${1:-0}" ;;
    --pid=*) pid_arg="${1#--pid=}" ;;
    --wait) wait_mode=1 ;;
    --wait=*) wait_mode=1; wait_max="${1#--wait=}" ;;
    --*) echo "unknown flag: $1" >&2; exit 2 ;;
    *) [ -z "$who" ] && who="$1" || { echo "unexpected arg: $1" >&2; exit 2; } ;;
  esac
  shift || true
done

case "$cmd" in
  acquire)
    [ -n "$who" ] || { echo "usage: pw-lock.sh acquire <agent> [--pid N] [--wait[=SECS]]" >&2; exit 2; }
    deadline=$(( $(now) + wait_max ))
    while :; do
      if lock_active; then
        if [ "$HOLDER" = "$who" ]; then
          write_lock "$who" "$(now)" "$pid_arg"   # re-acquire / refresh
          echo "re-acquired by $who"
          exit 0
        fi
        # Held by a live other holder.
        if [ "$wait_mode" = 1 ] && [ "$(now)" -lt "$deadline" ]; then
          sleep "$WAIT_POLL_SECS"
          continue
        fi
        age=$(( $(now) - TS ))
        if [ "$wait_mode" = 1 ]; then
          echo "TIMED OUT after ${wait_max}s waiting for $HOLDER (held ${age}s ago). Still active; not stealing." >&2
        else
          echo "LOCKED by $HOLDER (${age}s ago, pid $PID alive). Re-run with --wait to queue, or steal as a last resort." >&2
        fi
        exit 1
      fi
      # Free or stale-and-dead → take it.
      write_lock "$who" "$(now)" "$pid_arg"
      echo "acquired by $who"
      exit 0
    done
    ;;
  renew)
    [ -n "$who" ] || { echo "usage: pw-lock.sh renew <agent>" >&2; exit 2; }
    if read_lock && [ "$HOLDER" = "$who" ]; then
      write_lock "$who" "$(now)" "$PID"
      echo "renewed by $who"
    else
      echo "not held by $who (held by ${HOLDER:-none}); not renewing" >&2
      exit 1
    fi
    ;;
  release)
    [ -n "$who" ] || { echo "usage: pw-lock.sh release <agent>" >&2; exit 2; }
    if read_lock; then
      if [ "$HOLDER" = "$who" ]; then
        rm -f "$LOCK"
        echo "released by $who"
      else
        echo "not held by $who (held by ${HOLDER:-none}); not releasing" >&2
        exit 1
      fi
    else
      echo "no lock to release"
    fi
    ;;
  status)
    if lock_active; then
      age=$(( $(now) - TS ))
      if pid_alive "$PID"; then alive="pid $PID alive"; else alive="pid ${PID} (no live pid)"; fi
      echo "$HOLDER (acquired ${age}s ago, $alive)"
    else
      echo "unlocked"
    fi
    ;;
  steal)
    [ -n "$who" ] || { echo "usage: pw-lock.sh steal <agent> [--pid N]" >&2; exit 2; }
    write_lock "$who" "$(now)" "$pid_arg"
    echo "stolen by $who"
    ;;
  *)
    echo "usage: pw-lock.sh {acquire|renew|release|status|steal} <agent> [--pid N] [--wait[=SECS]]" >&2
    exit 2
    ;;
esac
