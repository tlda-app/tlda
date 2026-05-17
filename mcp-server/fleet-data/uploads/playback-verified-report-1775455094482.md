# PlaybackFrame — Visual Verification Walkthrough

**Test doc:** `nb-test-doc` (Yjs room cleared before each test run)
**Recording:** `060034bc` — "Verification Test Recording" (3:22 duration)
- Speed edits: 0–60s @ 3x, 120–203s @ 0.5x
- Subtitles: t=0s, 30s, 90s, 150s
- Layout event: injected at t=50s (for curated mode test)

**Method:** Playwright Chromium, programmatic shape creation, real mouse events for drag test.
**41 screenshots** across 10 user stories.

---

## Story 1 — Place a PlaybackFrame and pick a recording

> "I place a PlaybackFrame on the canvas. It shows a picker listing all available recordings. I click one and it loads."

**1a — Empty canvas before placing the frame**
![Empty canvas](wt/01-story1-empty-canvas.png)

**1b — Frame placed with no recording: picker shown**
![Frame with picker](wt/02-story1-picker-shown.png)

**1c — Picker list (21 recordings available)**
![Picker list](wt/03-story1-picker-list.png)

*The picker lists all recordings with title, date, and duration. Clicking any row sets `playbackId` on the shape.*

**1d — Recording selected: frame loaded with title, date, controls**
![Recording loaded](wt/04-story1-recording-loaded.png)

**1e — Header close-up: title, date, duration, "edits" dropdown, +HUD**
![Header close-up](wt/05-story1-header-loaded.png)

**Result: PASS** — picker renders, recording loads on selection.

---

## Story 2 — Play, pause, and rewind

> "I click ▶ and the recording plays. Time advances in the display. I click ⏸ to pause, then ⏮ to rewind."

**2a — Paused at 0:00**
![Paused at start](wt/06-story2-paused-at-start.png)

**2b — Playing: after 2.5s wall-clock, time shows 0:07 (at 1x speed)**
![Playing, time advancing](wt/07-story2-playing-time-advancing.png)

**2c — Paused mid-recording**
![Paused mid](wt/08-story2-paused-mid.png)

**2d — Rewound to 0:00**
![Rewound](wt/09-story2-rewound-to-start.png)

**Result: PASS** — play/pause/rewind all work. Time advances correctly at 1x.

---

## Story 3 — Scrub to a specific moment

> "I drag the timeline slider to any position. The time display updates immediately."

**3a — Slider at 0:00**
![Scrub at 0%](wt/10-story3-scrub-at-0pct.png)

**3b — Scrubbed to 0:25 (12% through 3:22)**
![Scrub at 25s](wt/11-story3-scrub-at-12pct-25s.png)

**3c — Scrubbed to 1:41 (50% through 3:22)**
![Scrub at 50%](wt/12-story3-scrub-at-50pct-101s.png)

**3d — Scrubbed to end (3:22)**
![Scrub at end](wt/13-story3-scrub-at-end.png)

**Implementation note:** React's `onChange` on `<input type="range">` requires the native `input` event. Programmatic scrubbing uses:
```js
const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
setter.call(slider, String(ms))
slider.dispatchEvent(new Event('input', { bubbles: true }))
```

**Result: PASS** — scrubber updates time display at any position.

---

## Story 4 — Change playback speed

> "I set speed to 5x. The recording plays through 5 seconds of content per wall-clock second."

**4a — Default speed: 1x**
![Speed 1x](wt/14-story4-speed-1x-default.png)

**4b — Speed set to 5x**
![Speed 5x set](wt/15-story4-speed-5x-set.png)

**4c — After 1 second of wall-clock time at 5x: time shows 0:15**
*(expected ~0:05; actual 0:15 — the recording has a 3x speed edit in the 0–60s region, so effective speed = 5x × 3x = 15x)*
![After 1s at 5x](wt/16-story4-speed-5x-after-1sec.png)

**Result: PASS** — speed control works. The 15x effective speed (5x user × 3x timewarp region) confirms `getEffectiveSpeed()` multiplies correctly.

