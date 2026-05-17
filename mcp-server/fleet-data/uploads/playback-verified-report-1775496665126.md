# PlaybackFrame — Visual Verification Report

**Test doc:** `test-playback` (markdown project, separate from Skip's documents)
**Recording:** `78808b78` — "Layout Keyframe Test" (4/4/2026, 1:30:11 duration)
- 133 real fleet chat events (genuine agent conversations)
- Speed edits: 0–600s @ 3x, 1200–2000s @ 0.5x
- Subtitles: t=0s, 300s, 900s, 1500s
- Layout event: injected at t=500s for curated mode test

**Method:** Playwright Chromium, worktree SPA (`playback-iscontainer`), own test doc.
**85 screenshots** across 10 user stories.

---

## Story 1 — Place a PlaybackFrame and pick a recording

> "I place a PlaybackFrame on the canvas. It shows a picker listing all available recordings. I click one and it loads."

**1a — Empty canvas before placing the frame**
![Empty canvas](wt2/01-story1-a-empty-canvas.png)

**1b — Frame placed with no recording: picker shown**
![Frame with picker](wt2/02-story1-b-picker-shown.png)

**1c — Picker list (recordings available)**
![Picker list](wt2/03-story1-c-picker-list.png)

**1d — Recording selected: frame loaded with title, date, controls**
![Recording loaded](wt2/04-story1-d-recording-loaded.png)

**1e — Header close-up: title, date, duration, "edits" dropdown, +HUD**
![Header close-up](wt2/05-story1-e-header-loaded.png)

**Result: PASS** — picker renders, recording loads on selection. `playbackId` set via picker row click.

---

## Story 2 — Play, pause, and rewind

> "I click ▶ and the recording plays. Time advances in the display. I click ⏸ to pause, then ⏮ to rewind."

**2a — Paused at 0:00**
![Paused at start](wt2/51-story2-final-a-paused-at-0s.png)

**2b — Playing: after 2.5s wall-clock, time shows 0:07 (at 1x speed)**
*(Note: 0–600s region has 3x timewarp. At user speed 1x × timewarp 3x = 3x effective. 2.5s × 3 ≈ 7.5s → shows 0:07. ✓)*
![Playing, time advancing](wt2/52-story2-final-b-playing.png)

**2c — Paused mid-recording**
![Paused mid](wt2/53-story2-final-c-paused-mid.png)

**2d — Rewound to 0:00**
![Rewound](wt2/54-story2-final-d-rewound.png)

**Result: PASS** — play/pause/rewind all work. Time advances as expected with timewarp applied.

---

## Story 3 — Scrub to a specific moment

> "I drag the timeline slider to any position. The time display updates immediately."

**3a — Slider at 0:00**
![Scrub at 0s](wt2/10-story3-a-scrub-0s.png)

**3b — Scrubbed to 10:00 (600s, 11% through 1:30:11)**
![Scrub at 600s](wt2/11-story3-b-scrub-600s.png)

**3c — Scrubbed to ~41:40 (2500s, 46% through)**
![Scrub at 2500s](wt2/12-story3-c-scrub-2500s.png)

**3d — Scrubbed to end (1:30:11)**
![Scrub at end](wt2/13-story3-d-scrub-end.png)

**Implementation note:** React's `onChange` on `<input type="range">` requires the native `input` event. Programmatic scrubbing uses:
```js
const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
setter.call(slider, String(ms))
slider.dispatchEvent(new Event('input', { bubbles: true }))
```

**Result: PASS** — scrubber updates time display at any position.

---

## Story 4 — Change playback speed

> "I set speed to 5x. The recording plays through 5 seconds of content per wall-clock second."

**4a — Default speed: 1x**
![Speed 1x](wt2/55-story4-final-a-speed-1x.png)

**4b — Speed set to 5x**
![Speed 5x set](wt2/56-story4-final-b-speed-5x.png)

**4c — After ~1 second of wall-clock time at 5x: time shows 0:14**
*(0–600s region has 3x timewarp. User speed 5x × timewarp 3x = 15x effective. ~1s → ~14–15s. Shows 0:14. ✓)*
![After 1s at 5x](wt2/57-story4-final-c-after-1s-5x.png)

**Result: PASS** — speed control works. `getEffectiveSpeed()` multiplies user speed × timewarp factor correctly.

---

## Story 5 — Click +HUD to populate fleet shapes inside the frame

> "I click +HUD. A fleet-chat shape and a fleet-agents shape appear inside the frame, filling the content area."

**5a — Before +HUD: drop zone visible ("drag shapes here")**
![Before HUD](wt2/17-story5-a-before-hud.png)

**5b — After +HUD: fleet-chat (left, 60%) + fleet-agents (right, 40%) created**
![After HUD created](wt2/18-story5-b-after-hud-created.png)

**5c — Scrubbed to 20:00: fleet-chat shows real agent conversations**
![HUD with content](wt2/58-story5-final-content-at-1200s.png)

**Result: PASS** — +HUD creates both child shapes correctly positioned and sized. fleet-chat props: `{w, h, filter:[]}`. fleet-agents props: `{w, h}`.

---

## Story 6 — Resize the frame; child shapes scale proportionally

> "I resize the PlaybackFrame. Both child shapes scale to fill the new content area."

**6a — Before resize (frame at original size, 16:40 scrubbed)**
![Before resize](wt2/20-story6-a-before-resize.png)

**6b — After resize to 75% scale: frame visibly smaller, children refill content area**
![After resize](wt2/21-story6-b-after-resize.png)

*Test applied: `editor.resizeShape(frameId, {x: 540, y: 420})` (from 720×560). Scale: 0.75×0.75.*

**Result: PASS** — `onResize` scales content area correctly. Chrome height (header+scrubber, 100px) stays fixed; child dimensions scale by `scaleX/scaleY`.

---

## Story 7 — Switch between timewarp cuts; speed graph reflects regions

> "The header shows a dropdown with the available named cuts. I switch between 'raw' and 'edits'. The speed graph on the scrubber changes."

**7a — Timewarp dropdown open: named cuts listed**
![Timewarp dropdown](wt2/22-story7-a-timewarp-dropdown.png)

**7b — "raw" selected (no speed mapping)**
![Raw selected](wt2/23-story7-b-raw-selected.png)

**7c — "edits" selected (auto-selected on load)**
![Edits selected](wt2/24-story7-c-edits-selected.png)

**7d — Scrubber position in the 3x region (0–600s), speed graph showing blue fill**
![In 3x region](wt2/25-story7-d-3x-region.png)

**7e — Scrubber position in the 0.5x region (1200–2000s)**
![In 0.5x region](wt2/26-story7-e-05x-region.png)

**Speed edits applied:**
- 0–600s: factor 3 → `extractTimewarps` creates region {start:0, end:600000, speed:3}
- 600–1200s: gap filled with speed 1
- 1200–2000s: factor 0.5 → region {start:1200000, end:2000000, speed:0.5}

**Result: PASS** — timewarp dropdown present, "edits" cut auto-selected, speed regions constructed and graphed correctly.

---

## Story 8 — Subtitles appear at the right times

> "The recording has subtitle entries. As I scrub, the correct subtitle appears at the bottom of the frame."

**8a — t=5s: "Fleet agents coordinating on drag-and-drop feature"** *(subtitle starts at 0s)*
![Subtitle at 5s](wt2/27-story8-subtitle-5s.png)

**8b — t=310s: "Debugging chip rendering issues"** *(subtitle starts at 300s)*
![Subtitle at 310s](wt2/28-story8-subtitle-310s.png)

**8c — t=910s: "Reviewing visual test evidence"** *(subtitle starts at 900s)*
![Subtitle at 910s](wt2/29-story8-subtitle-910s.png)

**8d — t=1510s: "Final verification pass"** *(subtitle starts at 1500s)*
![Subtitle at 1510s](wt2/30-story8-subtitle-1510s.png)

**Result: PASS** — all 4 subtitles render at correct times. `getCurrentSubtitle()` correctly finds the active entry via binary search over sorted subtitle timestamps.

---

## Story 9 — Curated mode applies layout keyframes as you scrub

> "In curated mode, when I scrub past a layout keyframe timestamp, the child shapes jump to the keyframe positions."

**9a — Curated frame loaded: "CURATED" badge in header, t=0:00**
![Curated frame](wt2/65-story9-v2-a-curated-loaded.png)

**9b — t=6:40 (400s, before keyframe at 500s): fleet-chat on left, fleet-agents on right**
![Before keyframe](wt2/66-story9-v2-b-before-kf-400s.png)

**9c — t=10:00 (600s, after keyframe at 500s): fleet-agents on left, fleet-chat on right**
*(Child positions swapped: chat moved from x=0 to x=280; agents moved from x=424 to x=0)*
![After keyframe](wt2/67-story9-v2-c-after-kf-600s.png)

**9d — Scrub back to t=5:00 (300s): positions revert to original layout**
![Scrub back](wt2/68-story9-v2-e-scrub-back-300s.png)

**9e — Scrub forward again to t=11:40 (700s): positions re-apply**
![Scrub forward again](wt2/69-story9-v2-f-forward-700s.png)

**Layout event injected:** `{ t: 500000, type: 'layout', data: { shapes: { chatId: {x:280,y:100}, agentsId: {x:0,y:100} } } }`
Applied via `editor.store.mergeRemoteChanges()` — ephemeral, not synced to Yjs.

**Result: PASS** — layout keyframes apply and revert correctly on scrub. CURATED badge renders. `getLayoutKeyframe()` correctly returns the most recent keyframe at or before `currentMs`.

---

## Story 10 — Drag a fleet shape into the PlaybackFrame

> "I drag a fleet-chat shape from outside the frame into it. It should reparent and switch to recording data."

**10a — Setup: PlaybackFrame on canvas, fleet-chat shape outside (to the right)**
![Setup](wt2/84-story10-tldraw-a-setup.png)

**10b — After Playwright mouse drag: fleet-chat NOT reparented (parentId still page:page)**
![After drag](wt2/85-story10-tldraw-b-after-drag.png)

**10c — After calling `onDragShapesIn` directly: fleet-chat IS inside the curated frame**
![After direct call](wt2/73-story10-v2-d-direct-reparent.png)

**Result: FAIL** — Real mouse drag does not trigger `onDragShapesIn`.

**Root cause investigation:**

TLDraw's `DragAndDropManager` uses a `setInterval` that calls `getDraggingOverShape()` during SelectTool's "translating" state. Instrumented `getDraggingOverShape`: **called 0 times** during Playwright drag simulation. TLDraw's SelectTool state machine never enters "translating" state via Playwright's `mouse.move/down/up` events.

Hit test confirms frame IS findable: at frame center, `getShapesAtPoint` returns `["playback-frame", "html-page"]`. The frame is hittable — TLDraw simply isn't receiving the drag event sequence.

Handler logic is correct: direct call `util.onDragShapesIn(frame, [chatShape], info)` calls `editor.reparentShapes([chatId], frameId)` and the shape moves inside (screenshot 10c confirms).

**Note on `isContainer`:** Added `isContainer = () => true` to `PlaybackFrameShapeUtil` in the `playback-iscontainer` worktree. However, `isContainer` is not a real TLDraw API — TLDraw's container check in `getDraggingOverShape` looks for the presence of `onDragShapesIn` method, not `isContainer`. The method is present and works; the issue is that TLDraw's drag state machine never starts under Playwright simulation.

**Fix needed:** Investigate why TLDraw's pointer event handling doesn't enter "translating" state via Playwright. Likely requires `pointerdown` → `pointermove` sequence with correct button state, or dispatching synthetic pointer events instead of mouse events.

---

## Summary Table

| # | User Story | Status | Key Evidence |
|---|-----------|--------|-------------|
| 1 | Place frame + pick recording | **PASS** | Picker lists recordings; loads on click |
| 2 | Play / pause / rewind | **PASS** | 0:07 after 2.5s at 1x (1x × 3x timewarp ≈ 7.5s); pause/rewind work |
| 3 | Scrub to specific moment | **PASS** | `input` event: 0:00 → 10:00 → 41:40 → 1:30:11 |
| 4 | Change playback speed | **PASS** | 5x × 3x timewarp = ~15x effective; 0:14 after 1s |
| 5 | +HUD populate | **PASS** | fleet-chat (60%) + fleet-agents (40%) created; real chat content visible |
| 6 | Resize → scale-to-fit | **PASS** | 720×560 → 540×420 (0.75 scale); children resize proportionally |
| 7 | Timewarp / named cuts | **PASS** | "edits" dropdown, raw/edits switching, speed graph with 3x + 0.5x regions |
| 8 | Subtitles | **PASS** | All 4 subtitles at correct timestamps (0s/300s/900s/1500s) |
| 9 | Curated mode layout keyframes | **PASS** | CURATED badge; positions swap at t=500s, revert on scrub back |
| 10 | Drag shapes in/out | **FAIL** | Playwright drag: DragAndDropManager never enters "translating" state (0 calls to `getDraggingOverShape`). Handler works when called directly. |

**9 PASS · 1 FAIL**

One bug: Playwright simulation doesn't trigger TLDraw's drag state machine. Handler logic is correct; the integration point between TLDraw's SelectTool and pointer events needs investigation.
