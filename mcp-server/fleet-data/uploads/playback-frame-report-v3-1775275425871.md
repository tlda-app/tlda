# PlaybackFrame — W3a Report (Full Walkthrough)
**Date:** 2026-04-03  
**Branch:** `w3a-playback` worktree  
**Server:** `http://localhost:5194/?doc=balancing-act&token=c5e4726ab77972fc7312f3a703f9cf1c`  
**Bug fixes committed:** `e72f0ab` — drag-to-move, +HUD child placement, child clipping

---

## Overview

PlaybackFrame is a tldraw canvas shape that acts as a DVR for fleet event streams. You place it on the canvas, pick a recording from the fleet API, then scrub or play through the conversation as it unfolded — with chat and agent data filtered to the current playback time. Child shapes (fleet-chat, fleet-agents) live inside the frame and update live as the scrubber moves. Recordings with timewarp edits get a cut selector and jump-snap behavior for fast-forward regions.

---

## 1. Placing a PlaybackFrame

The PlacementTool is accessed by pressing `p` on the canvas. It lives in the toolbar overflow (the `···` menu on the right side of the tldraw toolbar). Pressing `p` activates it immediately — you see a cursor indicator and the toolbar highlights the playback icon.

### Step 1: Clean canvas — before placement

The canvas starts empty (or with other shapes). The PlaybackFrame tool is not yet active.

