# HUD Layout — Skip's Final Spec (2026-04-05)

Verbatim from Skip. This is the canonical spec. Do not reinterpret.

## Requirements

1. **Controllable HUD size.** I want to be able to control the size of the HUD.

2. **Controllable layout.** I want to be able to control the layout of the things in the HUD.

3. **Button-activated layout mode.** A button activates layout mode, in which:
   - The HUD appears as a **transient container** (virtual, not persistent — no long-lasting container shape)
   - The transient container **can be resized**, with everything within it **scaling to fit**
   - The shapes within the HUD become **resizable, movable, reshapable** — they behave like rectangles with textual texture on them
   - **Dragging moves them** — no chip creation, no chat artifacts, just move the shape
   - Exiting layout mode removes the transient container

4. **No persistent container shape.** That has proven to be a nightmare.

5. **No clipping.** Nothing gets clipped off-screen or hidden.

6. **Automatic resize.** Things automatically resize (to fit content / container).

7. **No "Done" button.** Exit layout mode by clicking outside the transient container. Click off = done.

8. **Container looks like a normal tldraw shape.** No special dashed borders, no "Layout Mode" label, no modal overlay styling. If it's a tldraw shape, it should look like one.

## What NOT to build

- No persistent FleetContainer shape
- No clipping/overflow hidden
- Dragging shapes in layout mode must NOT trigger chip/chat/selection behaviors — just move the rectangle
- No "scale model" HUD — shapes should be usable size

## Previous attempts and why they failed

- **v1 (w7-hud-layout):** Group-move overlay with dashed border. Right intent but bad UX — overlay covered content, couldn't resize individual shapes.
- **v2 (w7-redesign):** Draggable/resizable floating panel. Wrong problem — made the HUD window positionable, didn't address shape layout within HUD.

Neither version implemented: transient container, per-shape resize in layout mode, scale-to-fit, or the button toggle.