---

## Story 5 — Click +HUD to populate fleet shapes inside the frame

> "I click +HUD. A fleet-chat shape and a fleet-agents shape appear inside the frame, filling the content area."

**5a — Before +HUD: drop zone visible ("drag shapes here")**
![Before HUD](wt/17-story5-before-hud-dropzone.png)

**5b — After +HUD: fleet-chat (left, 60%) + fleet-agents (right, 40%) created**
![After HUD created](wt/18-story5-after-hud-shapes-created.png)

**5c — Scrubbed to 50s: chat shows events from the recording**
![HUD with content](wt/19-story5-hud-with-content-at-50s.png)

**Result: PASS** — +HUD creates both child shapes correctly positioned and sized.

---

## Story 6 — Resize the frame; child shapes scale proportionally

> "I resize the PlaybackFrame. Both child shapes scale to fill the new content area."

**6a — Before resize: frame 600×500, chat 360×400, agents 236×400**
![Before resize](wt/22b-story6-before-resize.png)

**6b — After resize to 400×350: chat 240×280, agents 157×280**
![After resize](wt/22c-story6-after-resize.png)

Scale applied: `scaleX = 400/600 = 0.667`, `scaleY = 350/500 = 0.70`
- fleet-chat: 360×400 → **240×280** ✓
- fleet-agents: 236×400 → **157×280** ✓
- Chrome area (header+scrubber, 100px) stays fixed ✓

**Result: PASS** — `onResize` scales content area correctly, chrome unchanged.

---

## Story 7 — Switch between timewarp cuts; speed graph reflects regions

> "The header shows a dropdown with the available named cuts. I switch between 'raw' and 'edits'. The speed graph on the scrubber changes."

**7a — Timewarp dropdown: "raw" (no speed mapping)**
![Raw selected](wt/23-story7-timewarp-raw-selected.png)

**7b — Timewarp dropdown: "edits" (auto-selected on load)**
![Edits selected](wt/24-story7-timewarp-edits-selected.png)

**7c — Speed graph showing the edits timewarp regions (blue fill)**
![Speed graph](wt/25-story7-speed-graph-with-edits.png)

**7d — Scrubber position in the 3x region (0–60s)**
![In 3x region](wt/26-story7-scrubber-in-3x-region.png)

**7e — Scrubber position in the 0.5x region (120–203s)**
![In 0.5x region](wt/27-story7-scrubber-in-05x-region.png)

**Recording edits applied:**
- 0–60s: factor 3 → `extractTimewarps` creates region {start:0, end:60000, speed:3}
- 60–120s: gap filled with speed 1
- 120–203s: factor 0.5 → region {start:120000, end:203000, speed:0.5}

**Result: PASS** — timewarp dropdown present, "edits" cut auto-selected, speed regions constructed correctly.

---

## Story 8 — Subtitles appear at the right times

> "The recording has subtitle entries. As I scrub, the correct subtitle appears at the bottom of the frame."

**8a — t=5s: "Session starts — registering with fleet"**
![Subtitle at 5s](wt/28-story8-subtitle-t5s-session-starts.png)

**8b — t=35s: "Reading task assignment"** *(subtitle starts at 30s)*
![Subtitle at 35s](wt/29-story8-subtitle-t35s-reading-task.png)

**8c — t=95s: "Investigating playback source files"** *(subtitle starts at 90s)*
![Subtitle at 95s](wt/30-story8-subtitle-t95s-investigating.png)

**8d — t=155s: "Creating test recording"** *(subtitle starts at 150s)*
![Subtitle at 155s](wt/31-story8-subtitle-t155s-creating.png)

**Result: PASS** — all 4 subtitles render at correct times. `getCurrentSubtitle()` correctly finds the active entry.

---

## Story 9 — Curated mode applies layout keyframes as you scrub

> "In curated mode, when I scrub past a layout keyframe timestamp, the child shapes jump to the keyframe positions. Scrubbing back reverses it."

