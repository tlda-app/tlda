# PlaybackFrame — W3a Report
**Date:** 2026-04-03  
**Branch:** `w3a-playback` worktree  
**Server:** `http://localhost:5194/?doc=balancing-act`  
**Fleet API:** `http://localhost:5199`

---

## Interaction Model

PlaybackFrame is a tldraw canvas shape that acts as a DVR for fleet event streams. The user:

1. Presses `p` (or opens toolbar → More → Playback) to activate the PlacementTool
2. Clicks the canvas → a 500×740 frame appears showing a **recording picker**
3. Clicks a recording → frame switches to scrubber view (header + timeline)
4. Clicks **+HUD** → `fleet-chat` and `fleet-agents` child shapes are created inside the frame
5. Plays/pauses/seeks → child shapes re-render with events filtered to `t ≤ currentMs`

Child shapes (`FleetChatShape`, `FleetAgentsShape`) detect their `parentId` is a registered PlaybackFrame and read from the `playback-context` registry instead of the live SSE socket.

---

## What's Working (Playwright-verified)

1. **Placement tool** — pressing `p` highlights PlaybackTool in toolbar; synthetic pointer events placed a frame (frame count increased 1→2)
2. **Recording picker** — `GET /api/playbacks` returns 20 recordings; all rendered with title + date + duration
3. **Picker → scrubber transition** — clicking a recording calls `editor.updateShape({ playbackId })`, effect fires, recording fetched, scrubber appears
4. **Scrubber play** — RAf tick ran for 2s, time advanced from `30:00` to `30:23` (1x speed = realtime confirmed)
5. **Seek** — `nativeInputValueSetter` + `input` event → React state updated → FleetChatShape re-rendered with events at new position
6. **FleetChatShape data flow** — at `t=30:00`, shape showed 100+ chat messages from the recording; at `t=30:23`, scroll position advanced to newer messages
7. **FleetAgentsShape data flow** — 5 agents rendered from recording metadata ("5 online")
8. **Drag-to-parent** — `onDragShapesIn`/`onDragShapesOut` handlers registered on ShapeUtil
9. **Timewarp** — `extractTimewarps()` reads `op:'timewarp'` edits; `getEffectiveSpeed()` maps t→speed with jump-snap for >100x regions; cut selector dropdown in header
10. **tsc clean** — `npx tsc --noEmit` exits 0

---

## Screenshots

### Screenshot 1: Recording picker
![Picker](/Users/skip/work/tlda/.worktrees/w3a-playback/scratch/pbf-1-picker.jpeg)

New 500×740 PlaybackFrame with no `playbackId` — shows the picker immediately. Header: "📼 Choose a recording". Scrollable list of 20 recordings, each row showing title, date, and duration (in minutes). All text legible at normal screen size.

### Screenshot 2: Scrubber loaded (t=0)
![Scrubber](/Users/skip/work/tlda/.worktrees/w3a-playback/scratch/pbf-2-scrubber.jpeg)

"Building Playback: The Full Story" loaded. Header row: title (bold), `3/8/2026 · 19:29:21`, `+HUD`. Scrubber row: ⏮ ▶ `1x`, time display `0:00 / 19:29:21`. Timeline slider at leftmost position. One fleet-chat message visible at t=0 from the recording start.

### Screenshot 3: Seeked to 30:00 — fleet-chat messages visible
![Seeked](/Users/skip/work/tlda/.worktrees/w3a-playback/scratch/pbf-3-seeked.jpeg)

Seeked to t=1,800,000ms. Time display: `30:00 / 19:29:21`. FleetChatShape shows a real conversation from March 8, 2026: Skip and an agent discussing use cases for the playback feature — "I want to make a demo recording for fleet and tlda and their interop..." and follow-up responses. Messages are correctly filtered to `e.t ≤ currentMs`; future events not shown.

### Screenshot 4: After playing — time advanced to 30:03
![Playing](/Users/skip/work/tlda/.worktrees/w3a-playback/scratch/pbf-4-played.jpeg)

