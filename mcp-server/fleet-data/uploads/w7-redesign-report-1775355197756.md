# W7 HUD Resize Handles + Panel Drag — Report (v2, with clamp fix)
**Date:** 2026-04-04
**Branch:** `w7-hud-layout-v2` worktree (commit 09cb82f)
**Server:** `http://localhost:5187/?doc=fleet-ws-main&token=c5e4726ab77972fc7312f3a703f9cf1c`

---

## What Changed from v1

v1 was reverted because dragging had no viewport clamping — the HUD could be moved fully off-screen with no recovery path. Fixed in this version:

- **`onBarPointerMove`**: clamps live drag offset so panel never goes out of viewport during drag
- **`onBarPointerUp`**: clamps committed `screenYOffset` to `[-halfRoom, +halfRoom]` where `halfRoom = (window.innerHeight - panelH) / 2`

This guarantees: top edge ≥ 0, bottom edge ≤ window.innerHeight, always.

---

## Interaction Model

The fleet HUD is a draggable, resizable floating window:

- **Drag to move**: Grab the controls bar (⠿ × strip at the top). `cursor: grab`, pointer capture, live offset preview. Commits on release; clamped to viewport.
- **Resize handles**: 8 invisible 8×8px handles at corners and edges of `.fleet-hud-wrap`. Correct resize cursors. Drag changes `userPanelH`; width auto-follows aspect ratio. Persisted to localStorage.
- **FleetGroupOverlay + layoutMode**: Fully removed.

---

## What's Working (Playwright-verified)

1. **8 resize handles** — `querySelectorAll('.fleet-hud-resize-handle').length === 8` ✓
2. **Correct cursors** — nw/n/ne/e/se/s/sw/w-resize on all 8 handles ✓
3. **Controls bar drag indicator** — ⠿, `cursor: grab`, `pointer-events: auto` ✓
4. **Bar drag moves panel live** — real mouse events: panel tracked exactly +150px, +60px ✓
5. **Y commit + persist** — `fleet-hud-y-offset = "60"` written to localStorage ✓
6. **SE resize drag** — height 576 → 676px (+100px); `fleet-hud-panel-h = "676"` ✓
7. **Drag upward clamp** — dragged bar to y=0; panel clamped at top=0, bottom=576, yOffset=-72 ✓
8. **Drag downward clamp** — dragged bar to y=900; panel clamped at top=144, bottom=720, yOffset=72 ✓
9. **TS build clean** — zero errors ✓
10. **No regression** — fleet-chat + fleet-agents render normally ✓

---

## Screenshots

### Step 1: Initial state — HUD at center position
![Initial](w7-hud-3-initial.png)

HUD panel showing fleet-chat messages at top and fleet-agents search bar at bottom. Controls bar (⠿ ×) at top. Panel centered vertically (top=72, height=576, window=720).

### Step 2: During bar drag (+150, +60)
![During drag](w7-hud-4-drag-mid.png)

Panel tracked to (160, 132) — exactly +150px right, +60px down. Content moves with container.

### Step 3: After drag committed
![After drag](w7-hud-5-after-drag.png)

Y committed, shapes moved in canvas X. `fleet-hud-y-offset = "60"` in localStorage.

### Step 4: After SE resize (+100px height)
![After resize](w7-hud-6-after-resize.png)

Height 576→676px. `fleet-hud-panel-h = "676"` in localStorage.

### Step 5: Drag clamped at bottom edge
![Clamp bottom](w7-clamp-down.png)

Dragged bar to y=900 (far below screen). Panel clamped at top=144, bottom=720 (flush with screen bottom). Fleet content still fully visible. `yOffset = "72"` (maximum).

---

## Console Errors

All errors are pre-existing WS 9876 failures (trackpad.mjs — foot pedal server not running). None from this change.

---

## Files Changed

| File | Change |
|------|--------|
| `src/overlays/FleetHUD.tsx` | Remove FleetGroupOverlay + layoutMode; add bar drag with viewport clamp; add 8 resize handles; add userPanelH + panelDragOffset state |
| `src/overlays/FleetHUD.css` | Remove layout overlay styles; add resize handle + drag indicator styles |