![Clean canvas](http://localhost:5199/api/files/r01-canvas-clean-1775274075392.jpeg)

A clean tldraw canvas showing the balancing-act paper SVG pages and fleet-chat/fleet-agents shapes already placed. The toolbar is visible at the bottom. No PlaybackFrame exists yet.

### Step 2: PlacementTool active (press `p`)

![Tool active](http://localhost:5199/api/files/r02-tool-active-1775274075430.jpeg)

After pressing `p`, the PlaybackFrame tool activates. The toolbar overflow shows the playback icon highlighted. The cursor signals that the next click will place a frame.

### Step 3: Frame placed — picker appears

After clicking on the canvas, a 500×740 PlaybackFrame appears with a blue tldraw selection border. Instead of a scrubber, it shows the recording picker — a scrollable list of all available recordings from the fleet API.

![Frame placed with picker](http://localhost:5199/api/files/r03-frame-placed-1775274075474.jpeg)

The frame is selected (blue handles visible at corners and edges). Inside it: a header "Pick a recording" and a list of recordings. Each entry shows the recording title and metadata.

### Step 4: Picker zoomed — all 20 recordings

![Picker zoomed](http://localhost:5199/api/files/r13-picker-zoomed-1775274075817.jpeg)

Zoomed in on the picker. The list shows recordings with titles, dates, and durations. Titles visible include "Building Playback: The Full Story", "The Identity Crisis — Director's Cut", "The Identity Crisis — Full Arc", "The Identity Crisis — Extended Cut", and others. All 20 recordings in the fleet API are listed.

---

## 2. Loading a Recording

Clicking any recording in the picker immediately loads it. The picker disappears and the scrubber chrome appears.

### Step 5: "Building Playback: The Full Story" at t=0

![Recording loaded at t=0](http://localhost:5199/api/files/r04-recording-loaded-t0-1775274075509.jpeg)

The scrubber header shows: **"Building Playback: The Full Story"** / **3/8/2026 · 19:29:21** / **+HUD**. The timeline shows 0:00 / 19:29:21 (19 minutes and 29 seconds total duration). The play/pause button shows ▶ (paused). A single early chat message is visible in the content area below.

### Step 6: Scrubber controls close-up

![Scrubber controls](http://localhost:5199/api/files/r19-scrubber-controls-1775274076025.jpeg)

Zoomed in on the header and scrubber row. Left to right: ⏮ (reset to start), ▶ (play/pause), **1x** (speed input — editable text field), then the time display **30:00 / 19:29:21** at the far right. Below: the range slider thumb sitting at ~43% of the track. The date, duration, and +HUD button are in the header row above.

### Step 7: Frame at t=0 with drop zone

![Frame at t=0](http://localhost:5199/api/files/r17-frame-t0-1775274075956.jpeg)

At t=0 the frame has no child shapes yet (no +HUD clicked). The content area shows a single chat message from the very beginning of the recording: a web→agent message about target swap / filter change. The drop zone (dashed border with "drag shapes here" text) is visible when no children are present.

---

## 3. Seeking

Dragging the range slider seeks instantly — chat messages filter in real-time to show only events with `t ≤ currentMs`.

### Step 8: t=10:00

![t=10:00](http://localhost:5199/api/files/r06-t10min-1775274075573.jpeg)

At 10 minutes: "Spawned a new agent" and "Done reporting to manager" messages appear. Early coordination traffic — the session is still warming up.

### Step 9: t=20:00

![t=20:00](http://localhost:5199/api/files/r07-t20min-1775274075608.jpeg)

At 20 minutes: task list messages appear — "Port router tabs from mini-tab to fleet". The conversation has progressed to concrete implementation work.

### Step 10: t=30:00 — key moment

![t=30:00 — substantive dialogue](http://localhost:5199/api/files/r08-t30min-key-1775274075643.jpeg)

At 30 minutes: the first substantive product discussion. Messages include a long exchange about PhD students, HCI/STS research, and the journalistic/academic use case for fleet logs. This is the richest content in the recording and clearly demonstrates that real conversation data is playing back correctly.

### Step 11: Full frame at t=30 with HUD panels

After seeking to t=30:00, the frame shows the scrubber at mid-position with real conversation content visible in the fleet-chat child panel.

![Full HUD at t=30](http://localhost:5199/api/files/r15-hud-30min-full-1775274075891.jpeg)

The frame with both +HUD panels active at t=30:00. Left (fleet-chat): messages including "There's really compelling use case for studying human-agent collaboration." Right (fleet-agents): 5 agents listed from the recording.

---

## 4. Playing

Clicking ▶ starts real-time playback. The timer advances at 1x speed (or the configured speed multiplier), and child shapes update continuously.

### Step 12: Playback started — scrubber advancing

![Playing at 30:04](http://localhost:5199/api/files/r23-playing-started-1775274083401.jpeg)

The play button changed to ⏸ (pause). The time display shows **30:04 / 19:29:21** — the scrubber is advancing in real time. Content in the chat panel continues to show messages up to t=30:04.

### Step 13: 15 seconds later — new content appears

![Playing at 30:19](http://localhost:5199/api/files/r24-playing-t3015-1775274083449.jpeg)

At t=30:19, new messages have appeared that weren't visible at t=30:04. The fleet-agent's response is now visible: a detailed status breakdown with "DONE: working in dashboard now" / "DONE / NEEDS WORK" / "NOT VERIFIED" lists. This proves the content is updating live as playback advances.

---

## 5. +HUD Layout

Clicking "+HUD" creates two child shapes inside the frame: a fleet-chat (60% width) on the left and a fleet-agents (40% width) on the right. Both start at y=CHROME_H (100px below the chrome), filling the remaining height.

### Step 14: Before +HUD (bare scrubber)

![Frame at t=0 scrubber only](http://localhost:5199/api/files/r14-scrubber-t0-1775274075855.jpeg)

The frame with only the scrubber chrome — no child shapes. The drop zone shows "drag shapes here" below the chrome.

### Step 15: +HUD clicked — both panels at t=30:00

![HUD full frame t=30](http://localhost:5199/api/files/r20-hud-t30-full-frame-1775274076058.jpeg)

After clicking +HUD at t=30:00. The frame now contains two child shapes. Left: fleet-chat with messages up to t=30:00. Right: fleet-agents showing 5 agents from the recording. The scrubber still shows **30:00 / 19:29:21** confirming the HUD launched with playback at 30 minutes.

### Step 16: Fleet-chat panel zoomed — real messages

![Chat panel t=30](http://localhost:5199/api/files/r21-chat-panel-t30-1775274083224.jpeg)

Zoomed into the fleet-chat panel at t=30:00. Visible text: the full PhD students / HCI/STS / journalistic project exchange. Then: "That's a really compelling use case for data for studying human-agent collaboration, field notes you have the actual interaction logs, annotatable. Researchers could scrub through annotate decision points, compare workflows…" Followed by "yeah, i mean not just scrub but we have search, agent assistance, etc." This is real, readable conversation content — not placeholder data.

### Step 17: Fleet-agents panel zoomed

![Agents panel t=30](http://localhost:5199/api/files/r22-agents-panel-t30-1775274083361.jpeg)

The fleet-agents panel showing 5 agents from the recording: 1fce0d07-e337..., 9ca10f70-6c7c..., 77cfbc4c-2ff7..., c88bafbf-47e8..., bbb1535e-bb4e... — all with "1m" as last-seen timestamps (the playback context provides synthetic last_seen timestamps so the agents list renders as if they're active). Columns: AGENT / SEEN / TASK / LABELS.

### Step 18: Layout while playing

![Layout while playing](http://localhost:5199/api/files/r33-layout-while-playing-1775274083858.jpeg)

The frame at t=30:12 while **actively playing** (⏸ visible in the controls). The chat and agents panels are visible and updating in real time. Child shapes can be repositioned — dragged, resized — while playback runs without interrupting the timeline. This is the "layout while playing" use case: the user can rearrange fleet-chat shapes to fit their reading flow without pausing.

---

## 6. DNF Filters in Playback Mode

Fleet-chat shapes support DNF (disjunctive normal form) filters — compound boolean expressions that restrict which messages appear. The same filter system applies inside a PlaybackFrame: `fleet-data-adapter` detects the frame context and routes `getPlaybackChatEvents(data, dnfFilter)` instead of the live SSE feed.

### Step 19: Canvas-level filtered fleet-chat

![DNF filter applied](http://localhost:5199/api/files/r34-dnf-filter-chat-1775274083908.jpeg)

A canvas-level fleet-chat with filter `[[["from","refactor-lead"]], [["to","refactor-lead"]]]` applied. The visible messages are exclusively from/to the refactor-lead agent — the DNF filter is working. This is the same mechanism used inside a PlaybackFrame.

### ⚠️ Bug: Filtered fleet-chat inside PlaybackFrame crashes

**Reproducible:** Creating a fleet-chat with a non-empty `filter` prop as a child of a PlaybackFrame causes a Yjs validation crash. The error:

```
ValidationError: At shape(type = fleet-chat).props.filter.0.0: Expected an array, got a string
```

The filter schema in the worktree is `T.arrayOf(T.arrayOf(T.arrayOf(T.string)))` — triple-nested, matching the working copy. Despite this, when the shape is synced through Yjs to the working copy server and back, the validation fails and tldraw's error boundary fires.

**Impact:** Users cannot create filtered fleet-chat shapes inside a PlaybackFrame via the normal UI or programmatically. The filter editing UI that appears on a fleet-chat inside a frame would also write a filter that triggers this crash.

**Not a blocker for unfiltered use:** Fleet-chat shapes with `filter: []` (the default) inside PlaybackFrame work correctly.

---

## 7. Timewarp / Named Cuts

Recordings that have `edits` with `op: "timewarp"` entries get a cut selector dropdown in the header. The active timewarp defines speed regions — regions with speed >100x are treated as jump-snap zones that teleport the scrubber past them instantly during playback.

### Step 20: Director's Cut loaded

After switching the frame's `playbackId` to the Director's Cut recording:

![Director's Cut loaded](http://localhost:5199/api/files/r26-timewarp-loaded-1775274083493.jpeg)

Header: **"The Identity Crisis — Director's Cut"** / **3/10/2026 · 11:14:27** / **Directo▾** (cut selector) / **+HUD**. Scrubber: 0:00 / 11:14:27. The recording is 11 hours 14 minutes — the full session including all gap time. The cut selector shows "Directo" (truncated "Director's Cut (~43 min)") indicating the active timewarp.

### Step 21: Cut selector dropdown open

![Cut selector open](http://localhost:5199/api/files/r27-cut-dropdown-open-1775274083553.jpeg)

The dropdown shows three options:
- **raw** — no timewarp, full 11:14:27 duration, plays at base speed
- **Director's Cut (~43 min)** (currently selected, highlighted) — timewarp with speed regions that compress the session to ~43 minutes
- **Constant Pace (~47 min)** — a different timewarp with uniform pacing

Selecting a different option instantly updates the active timewarp and resets the scrubber.

### Step 22: t=29:57 — before the jump region

![t=29:57](http://localhost:5199/api/files/r28-tw-t2957-1775274083591.jpeg)

Seeked to 29:57 in the Director's Cut. The scrubber thumb is at ~4.4% of the 11-hour timeline. The chat shows messages from the Identity Crisis session at this point: the "HCI/STS as journalistic project" discussion, use case brainstorming.

### Step 23: After the timewarp jump — t=1:01:17

Starting playback at t=29:57, the scrubber hits the >100x jump region (a long gap in the session). The jump-snap fires: instead of playing through 31 minutes of silence, the scrubber teleports.

![After jump at t=1:01:17](http://localhost:5199/api/files/r29-tw-after-jump-1775274083631.jpeg)

The scrubber now shows **1:01:17 / 11:14:27** — jumped from 29:57 to over an hour in. In real time, 4 seconds elapsed. The chat panel now shows all messages up to t=1:01:17, which includes 31+ more minutes of accumulated conversation than was visible at t=29:57.

### Step 24: Chat content at t=1:01:17

![Chat at 1:01:17](http://localhost:5199/api/files/r30-tw-10117-chat-1775274083676.jpeg)

Zoomed chat at t=1:01:17. Messages include agent status reports: "ok, give me a pruned version that is fleet stuff only and excludes stuff that's been done already", followed by a detailed status breakdown of done/in-progress/unverified items. This is a different message set than t=29:57 — the timewarp jump correctly advanced the content.

### Curated mode — layout keyframes

The PlaybackFrame code has full support for `type: "layout"` events in the recording data — events that carry `data.shapes: { [id]: { x, y } }` and cause the HUD child shapes to reposition automatically at the keyframe time. The `getLayoutKeyframe()` function in `playback-context.ts` is implemented and wired in `PlaybackFrameShape.tsx`.

**However:** No current recordings in the fleet include layout keyframe events. This feature is ready to use but has not yet been exercised by any recorded session. Screenshots of layout keyframes are not available.

---

## 8. Moving the PlaybackFrame

PlaybackFrame is a standard tldraw shape — it can be dragged anywhere on the canvas. The three bug fixes in `e72f0ab` restored this: the root container now uses `pointerEvents: none` so tldraw can detect pointer events on the shape's non-interactive areas and handle drag-to-move.

### Step 25: Canvas overview — frame at original position

![Canvas before move](http://localhost:5199/api/files/r31-canvas-before-move-1775274083726.jpeg)

Zoomed out to 45% zoom. The PlaybackFrame (top center) shows "The Identity Crisis — Director's Cut" at t=1:01:17 next to the balancing-act paper pages. The paper's "The Balancing Act in Causal Inference" title and abstract are fully visible — the frame sits naturally alongside the paper content.

### Step 26: Frame moved to new position

After dragging the frame to the right:

![Canvas after move](http://localhost:5199/api/files/r32-canvas-after-move-1775274083801.jpeg)

The frame has moved to x=1100, y=200 — now positioned to the right of the paper, alongside the Introduction section. The scrubber still shows t=1:01:17 and "Director's Cut". Playback state is fully preserved across repositioning. The child shapes (fleet-chat, fleet-agents) move with the frame and continue displaying the correct filtered content.

---

## 9. Drag Shapes Into Frame

PlaybackFrame implements `onDragShapesIn` in the shape util — when a shape is dragged onto the frame on the canvas, it gets reparented as a child. The +HUD button is a shortcut, but any fleet-chat or fleet-agents already on the canvas can be dragged directly into the frame's bounds. On drop, tldraw reparents the shape, and its `useFleetEvents` hook detects the new `frameId` and immediately switches from live SSE to playback-filtered data.

### Step 27: Before drag — standalone fleet-chat on canvas

A fleet-chat shape exists on the canvas (not inside any PlaybackFrame) near the frame. It shows live fleet data — whatever the current chat activity is.

![Drag before — standalone shape on canvas](http://localhost:5199/api/files/r38-drag-before-1775274983921.jpeg)

Canvas at 55% zoom. The PlaybackFrame is visible top-right showing "Building Playback: The Full Story" at t=30:00. A standalone fleet-chat shape (center, showing live message content) sits on the canvas adjacent to the frame. The user is about to drag it into the frame.

### Step 28: After drag — shape now inside frame, showing playback content

After dropping the fleet-chat onto the frame:

![Drag after — shape reparented, showing playback](http://localhost:5199/api/files/r39-drag-after-1775274984253.jpeg)

The fleet-chat is now a child of the PlaybackFrame. Three panels are visible inside the frame: the original fleet-chat (top-left), fleet-agents (top-right), and the newly dragged fleet-chat now occupying the bottom half — showing the same playback-filtered messages as the other chat panel at t=30:00. The transition from live to playback happens automatically when parentage changes.

---

## 10. Multiple Panels

The frame imposes no limit on child shapes. Users can start with 0 panels (bare scrubber + drop zone), add +HUD to get 2, and then drag in additional shapes to build denser layouts.

### Step 29: 1 panel — fleet-chat only, full width

Before adding agents, the fleet-chat can fill the entire content area. This is useful when only message content matters.

![1 panel — fleet-chat full width](http://localhost:5199/api/files/r35-one-panel-1775274983353.jpeg)

Single fleet-chat at 500px wide filling the frame's content area. At t=30:00, the rich HCI/STS discussion is fully readable: "I want to make a demo recording for fleet and liza and their interop. But like, i really don't want to sit down and rehearse a fake interaction… So an askthedoc-meets-[tool] for study workflows." The agents panel is not present — full width gives more room for long messages.

### Step 30: 2 panels — after +HUD

![2 panels — chat + agents](http://localhost:5199/api/files/r36-two-panels-1775274983504.jpeg)

The standard +HUD layout: fleet-chat (60% / 300px wide) on the left with the same conversation content, fleet-agents (40% / 196px wide) on the right with all 5 recording agents listed. Both panels are at t=30:00.

### Step 31: 3 panels — second fleet-chat dragged in

A second fleet-chat dragged in and positioned below the existing panels. The frame now has three child shapes.

![3 panels — chat, agents, second chat](http://localhost:5199/api/files/r37-three-panels-1775274983641.jpeg)

Three panels inside the frame: original fleet-chat (top-left, 300×320), fleet-agents (top-right, 196×320), and a full-width fleet-chat below (500×318). Both fleet-chat panels independently show playback-filtered content at t=30:00 — same conversation, same filter (none in this case). In a real workflow the bottom panel might have a different filter to show a focused view while the top panel shows everything.

---

## 11. Speed Control

The speed input (the editable "1x" field next to the play button) accepts any positive number. Changing it multiplies the real-time playback rate — 2x plays at twice real speed, 0.5x at half speed.

### Step 32: Speed set to 2x

![Speed 2x](http://localhost:5199/api/files/r40-speed-2x-1775274984669.jpeg)

The speed field shows **2** (changed from the default 1x). The timeline still shows 30:00 / 19:29:21. Starting playback from here will advance the scrubber at 2 seconds per real second. The field is a simple text input — clicking it clears the "x" suffix so you can type a new value, then pressing Enter or blurring confirms.

---

## 12. Timewarp Header — Close-up

### Step 33: Director's Cut header at 1.8x zoom

![Curated badge close-up](http://localhost:5199/api/files/r41-curated-badge-1775274985135.jpeg)

Zoomed to 1.8x on the scrubber. Header: **"The Identity Crisis — Director's Cut"** / **3/10/2026 · 11:14:27** / **"Directo▾"** (the cut selector as a styled dropdown button) / **"+HUD"**. Controls row: ⏮ ▶ **2** (speed retained from earlier) / **0:00 / 11:14:27**. The cut selector button ("Directo▾") is the visual signal that this recording has timewarp edits — no cut selector appears on recordings without edits.

---

## 13. Multiple Recordings

The picker is always accessible by loading a new `playbackId` into the frame props. In practice, the user clicks a "change recording" UI or loads from the picker by selecting a different title.

### Step 27: Identity Crisis — Director's Cut header

![Director's Cut scrubber](http://localhost:5199/api/files/r26-timewarp-loaded-1775274083493.jpeg)

A different recording ("The Identity Crisis — Director's Cut") loaded into the same frame. Header shows the new title, new date (3/10/2026), new duration (11:14:27), and the cut selector dropdown indicating a timewarp is active.

---

## Files Changed

| File | Change |
|------|--------|
| `src/shapes/PlaybackFrameShape.tsx` | Bug fix #1: outer HTMLContainer `pointerEvents: none`; bug fix #2: +HUD creates children at correct y=CHROME_H with 60/40 split; bug fix #3: added `getClipPath()` returning VecLike[] polygon |
| `src/shapes/PlaybackFrameShape.css` | No changes needed |
| `src/playback-context.ts` | No changes — `getPlaybackChatEvents(data, dnfFilter)` already wired correctly |
| `src/fleet-data-adapter.ts` | No changes — already passes filter through to playback context |

## Bug Summary (from `e72f0ab`)

1. **Drag to move** — Fixed: `HTMLContainer` now uses `pointerEvents: none` on the outer container; only scrubber controls get `all`. TLDraw can now detect pointer events on the frame body and handle drag-to-move correctly.

2. **+HUD child placement** — Fixed: children now created at `y=CHROME_H` (100px), fitting inside the frame bounds. Old code placed fleet-agents at `x: w + 8` (outside the frame).

3. **Child clipping** — Fixed: `getClipPath()` now returns `VecLike[]` point array (tldraw expects polygon corners, not SVG path string). Children are clipped to the frame's rectangular bounds.

## Open Bug (not fixed in this branch)

**Filtered fleet-chat inside PlaybackFrame → Yjs validation crash.** Creating a fleet-chat child with a non-empty `filter` prop causes a `ValidationError` in tldraw's store. Despite the filter schema matching (`T.arrayOf(T.arrayOf(T.arrayOf(T.string)))` in both worktree and working copy), the Yjs sync round-trip fails validation. Root cause not yet identified — likely a shape versioning or Yjs update application order issue. Workaround: fleet-chat children work correctly with `filter: []`; users can set filters after the fact via the filter editing UI, but this also triggers the crash.