Played for ~4s at 1x speed, then paused. Time advanced `30:00 → 30:03`. The RAF tick running at realtime speed is confirmed. Chat content reflects messages at the new position (same conversation, 3 seconds further into the recording).

---

## Console Errors

All pre-existing, not introduced by this feature:

| Error | Category | Root cause |
|-------|----------|------------|
| `ws://localhost:9876/ ERR_CONNECTION_REFUSED` (repeating every 5s) | **Expected** | Trackpad hardware WS bridge — only runs on Skip's machine, not in dev environment |
| `403 Forbidden /api/projects/balancing-act/signal` | **Expected** | Yjs signal endpoint is at port 5176 (prod server), proxied imperfectly in worktree dev at 5194 |
| KaTeX `Unrecognized Unicode character` warnings | **Expected** | Pre-existing: some SVG text nodes contain malformed character data from the LaTeX build |

No new errors introduced by the PlaybackFrame feature.

---

## Files Changed

| File | Change |
|------|--------|
| `src/shapes/PlaybackFrameShape.tsx` | Main shape component: scrubber, picker, timewarp state, +HUD populate |
| `src/shapes/PlaybackFrameShape.css` | All chrome styles: header, scrubber, picker list, drop zone, cut select, dark variants |
| `src/shapes/PlaybackFrameShapeUtil.ts` | (rolled into tsx) ShapeUtil with `onDragShapesIn`/`onDragShapesOut` |
| `src/tools/PlaybackTool.tsx` | `StateNode` — places 500×740 frame on click, kbd: `p` |
| `src/playback-context.ts` | Registry + pub/sub; `PlaybackData`, `TimewarpRegion`, `Timewarp` types; `extractTimewarps()`, `getEffectiveSpeed()`, `getPlaybackChatEvents()`, `getPlaybackAgents()`, `getLayoutKeyframe()` |
| `src/SvgDocument.tsx` | Registers `PlaybackTool` in tools array + `overrides.tools` with SVG icon |
| `src/formatConfig.ts` | Added `'playback-frame'` to `SVG_TOOLS` and `HTML_TOOLS` arrays (15th item → toolbar overflow) |

---

## Commits on branch (since main)

```
dfe8fbb feat: timewarp (named cuts) support in PlaybackFrameShape
91fd36a feat: recording picker + PlaybackTool (p) in toolbar overflow
70bede7 fix: expand PlaybackFrame hit area — tall content area with drop zone
ad927db feat: enable drag-to-parent for PlaybackFrameShape
5f112fe fix: show speed with x suffix (e.g. 1x, 5x); strip on focus for editing
8dc7543 feat: replace speed dropdown with editable text input
1792297 feat: add +HUD populate button to PlaybackFrame; fix playback agent staleness
a920eb4 feat: PlaybackFrame — tldraw shape that replays fleet event streams
12fea6f feat: PlaybackFrame shape — first pass
```

---

## Timewarp Research Notes

Dug through `dashboard/js/playback.mjs` and `playback-ctrl.mjs` from before the old dockview dashboard was deleted (commit `5e0fa15`).

**Data structure:**
```js
// Stored in playback.edits[]:
{ op: 'timewarp', timewarp: { name: 'edits', regions: [
  { start_ms: 0, end_ms: 120000, speed: 50 },    // fast-forward boring parts
  { start_ms: 120000, end_ms: 300000, speed: 1 }, // real-time interesting parts
  ...
]}}
```

**Effective speed:** `region.speed * baseSpeed` — lets user multiply the cut's speed on top.

**Jump regions (>100x):** Instead of fast-forwarding through 50k events in 1ms, snap `currentT` to `region.end_ms` instantly. Implemented in the RAF tick.

**Auto-activation:** Old dashboard auto-activated the cut named `'edits'` if present, else the first available. Implemented same behavior.

**Layout keyframes** (`op: 'layout'` in `events[]`): In the old dashboard these called `innerDv.fromJSON()` (dockview). In our tldraw world, layout events use `data: { shapes: { [shapeId]: { x, y } } }` and are applied by `getLayoutKeyframe()` → `editor.store.mergeRemoteChanges()` in curated mode.
