# Feature Wishlist — Things Skip Wanted That Don't Exist Yet

Compiled from fleet chat history and session logs, March–April 2026.  
Cross-referenced against main branch and worktrees. Items in worktrees are noted.

---

## UI — Fleet Chat (tlda canvas)

### In-place filter editing on chat shapes
> "ok. so something i find myself doing a lot is like, xing out chats because i can't edit the filter expression."  
> — session `b119b27d`, tlda project

Currently: to change a chat's filter, you delete the shape and recreate it.  
Wanted: tap the filter display on an existing chat → edit the DNF expression in place, same two-pane AND/OR UI as the dashboard filter editor.  
Attempted: partial implementation existed but didn't match dashboard quality; some work in `b119b27d` session.

---

### Esc to interrupt from chat textarea
> "just like, for future reference, we should probably make it easier to send interrupts---like esc on a bare textfield like in terminal. agents have been running away today"  
> — March 18, fleet chat to apps

> "i mean look. in terminal, if i hit esc, it'd be a fucking interrupt"  
> — March 22, fleet chat to apps

Wanted: Esc once = soft interrupt (POST /api/send-key), Esc twice within 500ms = hard interrupt (POST /api/interrupt). Works from any fleet-chat textarea, mirrors terminal behavior.  
Attempted: On main now as W6 ("Esc interrupts") — **needs verification that it actually works**.

---

### Clickable doc links in chat messages with hover preview
> "When a chat message references a document position (theorem, page, source line), it should be interactive: **Hover**: show a preview of that doc region (floating panel, like RefViewer/ProofStatementOverlay). **Click**: scroll the main canvas to that position."  
> — task description in session `28579b64`, tlda project

Also from session `0a47132c`:  
> "When a chat message contains a reference to a theorem, equation, or section in a tlda doc (e.g. 'Theorem 4.3', 'eq:riesz-rep', 'Section 3.2'), it should be a clickable link"

Attempted: Delegated in `28579b64` session. Unknown whether it shipped.

---

### Scroll in chat shape (TLDraw drag mode conflict)
> "ok, i'm noticing a bigger issue. chat doesn't capture scroll so like, i can't scroll in chat"  
> "scroll doesn't work in drag mode [like chat has tldraw drag handles] and I can't make those go away. same deal with enter"  
> — session `b119b27d`

Appears to have been partially resolved in that session; current status unclear on main.

---

### Subtle kick indicator in chat (instead of full line)
> "SUBTLE KICK INDICATOR instead. When a kick event is filtered from chat, show a small subtle indicator — like a small checkmark or dot in a muted color. Not a full chat line, just a visual hint that a notification was filtered."  
> — session `edc92011`, tlda project

Wanted: when a 📬 kick message is filtered from chat display, show a subtle ✓ or dot — not nothing, but not a full chat line either.

---

### Up-arrow to access previous sent messages
> "we should implement like, up-arrow to get prev line sent"  
> — session `b119b27d` / March 13, apps chat

Standard terminal behavior. Not implemented.

---

### Chat history persists across agent respawns
> "i can live with whatever today, but like, this process---i should have my chat history in there when we respawn"  
> — March 14, fleet chat to apps

When an agent dies and is respawned, the chat widget loses prior conversation. Wanted: chat history loads from DB on respawn.

---

## UI — Fleet HUD / Canvas Layout

### Global lock/unlock toggle on fleet layout
> "global lock/unlock on fleet layout"  
> "like, it could be like, a lock/unlock icon next to the 'Fleet' container label"  
> "yes. normal tldraw shapes. just one button to lock them/unlock them"  
> — session `b119b27d`

Wanted: single lock/unlock button (icon next to Fleet container label) that prevents accidental repositioning of fleet shapes. When locked, shapes are TLDraw-locked; click to unlock for repositioning. HUD layout mode (worktree `hud-layout-v3`) is an alternative approach — status: unmerged.

---

### HUD same actual size as on-canvas layout (not a scale model)
> "also like, something that's been fucked since the start. the hud should be *the same size* as the on-canvas layout. not a scale model."  
> — session `b119b27d`

Current HUD uses a copy-store TLDraw instance with `panelWidth = bounds.w` giving zoom=1 but the panel itself is smaller, so it renders as a scale model.  
Wanted: HUD and canvas layout are pixel-identical (or HUD is removed entirely in favor of the lock approach above).

---

### No blue selection/hover indicators on fleet shapes
> "User wants no blue selection/hover indicators on fleet shapes ever"  
> "IT WAS BECAUSE OF THE CHANGE THAT IT WAS CLOSE ENOUGH. AND KILL THE FUCKING INDICATOR. WHAT THE FUCK IS WRONG WITH YOU"  
> — session `b119b27d`

`indicator() { return null }` should be on all fleet shapes always. May have regressed.

---

### TLDraw license watermark not blocking build pill
> "tldraw's 'get a license for production' thing is getting in the way of the build pill. can we move it to the top left"  
> — March 24, fleet chat to apps

The TLDraw "get a license" watermark overlaps the build status pill. Wanted: either reposition the pill or suppress/hide the watermark.

---

## UI — Fleet Dashboard

### Agents appear as filterable/draggable entities in panel (humans too)
> "Skip wants humans to appear in the agents panel as filterable/draggable entities, not special-cased. 'web' is fleet_id, 'skip' is friendly_name."  
> — March 11, apps session

Wanted: humans (Skip, "web") show up in the agents panel the same way agents do — draggable to create filter pills, not hard-coded special cases.

---

### Respawn button visible even when agent has unread messages
> "and i cant respawn them because there's a fucking '59 messages' badge where the respawn button should be"  
> — March 16, fleet chat to apps

