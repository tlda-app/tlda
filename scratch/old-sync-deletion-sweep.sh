#!/bin/sh
# Pre-deletion sweep for the old sync path.
#
# RUN THIS AT THE MOMENT THE DELETION COMMIT IS WRITTEN, against `main` as it
# then stands -- not earlier. Three production callers were invisible to the
# plan for the first two hours of this work, and enumerations of them have been
# wrong repeatedly. A sweep from an hour ago is a claim about an hour ago.
#
# Usage:  sh scratch/old-sync-deletion-sweep.sh [ref]        (default: main)
#
# Two rules this encodes, both learned the hard way tonight:
#
# 1. ANCHOR ON THE URL, NOT THE HELPER. The CLI alone reaches HTTP three ways --
#    `api(...)`, `apiAt(targetServer, ...)`, and a local `post()` defined inside
#    cli/lib/dev-worktree.mjs. A sweep anchored on any one of them undercounts,
#    which is exactly how `:2922` and dev-worktree went missing from the plan.
#
# 2. EVERY ZERO NEEDS A POSITIVE CONTROL. A zero from a broken query and a zero
#    from a clean tree are indistinguishable. The control below greps for
#    something known to be present on the same ref, with the same command shape.
#    If the control comes back empty, the instrument is broken and every zero in
#    this run is meaningless.
#
# Note the ref argument. A bare `git grep` reads the working tree, and the
# shared checkout at /Users/skip/work/tlda sits on whatever branch an agent last
# checked out -- it was `fix-bot-launcher-name-race` all through this work.
# Passing the ref is not optional.

REF="${1:-main}"
echo "sweep ref: $REF   ($(git log -1 --format='%h %cd' --date=iso-local "$REF"))"
echo

echo "=== POSITIVE CONTROL (must be non-empty, or every zero below is a lie) ==="
# `sourceLifecycleStore` is the control because it satisfies both halves of what
# a control needs here, and picking one that did not is a mistake this script
# has already made once: the first version used `applyAcceptedSourceEffects`,
# which exists only on accept-path-daemon-push and reads 0 on main. The control
# came back empty on the very first run.
#
#   1. present on the ref being swept -- BEFORE the deletion, and
#   2. still present AFTER it, so the same script keeps working afterwards.
#
# A control that the deletion itself removes would start failing exactly when
# the sweep is supposed to confirm success.
git grep -c "sourceLifecycleStore" "$REF" -- server/routes/projects.mjs
echo "   (empty here = broken instrument. STOP. Do not read any zero below.)"
echo

echo "=== 1. HTTP callers of the old push route, URL-anchored, all languages ==="
git grep -nE "/api/projects/[^\"'\`]*/push" "$REF" -- cli/ src/ server/ daemon/ bin/ test/ packages/ mcp-server/
echo "   (expect: nothing)"
echo

echo "=== 2. HTTP callers of the single-file source route (caller 17's shape) ==="
git grep -nE "/api/projects/[^\"'\`]*/source/" "$REF" -- cli/ src/ server/ daemon/ bin/ test/ packages/ mcp-server/
echo "   (expect: nothing, once caller 17 has moved)"
echo

echo "=== 3. In-process callers ==="
for sym in processProjectPush processProjectPushSerialized; do
  echo "--- $sym ---"
  git grep -n "$sym" "$REF" -- server/ daemon/ bin/ test/
done
echo "   (expect: nothing outside the deletion itself)"
echo

echo "=== 4. The five named in-process sites, confirmed gone or repointed ==="
for loc in "server/routes/projects.mjs" "server/lib/source-room-daemon.mjs" \
           "server/lib/overleaf-sync.mjs" "server/unified-server.mjs"; do
  printf '%-40s processProjectPush=%s\n' "$loc" \
    "$(git grep -c "processProjectPush" "$REF" -- "$loc" 2>/dev/null | cut -d: -f3 || echo 0)"
done
echo

echo "=== 5. The WS source-change handler -- LAST, and only after the daemons ==="
git grep -n "'source-change'" "$REF" -- server/unified-server.mjs daemon/
echo
echo "Daemon rollout: this handler receives what the daemon cutover stopped"
echo "sending. Delete it while any daemon still runs old code and that daemon's"
echo "messages are accepted and silently do nothing -- a severed wire reporting"
echo "health. Both checkouts need the code AND a restart:"
for co in /Users/skip/work/tlda /Users/skip/worktrees/daemon-testing; do
  if [ -d "$co" ]; then
    printf '  %-42s branch=%-32s createSourcePush=%s  sendSourceChange=%s\n' \
      "$co" \
      "$(git -C "$co" rev-parse --abbrev-ref HEAD 2>/dev/null)" \
      "$(grep -c "createSourcePush" "$co/daemon/source-sync.mjs" 2>/dev/null | head -1)" \
      "$(grep -c "sendSourceChange" "$co/daemon/source-sync.mjs" 2>/dev/null | head -1)"
  fi
done
echo
echo "  sendSourceChange non-zero with createSourcePush zero = still old code."
echo "  A checkout having the code is not the same as the running daemon having"
echo "  loaded it. A long-lived process keeps the old module until restarted."
echo

echo "=== 6. sourceFileBatches -- production-dead, dies with this commit ==="
git grep -n "sourceFileBatches" "$REF" -- cli/ bin/ docs/ test/
echo
echo "sweep complete. Read every line above before writing the commit."
echo
echo "=== WHAT THIS SWEEP CANNOT SEE ==="
cat <<'LIMITS'
A clean run above does NOT mean the deletion is safe. This instrument finds
CALLERS THAT STILL EXIST. It is blind to the opposite and more dangerous thing:
an effect the old path performed that the new path never picked up. There is no
literal to grep for a call that is simply absent.

Four of those have been found so far, none of them by a grep, and every one by
running something and reading the result back rather than checking a response:

  - the working copy was never written from the accepted revision
  - the client manifest
  - edit-event regions
  - the OUTBOUND Overleaf push -- prepareSourcePushToOverleaf is called only
    from inside the old processProjectPushSerialized, and nothing in bootstrap,
    submit or applyAcceptedSourceEffects calls it. A linked collaborator would
    simply stop receiving, with no error on either side.

So the gate is not "the sweep is clean". The gate is "the sweep is clean AND
every effect the old path performed has a counterpart that was observed to run".
Confirm the fourth one above is closed before writing the deletion.
LIMITS
