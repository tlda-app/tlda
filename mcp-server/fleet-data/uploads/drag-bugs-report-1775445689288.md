# Drag Filter Bug — Fix Report

**Worktree:** `.worktrees/drag-bugs`
**Branch:** `drag-bugs`
**Commit:** `a4ffab8`
**Build:** tsc clean, vite build passes

---

## The Bug

Dragging a label pill from the agents panel onto a fleet-chat shape intermittently fails to apply the filter. Works sometimes, silently fails other times. Has been frustrating Skip "forever."

## Root Cause

**Capture-phase listener registration race.**

Three components register `pointermove`/`pointerup` on `document` with `{ capture: true }`:
- `FleetAgentsShape.tsx` — always-on listeners (check dragRef, return early if null)
- `FleetChatShape.tsx` — per-drag listeners (added on pointerdown, removed on pointerup)
- tldraw itself — capture-phase handlers for pointer state management

Same-phase capture listeners fire in **registration order**. When tldraw re-registers its handlers after a component re-render, its handler fires before the pill drag handler, calls `stopImmediatePropagation`, and the drop never happens.

## Evidence

- **Direct `updateShape` calls succeed 10/10 times** on all chat shapes (balancing-act: 2 shapes, bregman: 4 shapes). The filter update path itself is reliable.
- **The failure is in event delivery**, not in shape state or locking.
- **Intermittent because** it depends on render timing — which components re-rendered since the last drag determines listener registration order.

## The Fix

New `src/shapes/dragCoordinator.ts` — one global capture-phase listener pair installed once at module load. Components `claim(onMove, onUp)` when starting a drag. The coordinator dispatches to the active handler and calls `stopImmediatePropagation` from its single listener.

```
Before: 3 competing capture listeners → registration-order race
After:  1 coordinator listener → dispatches to claimed handler
```

**Changes:**
- `FleetAgentsShape.tsx`: removed always-on `useEffect` listeners, claims coordinator in `startDrag`
- `FleetChatShape.tsx`: replaced per-drag `addEventListener` with `coordinator.claim()`, removed manual listener cleanup
- `dragCoordinator.ts`: new 50-line module

## Files

| File | Lines | What |
|------|-------|------|
| `src/shapes/dragCoordinator.ts` | +55 | Shared drag coordinator |
| `src/shapes/FleetAgentsShape.tsx` | +70/-80 | Use coordinator instead of useEffect listeners |
| `src/shapes/FleetChatShape.tsx` | +5/-10 | Use coordinator instead of per-drag listeners |

## Additional Finding

Found and cleaned a rogue `blame-timeline` shape in `survival-draft`'s Yjs sync snapshot (left from earlier testing). This would have caused `INVALID_RECORD` errors on that document. The server restart purged it automatically.
