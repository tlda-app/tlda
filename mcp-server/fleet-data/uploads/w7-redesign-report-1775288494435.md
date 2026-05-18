# W7 HUD Resize Handles + Panel Drag — Report
**Date:** 2026-04-04
**Branch:** `w7-hud-layout-v2` worktree
**Server:** `http://localhost:5187/?doc=fleet-ws-main&token=c5e4726ab77972fc7312f3a703f9cf1c`

---

## Interaction Model

The fleet HUD is now a draggable, resizable floating window:

- **Drag to move**: Grab the controls bar (⠿ × strip at the top). The ⠿ braille dot indicator is a visual affordance — `cursor: grab` on the bar. Dragging updates panel position live; on release, commits Y to `screenYOffset` (persisted) and X by moving fleet shapes in canvas coords.
- **Resize handles**: 8 invisible 8×8px handles at corners and edges of `.fleet-hud-wrap`. Each has the correct resize cursor. Only vertical movement changes panel height (width auto-follows aspect ratio). Size persisted to `fleet-hud-panel-h` in localStorage.
- **FleetGroupOverlay + layoutMode**: Completely removed. No more ⊞ button modal — the bar is always a direct drag handle.

---

## What's Working (Playwright-verified)

1. **8 resize handles present** — verified via `querySelectorAll('.fleet-hud-resize-handle').length === 8`
2. **Correct cursors** — `nw-resize`, `n-resize`, `ne-resize`, `e-resize`, `se-resize`, `s-resize`, `sw-resize`, `w-resize` — confirmed on all 8
3. **`pointer-events: auto`** on all handles — they receive input despite `fleet-hud-wrap` having `pointer-events: none`
4. **Controls bar drag indicator** — ⠿ (braille dots), `cursor: grab`, `pointer-events: auto`
5. **Bar drag moves panel live** — dragged +150px right, +60px down; HUD tracked exactly: (10,72) → (160,132)
6. **Drag commit** — on mouseup, Y committed to `screenYOffset`; `fleet-hud-y-offset = "60"` in localStorage ✓
7. **SE resize drag** — dragged SE handle down 100px; height changed 576 → 676px exactly
8. **Resize commit** — `fleet-hud-panel-h = "676"` in localStorage ✓
9. **TS build clean** — `tsc --noEmit` passes with zero errors
10. **No regression** — HUD shows fleet-chat and fleet-agents content normally

---

## Screenshots

### Step 1: Initial state — HUD expanded, controls bar visible
![Initial](w7-hud-3-initial.png)

The HUD panel is at the left edge of the viewport showing fleet-chat messages at top and fleet-search bar at bottom. The controls bar is visible at the top of the panel: ⠿ (drag indicator) + × (close). The panel has its auto 80vh height.

### Step 2: During controls bar drag (+150px, +60px)
![During drag](w7-hud-4-drag-mid.png)

The panel shifted right ~150px and down ~60px. The content (chat messages, search bar, agents section) all moved with it. The drag offset is applied as a live CSS translation — no jank. Controls bar now shows at the new position.

### Step 3: After drag committed
![After drag](w7-hud-5-after-drag.png)

On mouseup, the Y delta (+60) committed to `screenYOffset`, and the X delta moved fleet shapes in canvas coordinates. The panel reanchored to the new canvas position. `fleet-hud-y-offset = "60"` written to localStorage.

### Step 4: After SE resize handle drag (+100px height)
![After resize](w7-hud-6-after-resize.png)

Panel height increased from 576px to 676px. The fleet-chat region now shows more content (more vertical space), and the agents section is still visible at the bottom. `fleet-hud-panel-h = "676"` written to localStorage.

---

## Console Errors

All 70 console errors are pre-existing WS 9876 failures (trackpad.mjs — foot pedal server not running). None are from this change.

---

## Files Changed

| File | Change |
|------|--------|
| `src/overlays/FleetHUD.tsx` | Remove `FleetGroupOverlay` + `layoutMode`; add bar drag handlers; add 8 resize handles; add `userPanelH` + `panelDragOffset` state |
| `src/overlays/FleetHUD.css` | Remove layout overlay styles; add `.fleet-hud-resize-handle` + `.fleet-hud-drag-indicator`; add grab cursor to controls bar |