Badge count hides the respawn button. Wanted: always show both; badge goes elsewhere or respawn button is on top.

---

### Human-readable task display for Skip
> "tasks list has the task of responding to messages but no real way to like, see what i should be doing to address them. someone should write a ui proposal for a human-readable version of my_task"  
> — March 14, fleet chat to apps

Wanted: dashboard view that shows Skip's pending tasks/messages in readable priority order, not raw `my_task()` JSON.

---

### Single mailbox per kick (no mailbox + another mailbox)
> "ok. make a note to like, actually fix this for real? nobody should be getting a mailbox followed by another mailbox"  
> — March 22, fleet chat to apps

Kick delivery mechanism fires a 📬 followed by a second 📬 in some cases. Should be exactly one per kick.

---

### Agents visible in search with copyable content
> "agents need to show up in search"  
> "so i can actually see information"  
> "and maybe even like, copy it"  
> — March 16, fleet chat to apps

Fleet search (`search_logs`) returns results but the dashboard search widget apparently doesn't surface agent info in a usable/copyable way. Wanted: search results show agent content with copy affordance.

---

### Kick should carry content, not just a mailbox
> "the kick should be more than a mailbox"  
> — March 20, fleet chat to apps

> "priority 1---fix that problem so you're like, with it in fleet chat"  
> — March 20, fleet chat to apps

Kicks currently just send 📬 + Enter. Wanted: kick includes a preview of what the message is, so agent can see it without having to call `my_task()`.

---

## Viewer (tlda) — Annotation & Review

### Hidden viewer annotation layer with subtle indicator
> "maybe it'd be disruptive to see them creating in real time. so it'd be nice to have some kind of usually-hidden viewer annotation layer with a subtle indicator"  
> "hidden would involve a very subtle badge. faint..."  
> — session `f82107ed`, claude/tldraw project

Wanted: agent annotations (highlights, notes being created) are hidden by default, revealed by a subtle badge. Not the current always-visible overlay.

---

### Desktop highlighter/annotation mode (opt-in)
> "i feel like i'm getting stuff that i thought was mobile-only ui in tlda on my computer" — annotation/highlighter mode showing on desktop. Skip clarified: make it available (opt-in) on desktop, not forced.  
> — March 13, apps session

Highlighter strip/phone mode available as opt-in toggle on desktop, not injected automatically.

---

### Double-tap undo on phone highlighter
> "Double-tap undo: Skip requested a way to undo accidental highlights on the phone highlighter — implemented as double-tap on the highlighter button."  
> — March 11, apps session

May be implemented. Needs verification.

---

## Infrastructure / Workflow

### tlda iframe in fleet dashboard chat pane
> "the longterm goal is to have like, chips in chat, kind of projection to a tlda viewer. maybe in an iframe in a pane"  
> — March 15, fleet chat to apps

> "the tlda iframe in chat. like a half hour ago, you shared a doc. it looked good. it was like standard paper portrait aspect ratio, 80% width of the pane, properly zoomed on the text"  
> — March 22, fleet chat to apps

> "Fix shared doc tlda iframe (too small, slider covering content)"  
> — March 22, apps session summary

A tlda document viewer embedded as an iframe inside the fleet dashboard chat pane. Was demoed once ("looked good"), then broke. Wanted: stable embed, proper sizing (portrait, 80% width), no slider overlap.

---

### Agent respawn via UI (not CLI)
> "UI-driven respawn"  
> — March 11, apps session

Wanted: respawn button in dashboard UI that works without CLI access. Related to the badge-blocking bug above.

---

### ghost text / autocomplete in fleet chat input
> "and i want it to complete like shell would---one word at a time. displaying ghost text would be great if it's there---like to the end of line. but it doesn't complete the whole thing. just to..."  
> — session `1fce0d07`, fleet project

Shell-style tab completion in fleet chat input, with ghost text showing suggested completion.

---

### Constant-width icons in TLDraw toolbar
> "it'd be nice to use constant-width icons. and like, the..."  
> "link cameras situation? like, indent level matching what would be there if we had an icon, which can be absent"  
> — session `8bbbe17e`, claude/tldraw project

TLDraw toolbar icons should all be the same width so items are stable and indented consistently whether an icon is present or not.

---

## Paper Tools (Math / LaTeX review)

### Source-line anchoring for markdown format notes
> From CLAUDE.md: "Source-line anchoring is not yet implemented for markdown — notes are placed visually on the canvas."

Annotation notes in markdown-format tlda projects don't anchor to source lines. Wanted: same synctex-style anchoring that LaTeX docs have.

---

### tlda layout fidelity: stacked figures with `\\[-6ex]`
> From memory file `project_tlda_tex_fidelity.md`: "weekend todo: tlda should render stacked figures faithfully (currently shows individual SVGs, ignores `\\[-6ex]` etc.)"  
> — Skip

LaTeX figures stacked with negative vspace render as separate full-height SVGs in tlda. Wanted: render the visual layout faithfully.

---

## Notes on Attempted / In-Progress

| Feature | Status |
|---------|--------|
| Esc interrupts (soft/hard) | On main as W6 — needs verification |
| HUD layout mode | Worktree `hud-layout-v3` — unmerged |
| Context tags on messages | Worktree `chat-context` — unmerged |
| Fleet chat filter drag (tlda) | Partially implemented in `b119b27d` |
| Doc links in chat (hover preview) | Delegated in `28579b64` — status unclear |
| Content chips with hover preview | In main (reference chip system) — partially done |
| Camera link between viewers | On main (`signal:camera-link`) |