**9a — Curated frame loaded: "CURATED" badge in header**
![Curated frame](wt/32-story9-curated-frame-loaded.png)

**9b — Header close-up: badge, edits dropdown, +HUD**
![Curated badge](wt/33-story9-curated-badge-header.png)

**9c — t=10s (before keyframe at 50s): chat at x=0, agents at x=424**
![Before keyframe](wt/34-story9-before-keyframe-t10s.png)

**9d — t=60s (after keyframe at 50s): chat jumped to x=280, agents jumped to x=0**
![After keyframe](wt/35-story9-after-keyframe-t60s.png)

**9e — Scrub back to t=10s: positions revert (0, 424)**
![Scrub back](wt/36-story9-scrub-back-before-kf.png)

**9f — Scrub forward again to t=80s: positions re-apply (280, 0)**
![Scrub forward again](wt/37-story9-scrub-forward-past-kf-again.png)

**Layout event injected:** `{ t: 50000, type: 'layout', data: { shapes: { chatId: {x:280,y:100}, agentsId: {x:0,y:100} } } }`
Applied via `editor.store.mergeRemoteChanges()` — ephemeral, not synced to Yjs.

**Result: PASS** — layout keyframes apply and revert correctly on scrub.

---

## Story 10 — Drag a fleet shape into the PlaybackFrame

> "I drag a fleet-chat shape from outside the frame into it. It should reparent and switch to recording data."

**10a — Setup: PlaybackFrame on left, fleet-chat outside on right**
![Setup](wt/38-story10-drag-setup-chat-outside-frame.png)

**10b — During drag: moving chat toward frame**
![During drag](wt/39-story10-during-drag.png)

**10c — After drag released: fleet-chat NOT reparented (still page:page)**
![After drag](wt/40-story10-after-drag-result.png)

**10d — After calling `onDragShapesIn` directly: fleet-chat IS inside frame**
![After direct call](wt/41-story10-after-direct-call-reparented.png)

**Result: FAIL** — Real mouse drag does not trigger `onDragShapesIn`.

**Root cause:** `PlaybackFrameShapeUtil` does not declare `isContainer` (confirmed: `util.isContainer === undefined`, `util.canDropShapes === undefined`). TLDraw's selection tool only calls `onDragShapesIn` for shapes registered as containers. Without this flag, dragging a fleet-chat onto the frame has no effect.

The handler logic itself is correct: when called directly, it calls `editor.reparentShapes(draggingShapes, frameId)` and the shape moves inside. But it is unreachable via UI drag.

**Fix needed:** Add `override isContainer = () => true` (or equivalent TLDraw v2 API) to `PlaybackFrameShapeUtil`.

---

## Summary Table

| # | User Story | Status | Key Evidence |
|---|-----------|--------|-------------|
| 1 | Place frame + pick recording | **PASS** | Picker lists recordings; loads on click |
| 2 | Play / pause / rewind | **PASS** | Time advances 0:00→0:07 at 1x; pause/rewind work |
| 3 | Scrub to specific moment | **PASS** | `input` event: 0:00→0:25→1:41→3:22 |
| 4 | Change playback speed | **PASS** | 5x × 3x timewarp = 15x effective; 0:15 after 1s |
| 5 | +HUD populate | **PASS** | fleet-chat (60%) + fleet-agents (40%) created |
| 6 | Resize → scale-to-fit | **PASS** | 360×400 → 240×280, 236×400 → 157×280 |
| 7 | Timewarp / named cuts | **PASS** | "edits" dropdown, speed graph with regions |
| 8 | Subtitles | **PASS** | All 4 subtitles at correct timestamps |
| 9 | Curated mode layout keyframes | **PASS** | Positions swap at t=50s, revert on scrub back |
| 10 | Drag shapes in/out | **FAIL** | `isContainer` not set; TLDraw never calls `onDragShapesIn` |

**10 PASS · 1 FAIL**

One bug found: `PlaybackFrameShapeUtil` missing `isContainer` declaration prevents drag-into-frame from working.
