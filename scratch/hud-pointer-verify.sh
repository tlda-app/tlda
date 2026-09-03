#!/bin/zsh
# Verify pw center on the real deployed surface.
# Runs the WORKTREE's CLI, not the shared `tlda-dev` symlink (which points at
# another agent's worktree and would exercise the old code).
WT=/Users/skip/worktrees/hud-pointer-reachability/cli/tlda-dev.mjs
OUT=/private/tmp/claude-501/-Users-skip-work-tlda/160c8ab3-ae3b-4e23-ac9d-7aa460410aa8/scratchpad

# Retry wrapper: the shared pool lock is contended by other agents.
run() {  # run <outfile> <args...>
  local f=$1; shift
  local i
  for i in $(seq 1 40); do
    node $WT "$@" > $f 2>&1
    grep -q "pw busy" $f || { echo "[ok] $* (attempt $i)"; return 0; }
    sleep 10
  done
  echo "[LOCK TIMEOUT] $*"; return 1
}

MEASURE='() => { var vis = []; var all = document.querySelectorAll(".fleet-shape"); for (var i=0;i<all.length;i++){ var el=all[i]; if(getComputedStyle(el).visibility==="hidden") continue; var h=el.closest("[data-shape-id]"); var id=h?h.getAttribute("data-shape-id"):"?"; if(id.indexOf("fleet_0fe26c74")===-1) continue; var r=el.getBoundingClientRect(); vis.push({id:id.replace("shape:fleet-",""),x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}); } var ed=window.__tldraw_editor__; return JSON.stringify({cam:ed.getCamera(),vp:{w:innerWidth,h:innerHeight},visibleMine:vis},null,1); }'

echo "=== STEP 1: reset camera to the broken starting state (x=200) ==="
run $OUT/v1-reset.txt pw eval '() => { var ed=window.__tldraw_editor__; window.__tldaFleetHudSuppressCameraTrackingUntil=Date.now()+4000; var c=ed.getCamera(); ed.setCamera({x:200,y:50,z:c.z},{animation:{duration:0}}); return "reset to x=200"; }'

echo "=== STEP 2: measure BEFORE (expect search panel off the left edge) ==="
run $OUT/v2-before.txt pw eval "$MEASURE"

echo "=== STEP 3: pw center search  (THE FIX) ==="
run $OUT/v3-center.txt pw center search

echo "=== STEP 4: measure AFTER ==="
run $OUT/v4-after.txt pw eval "$MEASURE"

echo "ALL STEPS DONE"
