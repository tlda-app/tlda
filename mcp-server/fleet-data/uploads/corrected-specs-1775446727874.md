# Corrected Feature Specs — From Skip's Words

These specs are derived from Skip's actual chat messages, not agent interpretations.
Each section quotes Skip, then states what needs to be built.

---

## 1. W7 HUD — Fleet Shape Layout

### What Skip said (verbatim)

> "the HUD should be *the same size* as the on-canvas layout. not a scale model."

> "the HUD camera is fucked so it shows the paper tiny"

> "the HUD camera fix is like, more important than anything else"

> "global lock/unlock on fleet layout"

> "yes. normal tldraw shapes. just one button to lock them/unlock them"

> "like, it could be like, a lock/unlock icon next to the 'Fleet' container label"

> "no. kill the container. place the lock where it is 'in the container' implicitly"

> "place the lock relative to the bounding box"

> "ok. it's not attached to anything. it can't be selected lock or no"

> "the right margin of the fleet HUD should be at a fixed horizontal position relative to doc margin so pan left-right does work that way."

### Spec

**Three things, in priority order:**

1. **HUD camera = 1:1 with canvas.** The HUD currently shows a zoomed-out scale model of the fleet shapes. It should show them at the same size as the main canvas. The HUD camera needs to be fixed so fleet shapes render at real size.

2. **Kill the Fleet container shape.** Fleet shapes (chat, agents, etc.) are normal top-level tldraw shapes. No group container wrapping them. The container concept is dead.

3. **Global lock/unlock toggle.** One button, positioned relative to the bounding box of all fleet shapes (not inside any shape, not attached to anything). Toggle locks/unlocks all fleet shapes as a group. Cannot be selected. Visual state changes on the icon itself when toggled. Think: floating lock icon at top-left of the fleet shape cluster.

**What agents built wrong:** v1 built a group-move overlay (correct intent, bad UX). v2 built a draggable/resizable panel (wrong problem entirely — panel positioning, not shape layout). Neither addressed the 1:1 camera or the lock/unlock toggle.

---

## 2. Chip Unification (W4)

### What Skip said

> "Single chat render path: Skip wants one renderChatLine() function for all message rendering, not 4+ separate paths"

> Re: iframes in chat — iframe sizing was inconsistent, sometimes "too small, slider covering content"

> Re: chip drag — "On drop, show an inline preview chip/badge above the input showing what will be attached. Multiple items can be dragged in (accumulate chips). Chips have an X to remove."

### Spec

**One rendering path for everything.** Currently there are multiple code paths for rendering the same entity type in chat: `ref-chip`, `md-file-card`, `tlda-card` iframe, `tool-ref`. All of these should collapse to one canonical chip type per entity. Specifically:

1. Kill `md-file-card` — shared-docs render as `ref-chip` (done)
2. Kill iframe auto-conversion for tlda URLs in message text (NOT done — this is the main gap)
3. File attachments (`{{att:N}}`) should use `ref-chip` not `md-file-card` (NOT done)
4. Drag-to-chat: accumulate chips above input with X to remove (partially done)

**What's left:** Items 2 and 3. The iframe auto-conversion is the biggest remaining inconsistency — same doc referenced two different ways depending on whether it came from `share()` or was typed as a URL.

---

## 3. Task Inbox / Review Queue

### What Skip said

> "so like, i don't want to have to approve"

> "i'd think of fleet chat as like, the default viewing environment and tlda as like, the detail-oriented/annotation-focused one."

> "passive monitoring principle"

> "making shit easy for me to read and verify"

> "lol. this is not about referees. this is about making shit easy for me to read and verify"

### Spec

**Passive review, not active approval.** Skip should not have to click buttons, navigate to things, or actively approve work. The review experience should be:

1. Completed work auto-queues with evidence (playbacks, screenshots)
2. Skip can passively scroll through results
3. Playbacks auto-advance (not click-to-play)
4. Reject = one tap, approve = keep scrolling (or one tap)
5. Lives in the fleet chat default view, not a separate app/tab

**task-inbox agent has v1 built** — needs Skip's review to see if it matches this vision.

---

## 4. QA / Merge Process

### What Skip said

> "do you look at stuff when you merge?"

> "should they not be run on worktree and the run again to verify the merge?"

> "someone should be there just to verify claims"

> "it feels like we need log review tied into the verification process. like, not as an option but a requirement"

> "dude 1 picture does not cut it."

> "Don't rubber-stamp. You have playwright — use it."

### Spec

**Verification is mandatory, not optional:**

1. Tests run on worktree AND again after merge
2. QA must use playwright — not just read agent claims
3. Log review is part of verification (check what agent actually did vs what they claim)
4. Multiple screenshots, not just one token proof
5. Skip's approval required before merge to main (main is the live environment)
6. "It passes all criteria" without evidence = automatic rejection

---

## 5. Browser Control Tools

### What Skip said

> "i think console.warn is not a sufficient error-reporting tool. because i get asked to fucking monitor it"

> "can you start a headed playwright instance and we just work there?"

### Spec

Already specced in `scratch/reload-tool-spec.md`:
- `reload_browser(reason)` — AppleScript hard-reload of Safari, gated on chat permission
- `get_console(level?, limit?)` — inject console collector, query via AppleScript

**No spec changes needed** — the scratch spec matches Skip's intent. Just needs implementation.

---

## 6. Chat Context Tagging

Already specced in `scratch/chat-context-tagging-spec.md`:
- Auto-tag messages with doc, page, camera, visible agents, nearby notes
- Read/unread tracking on notes

**No spec changes needed** — the scratch spec matches Skip's intent. Just needs implementation.

---

## Priority Order (from Skip's actions/urgency)

1. **Voice** — actively broken, actively frustrating (voice-enter working on it)
2. **HUD camera fix** — "more important than anything else" (Skip's words)
3. **Browser tools** — stops agents from asking Skip to reload/check console
4. **Task inbox** — review v1, iterate
5. **Chip unification** — finish the remaining 30%
6. **Chat context tagging** — nice to have, not blocking
