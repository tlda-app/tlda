# Skip's Task Inbox — Spec

## Problem

Skip is the only person in the fleet system without a structured task view. Every agent has `my_task()` — a clear "here's what you're doing, here's what's waiting." Skip has chat scrolling by, and has to manually hunt down files, click play on playbacks, cross-reference screenshots, and navigate to approve or reject work.

The result: Skip becomes the bottleneck at every review step, doing mechanical work (find file, open it, click play, go back to chat, type "merge") that should be automatic. Agents interrupt him with chat messages while he's working. The merge gate (which exists to prevent rubber-stamping) costs him too much attention, making it tempting to skip.

## What Skip needs

A **task inbox** — not chat, not a CLI tool. A dashboard view where completed work arrives, plays itself, and waits for a one-tap decision.

### Core behavior

1. **Auto-queuing.** When an agent's work passes QA, it enters Skip's inbox. No notification needed — it's just there when he looks.

2. **Auto-advancing.** The inbox shows one task at a time. Playback runs automatically. When Skip approves or rejects, the next task loads and plays. No clicking "open," no navigating.

3. **Inline evidence.** Each inbox item shows:
   - What was requested (task description from `delegate()`)
   - Who did it (agent name)
   - QA notes (haiku + opus assessments)
   - Playback recording — auto-playing, inline, with subtitles/annotations
   - Files changed (summary)

4. **One-tap decisions.** Two buttons: **Approve** (triggers merge) and **Reject** (sends back to agent with optional note). That's it. No "open in terminal," no "check the branch," no "run playwright yourself."

5. **Passive by default.** The inbox accumulates while Skip is away or in DND mode. No interruptions. He reviews when he's ready, at his pace.

### What this replaces

| Before | After |
|--------|-------|
| Agent chats "done" → Skip reads chat → finds report → opens screenshots → cross-references → types "merge" in terminal | Task appears in inbox → playback auto-plays → Skip taps approve |
| Manager presents work in chat (scroll, scroll, scroll) | Inbox item has everything inline, structured |
| Skip hunts for evidence files | Evidence is embedded in the inbox item |
| Interruptions while working | Items queue silently, reviewed on Skip's schedule |

## Not needed

- **No DND mode** — there are no notifications or sounds in the current system, so nothing to suppress. Chat only scrolls if you're looking at it.
- **No playback iframe** — playback is already a TLDraw shape. It doesn't need to be embedded in another website. It just lives on the canvas like any other shape.

## The inbox as a TLDraw view

The inbox is a view on the fleet dashboard canvas — not a separate website or panel. It's a list of task cards (TLDraw shapes) that queue up as work completes.

Each card shows:
```
┌─────────────────────────────────────┐
│ Task: Resizable viewer panels       │
│ Agent: ui-lead                      │
│ QA: haiku ✓  opus ✓                 │
│                                     │
│ [playback shape — auto-playing]     │
│                                     │
│ Files: SvgDocument.tsx (+42 -8)     │
│        PanelResize.tsx (new)        │
│                                     │
│   [ Approve ]    [ Reject ▾ ]       │
└─────────────────────────────────────┘
```

- Playback is a regular playback shape embedded in the card — auto-plays when the card is active
- Auto-advance: approve/reject moves to the next card
- Reject dropdown: "reject with note," "reject — redo," "reject — talk to me first"

## Playback as verification standard

Playbacks replace screenshots as the primary evidence for app tasks:

- Agent records a warped playback showing the actual user flow
- Playback has subtitles: "clicking resize handle," "dragging to 400px," "reloading page," "panel persists"
- The playback IS the test — it's hard to fake a real interaction sequence
- Screenshots are supplementary, not primary

The playback auto-plays in the inbox card. Skip watches 30 seconds, sees it work (or doesn't), taps approve/reject.

## Implementation notes

- The inbox reads from the existing task/state system — tasks with status "awaiting_review" (or a new status like "awaiting_skip")
- Approve triggers: merge the worktree branch to main, notify agent, update task status
- Reject triggers: notify agent with rejection reason, task goes back to "in_progress"
- Playback: use existing playback shape infrastructure — it's already a TLDraw shape, just place it in the card
- No new iframe, no new website — this is shapes on the existing dashboard canvas

## What this enables

- Skip reviews work passively — watch and tap, not hunt and click
- Merge gate stays enforced without being a burden
- Agents aren't blocked waiting for Skip to notice their chat message
- QA's work is visible (their notes are right there on the card)
- The "rubber stamp" problem gets harder — you're watching the actual feature work, not reading a claim about it
