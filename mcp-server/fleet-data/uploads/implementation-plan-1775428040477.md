# Implementation Plan

Get everything done with minimum testing overhead. Each item gets fully implemented THEN tested once. No test-fix-test cycles on half-built features.

**Process for each item:**
1. Agent audits current state (screenshot, describe what exists)
2. Agent implements fully — complete, not partial
3. Agent tests their own work thoroughly (playwright, real interactions)
4. Agent writes a report with evidence
5. ONE round of QA (watchdog reviews the report)
6. Merge to main

All work in worktrees. Nothing touches main until it's fully done and tested.

---

## Phase 1 — Fix what's broken right now

These are things actively hurting you. Quick fixes, high impact.

### 1a. Chat auto-scroll
**What's broken:** New messages don't scroll into view. You manually scroll to read new messages.
**Scope:** Small — find the scroll handler, make it scroll to bottom on new message unless user has scrolled up.
**Agent:** 1 sonnet, ~30 min
**Test:** Send 20 messages, confirm chat stays at bottom. Manually scroll up, confirm it stops auto-scrolling. New message arrives, confirm it shows a "new messages" indicator or scrolls back.

### 1b. Voice text injection
**What's broken:** After Enter-send, old text reappears in textarea. Voice state doesn't reset cleanly on Enter or chat switch.
**Scope:** Medium — voice state machine needs Enter to do a full reset (stop recognition, clear state, restart). Same reset on chat switch.
**Agent:** 1 opus in worktree
**Test:** Real speech via fake audio device in playwright. Send 5 messages in a row. Switch chats mid-recording. Verify no old text appears, no state corruption. One test run, not iterative.

### 1c. balancing-act broken doc
**What's broken:** playback-frame ValidationError in Yjs store prevents loading.
**Scope:** Small — delete the bad shape from the Yjs store, or wipe the store for that doc.
**Agent:** 1 sonnet, ~10 min
**Test:** Doc loads.

---

## Phase 2 — Deploy what's already built

These are done but sitting in worktrees. Need review + merge.

### 2a. HUD layout mode
**Where:** Worktree `hud-layout-v3`
**What it does:** Button toggles layout mode, transient container, proportional resize, per-shape movement. Matches your final spec.
**Action:** You review the screenshots (already in `scratch/hud-layout-{1,2,3,4}.png`). If it looks right, merge. If not, specify what's wrong.
**Test after merge:** Open tlda, click layout button, resize container, move a shape, exit layout mode. One pass.

### 2b. HUD drag clamping fix
**Where:** Worktree `w7-hud-layout-v2`, commit `09cb82f`
**What it does:** Adds viewport clamping so you can't drag the HUD off-screen.
**Action:** This should merge AFTER layout mode (2a), since layout mode may change how drag works. Or skip it if layout mode handles positioning differently.

---

## Phase 3 — Finish partially-built features

Each needs an audit-first agent that reports what exists before coding.

### 3a. Chip improvements (5 items from weekend-plan)
**Items:**
- Text-field restriction (pills only insert on text input drop)
- Unique tokens (no collisions for same-agent chips)
- Hover content (fix identical previews)
- Two-chip rendering bug
- Impossible filter indicator

**Scope:** Medium — 5 distinct fixes, all in chat-render / FleetChatShape
**Agent:** 1 opus, audit first then implement all 5
**Test:** One round after all 5 are done. Drag pill to input vs non-input. Hover two chips from same agent. Create impossible filter. Verify all 5.

### 3b. Filter/drag separation
**What's needed:** Dragging labels onto chat should NOT pop up the filter overlay in the same space as chat. Filtering is a separate action — it needs its own UI location.
**Scope:** Medium — redesign where filters live
**Agent:** 1 opus, propose design first (screenshot mockup or description), get your approval, then implement
**Test:** Drag label onto chat — filter applies without overlay blocking chat. Drag content onto chat — inserts chip. The two actions are visually and spatially distinct.

### 3c. Iframe auto-conversion kill (corrected-specs.md item)
**What's needed:** tlda URLs typed in message text shouldn't auto-convert to iframes. One render path for everything.
**Scope:** Small-medium
**Agent:** Can be part of 3a chip work
**Test:** Type a tlda URL in chat. Verify it renders as a ref-chip, not an iframe.

---

## Phase 4 — New features (not started)

### 4a. Behavior watchdog improvements
**Already running:** watchdog agent wiretapping skip traffic.
**What's needed:** See if it actually works. If it intervenes too much or too little, tune it.
**Action:** Monitor for a day, adjust.

### 4b. Health monitoring
**What's needed:** Single view of all service status (tlda, whisper, fleet, Yjs). Auto-restart on crash. `tlda doctor` that checks everything.
**Agent:** 1 opus
**Test:** Kill tlda server. Verify it auto-restarts or at minimum shows a visible alert. Run `tlda doctor`, verify it reports the dead service and offers to fix it.

### 4c. Task inbox
**What exists:** v1 built by task-inbox agent, never reviewed.
**Action:** You look at it. If it's close, iterate. If it's wrong, spec what's different.

### 4d. Soft/hard interrupts from chat
**What's needed:** Esc on empty chat input = soft interrupt (like terminal). Double-Esc = hard interrupt.
**Scope:** W6 spec exists and was merged. Need to verify it actually works.
**Agent:** Audit only — check if the merged W6 code works as specced.

### 4e. Gesture implementation
**What's needed:** Whistle + hiss detection on clickDetect.ts. Research is done.
**Scope:** Small — ~20 lines each per the research report
**Agent:** 1 sonnet
**Test:** Make a whistle sound, verify detection fires. Make a hiss, verify continuous signal.

---

## Phase 5 — Someday

- Per-user layout persistence
- Device mapping (iPad = viewer, laptop = editor)
- Cursor/presence indicators
- Annotation ownership display
- Figure rendering fidelity (stacked `\\[-6ex]`)
- Resizable front-of-canvas panels
- Sandboxed QA (Docker/OrbStack)
- Diff highlights using shadow repo

---

## Priorities

You said: voice > HUD > browser tools (done) > task inbox > chips > gestures.

Updated for current state:

1. **Fix broken things** (1a chat scroll, 1b voice injection, 1c balancing-act) — immediate
2. **Deploy built things** (2a layout mode, 2b drag clamping) — your review needed
3. **Finish chips** (3a-c) — one agent, one pass
4. **Health monitoring** (4b) — prevents future infrastructure nightmares
5. **Task inbox** (4c) — your review needed
6. **Everything else** — as bandwidth allows
