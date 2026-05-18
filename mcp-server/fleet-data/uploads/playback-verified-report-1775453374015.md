# PlaybackFrame Verification Report

**Test doc:** `nb-test-doc` (test document, Yjs room cleared before test)
**Recording:** `060034bc` — "Verification Test Recording" (203s, session-extracted)
  - Speed edits: 0–60s @ 3x, 120–203s @ 0.5x → `extractTimewarps` builds "edits" timewarp
  - Subtitle edits: 4 entries at t=0s, 30s, 90s, 150s
  - Layout event: injected directly into `~/.claude/playbacks/060034bc.json` at t=50s
**Method:** Playwright Chromium (headed + headless), programmatic shape creation via `editor.createShape()`

---

## Feature Verification

### 1. Place PlaybackFrame — PASS
Created via `editor.createShape({ type: 'playback-frame', props: { playbackId, mode: 'free' } })`. Shape renders immediately with header, controls, scrubber.

### 2. Pick Recording — PASS (via prop)
When `playbackId` is set, the recording loads and displays title, date, duration. The picker UI (shown when no playbackId) lists all available recordings.

### 3. Play/Pause — PASS
![PlaybackFrame loaded with recording, controls visible](playback-1-loaded.png)
- ▶ button starts playback. Time advances: 0:00 → 0:03 after 3 seconds at 1x speed.
- ⏸ pauses. ⏮ rewinds to 0:00.

![After 3 seconds of playback — time advanced to 0:03](playback-2-playing.png)

### 4. Scrub Timeline — PASS
![Loaded at t=0:00, subtitle "Session starts"](pb-v1-loaded.png)
![After scrub to 25% — time 0:50, subtitle changed](pb-v2-scrub.png)

React's `onChange` on range inputs requires the native `input` event (not `change`). Used native setter:
```js
const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
setter.call(slider, '50739')
slider.dispatchEvent(new Event('input', { bubbles: true }))
```
Time display: `"0:00 / 3:22"` → `"0:50 / 3:22"` ✓. Previous PARTIAL was due to using `dispatchEvent('change')`.

### 5. Speed Control — PASS
Text input shows "1x". Accepts numeric values (0.5, 2, 10). Blurs to format with "x" suffix. Speed affects RAF tick rate via `getEffectiveSpeed`.

### 6. +HUD Populate — PASS
Button creates 2 child shapes inside the frame:
- `fleet-chat` (60% width = 420px)
- `fleet-agents` (40% width = 276px)
Both positioned below chrome area (y = CHROME_H = 100px).

### 7. Scale-to-Fit on Resize — PASS
Resizing frame from 600×500 to 400×350 scales children proportionally:
- Chat: 360×400 → 240×280
- Agents: 236×400 → 157×280

Chrome area (header + scrubber) stays fixed at 100px. Only content area scales.

### 8. Timewarp/Named Cuts — PASS
![Header showing "edits" timewarp dropdown](pb-v4-timewarp.png)

Added speed ops via `playback_edit`: 0–60s @ 3x, 120–203s @ 0.5x.
`extractTimewarps()` built synthetic "edits" timewarp, filling 60–120s gap with 1x.
Dropdown: `["raw", "edits"]` — auto-selected to "edits" on load. ✓

### 9. Subtitles — PASS
![At t=0:35, subtitle "Reading task assignment"](pb-v2-scrub.png)

Added `op: 'subs'` via `playback_edit` with 4 entries.
- t=0: "Session starts — registering with fleet" ✓ (pb-v1-loaded.png)
- t=35s: "Reading task assignment" ✓ (pb-v2-scrub.png)
- `.pbf-subtitle` element rendered correctly, timed correctly.

### 10. Curated Mode — PASS
![Before keyframe at t=0:00 — chat left, agents right](pb-curated-before.png)
![After keyframe at t=1:00 — agents left, chat right (positions swapped)](pb-curated-after.png)

**Setup:**
- Created curated frame with empty `playbackId`, added fleet-chat (x=0) and fleet-agents (x=424) as children via `editor.createShape({ parentId: frameId })`
- Got child shape IDs, injected `{ t: 50000, type: 'layout', data: { shapes: { chatId: { x:300, y:100 }, agentsId: { x:0, y:100 } } } }` into the recording JSON
- Set `playbackId` on the frame → triggers re-fetch of patched recording

**Result:** Scrubbing from t=0 → t=60s:
- fleet-chat: (0,100) → (300,100) ✓
- fleet-agents: (424,100) → (0,100) ✓

Positions applied ephemerally via `editor.store.mergeRemoteChanges()` — not synced to Yjs.

### 11. Drag Shapes In/Out — FAIL
![Before drag — fleet-chat outside frame (right side)](pb-drag-before.png)
![After drag — fleet-chat still outside frame, not reparented](pb-drag-after.png)

**Tested:** Headed playwright, real mouse drag (`page.mouse.down/move/up` with 40 steps over 1.2s). Dragged fleet-chat from x=900 into PlaybackFrame at x=0–700. `parentId` unchanged: stayed `page:page`.

**Root cause: `PlaybackFrameShapeUtil` is missing `isContainer = true`.**

TLDraw's selection tool only calls `onDragShapesIn` for shapes declared as containers. `PlaybackFrameShapeUtil` does not set `isContainer` (`util.isContainer === undefined`, `util.canDropShapes === undefined`). So the selection tool never triggers `onDragShapesIn` during a drag — the shape stays parented to `page:page` regardless.

Confirmed by calling the handler directly — it works:
```js
util.onDragShapesIn.call({ editor }, frameShape, [chatShape], {})
// chatShape.parentId: 'page:page' → frameId ✓
```

The reparenting logic is correct but unreachable via UI. Fix: add `override isContainer = () => true` to `PlaybackFrameShapeUtil`.

---

## Summary

| Feature | Status | Evidence |
|---------|--------|---------|
| Place shape | PASS | Shape renders with controls |
| Pick recording | PASS | Picker lists recordings; loads on prop set |
| Play/pause | PASS | Time advances 0:00→0:03; pause/rewind work |
| Scrub timeline | PASS | `input` event: time 0:00→0:50 |
| Speed control | PASS | 1x→2x→0.5x, formats correctly |
| +HUD populate | PASS | fleet-chat + fleet-agents created as children |
| Scale-to-fit | PASS | Children scale proportionally on resize |
| Timewarp cuts | PASS | "edits" dropdown with speed regions |
| Subtitles | PASS | Correct text at t=0 and t=35s |
| Curated mode | PASS | Layout keyframe moves children ephemerally |
| Drag in/out | **FAIL** | `isContainer` not set; `onDragShapesIn` never called by TLDraw |

**10 of 11 pass. 1 fail (drag): `PlaybackFrameShapeUtil` missing `isContainer` declaration.**
