# Drag Filter Bug — Analysis

## The Bug
Dragging a label pill from the agents panel onto a fleet-chat shape intermittently fails to apply the filter. The filter update works sometimes and silently fails other times.

## Root Cause: Capture-Phase Listener Race

The drag system registers `pointerup`/`pointermove` listeners on `document` with `{ capture: true }`. The listeners call `stopImmediatePropagation()` to prevent tldraw from processing the events. **Three separate components** register competing capture-phase handlers:

1. `FleetAgentsShape.tsx` line 238-239 — agents panel pill drag
2. `FleetChatShape.tsx` line 1221-1222 — chat shape content drag
3. `FleetPillShape.tsx` line 437 — standalone pill drag handler

When multiple capture-phase listeners exist on the same element, they fire in **registration order**. If tldraw registers its own capture-phase handlers (which it does for pointer state management) AFTER a component re-renders, tldraw's handler fires first, calls `stopImmediatePropagation`, and the pill drop handler never fires.

This explains why the bug is:
- **Intermittent** — depends on render timing / listener registration order
- **Unpredictable** — which chat shapes it affects varies based on which components re-rendered recently
- **Not tied to isLocked** — the lock/unlock path works fine (verified: 0/10 failures on direct `updateShape` calls)

## Evidence

1. **Direct filter update always works**: Programmatically calling `editor.updateShape` with filter props succeeds 10/10 times on all chat shapes (balancing-act: 2 shapes, bregman: 4 shapes).

2. **Shape state is clean**: All chat shapes have valid filter props, no corrupted state. One shape on balancing-act is `isLocked: true` but the unlock/update/relock path handles this correctly.

3. **No rogue shapes**: Scanned all Yjs sync snapshots — no unknown shape types (a rogue `blame-timeline` shape in survival-draft was purged by a server restart).

## Proposed Fix

Replace the capture-phase listener pattern with a **shared drag coordinator** that ensures only one drag handler is active at a time:

```typescript
// Shared drag state — only one drag can be active
const activeDrag = { handler: null as ((e: PointerEvent) => void) | null }

// In each component's drag start:
activeDrag.handler = onPointerUp

// Single document-level listener (registered once):
document.addEventListener('pointerup', (e) => {
  if (activeDrag.handler) {
    e.stopImmediatePropagation()
    activeDrag.handler(e)
    activeDrag.handler = null
  }
}, { capture: true })
```

This eliminates the registration-order race by having ONE listener that delegates to whichever drag is active.

## Files Affected

| File | Issue |
|------|-------|
| `src/shapes/FleetAgentsShape.tsx` | Lines 238-239: capture-phase listeners |
| `src/shapes/FleetChatShape.tsx` | Lines 1221-1222, 1370: capture-phase listeners |
| `src/shapes/FleetPillShape.tsx` | Line 437: standalone pill drag |

## Status

Analysis complete. Fix requires refactoring all three drag handlers to use a shared coordinator. This is a medium-sized change — the drag logic is spread across three files and each has slightly different behavior (agents drag creates pills, chat drag moves content, pill shape drag applies filters).
