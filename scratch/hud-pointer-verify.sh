#!/bin/zsh
#
# HOLD IN EFFECT — 2026-09-02, cleanup-chief, citing Skip's live constraint:
# no nontrivial computation on the Mini. THIS SCRIPT DRIVES A BROWSER. Do not
# run it on the Mini until that hold is lifted.
#
# The hold is enforced below rather than left as a comment, because a comment
# does not survive someone skimming to the first command. It is a loud stop
# with a stated override, not a hidden off switch: clear it deliberately with
#
#   TLDA_HUD_VERIFY_HOLD_CLEARED=1 zsh scratch/hud-pointer-verify.sh
#
# Verifies `pw center <fleet region>` on the real deployed surface: reset the
# camera to the broken state, measure, run the fix, measure again.
#
# Expected result at step 4: the search panel fully inside the viewport at
# x≈24 (the pad), against x≈-921 at step 2.

set -u

if [[ "${TLDA_HUD_VERIFY_HOLD_CLEARED:-0}" != "1" ]]; then
  print -u2 "refusing to run: no-browser-on-Mini hold is in effect (see header)."
  print -u2 "if the hold is lifted, re-run with TLDA_HUD_VERIFY_HOLD_CLEARED=1"
  exit 3
fi

# The worktree's CLI, NOT the `tlda-dev` on PATH — that symlinks to another
# worktree and would exercise the old code, which is the whole thing under test.
WT=${TLDA_HUD_VERIFY_CLI:-/Users/skip/worktrees/hud-pointer-reachability/cli/tlda-dev.mjs}
if [[ ! -f $WT ]]; then
  print -u2 "refusing to run: CLI not found at $WT"
  exit 3
fi

# Fresh directory per run. A path pinned to one agent session is not reusable by
# whoever picks this up, and a stale file from a previous run reads as this
# run's result.
OUT=$(mktemp -d) || { print -u2 "mktemp failed"; exit 3 }
print "artifacts: $OUT"

# run <name> <args...>
#
# The command's EXIT STATUS decides pass or fail. `pw busy` is the one condition
# that means "try again" rather than "this failed" — the shared pool lock is
# contended and a lost race says nothing about the code under test.
#
# Everything else fails closed. The earlier version of this script inferred
# success from the ABSENCE of "pw busy" in the output, which is the shape AGENTS.md
# calls an instrument that answers without measuring: a crashed CLI, an unwritable
# artifact path and a genuine pass were all indistinguishable, and all three read
# as success.
run() {
  local name=$1; shift
  local f=$OUT/$name.txt
  # NOT `status` — that is read-only in zsh, and `local status` aborts the
  # function on every path, success included. It exits 1, which reads exactly
  # like the fail-closed branch working.
  local i rc

  for i in $(seq 1 40); do
    if ! : > $f; then
      print -u2 "[FAIL] $name: cannot write $f"
      return 1
    fi

    node $WT "$@" > $f 2>&1
    rc=$?

    if grep -q "pw busy" $f; then
      sleep 10
      continue
    fi

    if (( rc != 0 )); then
      print -u2 "[FAIL] $name: exit $rc"
      print -u2 "$(tail -20 $f)"
      return 1
    fi

    if [[ ! -s $f ]]; then
      print -u2 "[FAIL] $name: exit 0 but produced no output"
      return 1
    fi

    print "[ok] $name (attempt $i, exit 0)"
    return 0
  done

  print -u2 "[FAIL] $name: still lock-contended after 40 attempts"
  return 1
}

# Ask the page who it is rather than baking one agent's fleet id into the file.
#
# Ownership is decided by `props.userId === me`, which is the SAME predicate the
# tool under test uses. An earlier version matched a substring of the shape id
# instead: one question with two authorities inside one change, so the verifier
# could disagree with the thing it verifies and the disagreement would read as a
# code failure.
MEASURE='() => {
  var ed = window.__tldraw_editor__
  if (!ed) return "no editor"
  var me = typeof window.__tldaFleetIdentity === "function" ? window.__tldaFleetIdentity().id : null
  if (!me) return "no fleet identity yet"

  var wanted = {}
  var shapes = ed.getCurrentPageShapes()
  for (var i = 0; i < shapes.length; i++) {
    var s = shapes[i]
    if (String(s.type).indexOf("fleet-") !== 0) continue
    if (!s.props || s.props.userId !== me) continue
    wanted[s.id] = true
  }

  var vis = [], all = document.querySelectorAll(".fleet-shape")
  for (var j = 0; j < all.length; j++) {
    var el = all[j]
    if (getComputedStyle(el).visibility === "hidden") continue
    var h = el.closest("[data-shape-id]")
    if (!h || !wanted[h.getAttribute("data-shape-id")]) continue
    var r = el.getBoundingClientRect()
    vis.push({ id: h.getAttribute("data-shape-id").replace("shape:fleet-", ""), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) })
  }
  return JSON.stringify({ owner: me, cam: ed.getCamera(), vp: { w: innerWidth, h: innerHeight }, visibleMine: vis }, null, 1)
}'

# Which project the tab is pointed at is not incidental: a browser launch writes
# fleet shapes into that project's synced room. Assert it before touching
# anything, so this cannot be run against a project somebody works in.
EXPECT_PROJECT=${TLDA_HUD_VERIFY_PROJECT:-dev-linked-remote-probe}
WHERE='() => JSON.stringify({ url: location.href, project: new URLSearchParams(location.search).get("project") })'

RESET='() => {
  var ed = window.__tldraw_editor__
  window.__tldaFleetHudSuppressCameraTrackingUntil = Date.now() + 4000
  var c = ed.getCamera()
  ed.setCamera({ x: 200, y: 50, z: c.z }, { animation: { duration: 0 } })
  return "reset to x=200"
}'

ASSERT=${0:a:h}/hud-pointer-assert.mjs
if [[ ! -f $ASSERT ]]; then
  print -u2 "refusing to run: assertion script not found at $ASSERT"
  exit 3
fi

print "STEP 0: confirm which project this tab is pointed at"
run 0-where pw eval "$WHERE" || exit 1
if ! node $ASSERT --project $EXPECT_PROJECT $OUT/0-where.txt; then
  print -u2 "       Override with TLDA_HUD_VERIFY_PROJECT=<name> if that is deliberate."
  exit 1
fi

print "STEP 1: reset the camera to the broken starting state (x=200)"
run 1-reset pw eval "$RESET" || exit 1

print "STEP 2: measure BEFORE — expect the search panel off the left edge"
run 2-before pw eval "$MEASURE" || exit 1

print "STEP 3: pw center search — THE FIX"
run 3-center pw center search || exit 1

print "STEP 4: measure AFTER — expect the search panel fully on screen"
run 4-after pw eval "$MEASURE" || exit 1

# The steps above only establish that four commands ran. `pw center` exits 0
# whatever it finds -- including every bail-out string -- so a run in which the
# panel never moved reaches this line with everything green. THE ASSERTION IS THE
# TEST; the four steps are just how the numbers get collected.
print "STEP 5: assert the panel actually moved from outside to inside"
if ! node $ASSERT $OUT/2-before.txt $OUT/4-after.txt search; then
  print -u2 "FAILED — artifacts in $OUT"
  exit 1
fi

print "PASSED — the search panel moved from outside the viewport to fully inside it."
print "artifacts: $OUT"
