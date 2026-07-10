# tlda Feature Guide

This document describes what tlda looks like and how you interact with it. It's for new users figuring out the app, and for agents that need to understand what a feature *is* before debugging it.

Features are tagged with status:
- **Working** — used regularly, known to work
- **Untested** — code exists, uncertain if it works
- **In progress** — being developed or recently changed
- **Disused** — was a thing, probably bitrotted
- **Bug** — known broken, needs fixing

---

## The Canvas

tlda is built on TLDraw — an infinite canvas. Document pages are SVG shapes laid out vertically. Everything else (chat, agent panels, annotations, the doc viewer) are also shapes on the canvas. You pan and zoom like any canvas app.

### The HUD — Working

Fleet shapes (chat, agents, doc viewer, search) are real TLDraw shapes that live on the canvas "above" the document pages. They're rendered through an overlay called the **HUD**:

- **Fixed vertically**: fleet shapes stay at the same screen Y position as you scroll through pages. They don't disappear when you scroll.
- **Pans horizontally**: fleet shapes move with the document when you pan left/right. You can pan to see a wider set of shapes.

The intended use: put fleet shapes in the **left margin** of the document. As you read, they're always beside you.

**Implementation quirk**: since fleet shapes are real canvas shapes, if you pan far above the document you'll find them at their actual canvas position. You can interact with them there, but you might see overlap between the HUD overlay and the actual shapes.

### Layout Presets — Working

The fleet pill opens and applies preset fleet layouts:

**Single-chat layout:**
- Left column: agents panel (top) + search panel (bottom)
- Right column: one 3/4-height chat + doc viewer below

**Dual-chat layout:**
- Left column: agents panel (top) + search panel (bottom)
- Middle column: one full-height chat
- Right column: second 3/4-height chat + doc viewer below

Design logic: the rightmost column is closest to the document — put your active conversation there. The middle chat is for secondary work (different doc, app development, etc.).

### Manual Resize — Working

Every fleet shape has a **button panel** at the center-right edge. The buttons are deliberately subtle — low opacity by default, more visible when the cursor moves over the shape, most visible on direct hover. Buttons include:

- **X**: close/delete the shape
- **Layout**: click to enter resize mode — the shape gets drag and resize handles. Drag to move, drag handles to resize. Click off the shape to exit resize mode.
- **Shape-specific buttons**: e.g., filter (chat), sources (doc viewer)

---

## Fleet Chat — Working

Fleet chat is a shape on the canvas that shows real-time messages between you and your agents. It's the primary communication channel.

### What it looks like

A dark panel with a scrollable message log and a text input at the bottom. Messages show:

- **Timestamp** (left, dimmed): `2:14 PM`
- **Nick** (colored): agent name in a hash-based color
- **Arrow and target**: `→ skip`
- **Message body**: rendered markdown (bold, code, lists, headers, math)

Messages from you are styled differently from agent messages. Old messages dim over time. Each agent gets a consistent color across the session.

### Message types

- **Plan approval cards** — Working: when an agent proposes a plan, you see it with "Go for it" / "Stop" buttons inline.
- **Task lifecycle** — Working: delegation (arrow icon), completion (checkmark), bounced tasks (return arrow).
- **Timer countdowns** — Working: live countdown when an agent sets a timer.
- **Thinking/compacting indicators** — Working: animated dots show when an agent is processing or compacting context.
- **Terminal cards** — Disused: designed to auto-pop when an agent's terminal needs attention (e.g., permission prompt). The rendering works but they don't auto-surface — the detection pipeline isn't firing.

### Sending messages

Type in the input area at the bottom. The placeholder shows who you're sending to (based on the current filter). Enter sends. Shift+Enter for newlines. Arrow keys navigate message history.

**File drag-and-drop** — Working: drag an image or file from your system into the chat input. It uploads and creates a chip/token in the message.

### Message metadata

Every message is tagged with context from when you sent it:

- **Document**: which doc you're viewing
- **Version**: shadow repo git hash
- **Location**: where in the document you are

Agents receiving a message know exactly what you're looking at when you wrote it.

### Reference links — Working

When a chat message mentions a document label (like `eq:dual-problem` or `thm:main`), it becomes a **hoverable link**:

- **Hover**: shows a live doc viewer preview of that region (pannable, zoomable)
- **Click**: pins the preview so it stays after you stop hovering
- **Go button**: jumps the main document camera to that location
- **X**: dismiss the pinned preview

### Filtering

Chat filtering is **label-based** using DNF (disjunctive normal form) expressions. Labels include agent names (unique to each agent) and group labels that agents assign themselves (like "qa", "ui", "writing").

**Drag-and-drop filtering** — Working: drag a label from the Agent Panel onto a chat shape. When you drag over a chat, three drop zones appear:

- **Top pane ("to")**: filter to messages *to* that label
- **Bottom pane ("from")**: filter to messages *from* that label
- **"Only" zone**: replace the entire filter with "to AND from this label" — shows only the conversation with that agent

Within a pane:
- **Drop onto an existing label**: ANDs with it (narrows — "from alice AND labeled qa")
- **Drop elsewhere on the pane**: ORs (broadens — "from alice OR from bob")

A live preview shows what the resulting filter expression will look like as you drag.

**Filter button** (in the shape's button panel): opens an overlay to edit the current filter directly — click X on labels to remove them.

### Auto-scroll — Working

Chat auto-scrolls to new messages by default. When you scroll up to read history, auto-scroll pauses — a play/pause button appears at the bottom-right to resume. A down-arrow button scrolls to the latest message.

---

## Agent Panel — Working

The agent panel shows all registered agents with their status, labels, and activity.

### What it looks like

A table with rows for each agent. Each row shows:

- **Status dot**: green (alive, seen within 10 minutes), amber (stale), grey (dead)
- **Agent name**: the friendly name assigned at spawn
- **Labels**: colored chips — both the agent's unique name label and any group labels (e.g., "qa", "ui")
- **Unread count**: red badge if the agent has sent you unread messages
- **Last message snippet**: preview of their most recent message

Dead agents are collapsed by default — click "Show dead agents" to reveal them.

**No scroll** — Bug: the agent list doesn't scroll. If you have many agents, there's no way to see them all without sorting and hoping.

### Drag interactions — Working

Labels are **draggable**. This is the primary way to set up chat filtering:

- **Drag label onto fleet chat**: updates the chat's DNF filter (see Filtering above)
- **Drag onto empty canvas**: creates a new chat shape pre-filtered to that label

### Agent management

- **Spawn/Respawn buttons** — Bug: these exist in the UI but don't appear to work.
- **Service health dots** — Disused: three dots (tlda/fleet/sync) that are meaningless now that everything runs on one server. Health display needs a rethink.

---

## Search Panel — Working (partially untested)

A fleet shape that searches chat history. May also search document annotations and document content (scope unclear — needs verification). Always present in the left column of layout presets, below the agents panel.

---

## Doc Viewer — Working

The doc viewer is a shape that shows document regions from other parts of the paper. It renders a **live, pannable canvas clip** — not a static image. You can zoom and pan within it to see surrounding context.

It has three **sources** that feed it content, with a priority system (errors > refs > proof).

### Sources

1. **Ref clicks** — Working: when you click a cross-reference in the document (like `Theorem 2.1` or `equation (3)`), the doc viewer navigates to show that region.

2. **Scroll into proof** — Working: when you scroll to a proof in the main document, the doc viewer automatically shows the corresponding theorem statement. This is the background/passive mode — it tracks your reading position and keeps the relevant statement visible.

3. **Build errors** — Working: when a LaTeX build produces errors, they appear in the doc viewer. Navigate between errors with prev/next buttons. The error count shows "Error N of M."

**Sources button** (in the shape's button panel): opens an overlay to toggle which sources are active.

### Navigation

- **Go button**: jumps the main document camera to the region shown in the doc viewer
- **Forward/back arrows**: navigate through your history of viewed regions
- **Return button** — Not yet implemented: planned to appear after Go, to jump back to where you were

---

## Right-Side Panel — Working

A tabbed panel on the right edge of the screen, revealed by hovering. Contains multiple tabs and controls.

### TOC Tab — Working

- Section headings parsed from the LaTeX document
- Click to navigate to that section
- Collapsible subsections
- Search within the document

### History Tab — Untested

Version slider to scrub through document versions. Predates the shadow repo system — may not work correctly with the current versioning.

### Notes Tab — In progress

Lists math note annotations. Currently shows only math notes. Does not yet show highlights (planned). Sort/filter controls from CLAUDE.md are not present.

### Panel Controls

Buttons on the panel:

- **Theme selector** — Working: light / dark / warm
- **Vim toggle** — Working: turn vim keybindings on/off in math note editors
- **Camera link** — Working: shared camera mode. Everyone viewing the document with linked cameras follows the same scroll/zoom position. Useful for calls or screenshares.
- **Hide defs** — Disused: vestigial, should be removed

### Edge Hover Zone

The panel and the highlighter zone share a hover region on the right edge of the screen. A **thumb slider** at the bottom of the panel controls how wide this hover region is:

- Slide right: tiny hover zone (less intrusive)
- Slide left: wide zone (more accessible)

---

## Annotations — Working

Annotations are math-aware sticky notes that attach to specific locations in the document.

### Math notes

Press `m` or use the note tool to create a note. Notes support:

- **Inline math**: `$x^2$` renders via KaTeX
- **Display math**: `$$\int_0^1 f(x)\,dx$$`
- **Markdown**: headings, bold, italic, code blocks, links, images
- **Paper macros**: custom LaTeX macros from the paper's preamble are available (e.g., `$\E[X]$`)

The editor is **top/bottom**: edit on top (CodeMirror with optional vim bindings), rendered preview below.

### Colors

Notes come in 8 colors. Notes can be expanded (full content visible, editable) or collapsed (small colored dot, click to expand).

### Multiple-choice notes — Working

Agents can drop notes with tappable option buttons (e.g., Accept / Reject / Modify). Used for structured feedback where the user picks from predefined options.

### Source anchoring — Working

Notes are anchored to specific source lines in the LaTeX file. When the document rebuilds, notes move to stay aligned with their source content. Annotations survive edits to the paper.

### Note dragging — Bug

Math notes are currently not draggable. This also means dragging notes into chat (to insert reference tokens) doesn't work. Needs fixing.

---

## Highlighter — Working

### Tool selector

Bottom-right of the screen: a button that gives access to tools and highlighter colors.

- **Slide left/right** after clicking: select tool or highlighter color from a slider
- **Slide up**: toggle the **highlighter zone** on/off

### Highlighter zone — Working

When active, the right side of the screen (below the panel) shows a ghost slider. Click anywhere in the zone to pick a tool — no need to be precise about positioning.

### Highlight metadata — Working

Highlights are instrumented. When you draw a highlight, it gets tagged with:

- The actual text under the highlight (via synctex mapping)
- TeX file and line number
- Version info

Agents can read highlights via `read_pen_annotations` and know exactly what source text you highlighted.

### Color-intent system — Working

Highlight colors map to semantic intent:

- **Green**: approve
- **Red**: reject
- **Yellow**: question
- **Violet**: expand
- **Orange**: comment
- **Blue**: info

Most useful on iPad with a stylus. Agents can read these via `get_highlight_feedback`.

---

## Voice Note Button — Working

Bottom-right of the screen (next to the tool selector): a **microphone button**. Click to start recording a voice note — transcribes what you say and creates a math note from the content.

---

## Voice-to-Chat — Working

Hands-free voice input for fleet chat, built on the Web Speech API.

### How it works

- **Right Shift** toggles recording on/off (double-tap for hard reset)
- Transcribed text fills the chat textarea in real-time
- Domain vocabulary is post-processed: Greek letters (phi, theta, gamma...), math terms (seminorm, estimand), and project-specific names (Bregman, Sobolev) are recognized

### Voice commands

Say these at the end of your message:

- **"send"** or **"send it"**: sends the current message
- **"left chat"** / **"right chat"** / **"next chat"**: switches to an adjacent chat shape

### Health indicator

A small dot at the bottom of the screen when recording:

- **Green**: audio is flowing normally
- **Amber**: no audio detected for 3+ seconds, or recognition is stalled

Also shows who you're sending to: "recording → agent-name".

### Math mode — Untested

Supposedly toggleable mode for aggressive Greek letter recognition. Status unclear.

---

## Input Modes

- **Foot pedals** — Working (experimental): gamepad-based cursor control for hands-free navigation. Works but not heavily used.
- **Sound-based modes** (clicks, whistle, hiss) — Disused: never fully developed.
- **Voice**: the main voice system described above.

---

## Agent Lifecycle & Identity

### Spawning agents — Working

Agents are spawned via `fleet-spawn`, a Python script:

```bash
fleet-spawn --fresh alice          # Create a new agent named "alice"
fleet-spawn alice                  # Respawn existing agent (resume session)
fleet-spawn --model opus alice     # Override model
fleet-spawn --cwd /path alice      # Override working directory
```

What `fleet-spawn` does:
1. Ensures the server is running
2. Generates a fleet ID (`fleet:<random>`)
3. Pre-registers the agent via WebSocket (so it appears in the panel immediately)
4. Creates a tmux session named `fleet-[name]`
5. Launches Claude Code inside it with the fleet MCP loaded
6. Prompts the launched agent to call `login()` so it claims the server-created shell

### tmux sessions

Every agent runs in a tmux session named `fleet-[friendlyname]`. To attach to an agent's terminal directly:

```bash
tmux a -t fleet-alice
```

This is sometimes necessary for:
- Permission prompts that haven't been surfaced via terminal cards
- Debugging stuck agents
- Seeing raw Claude Code output

Terminal cards are designed to surface this automatically in fleet chat, but the auto-pop pipeline is currently broken.

### Identity model

**Agents**: each spawned agent gets a unique fleet ID (`fleet:<hash>`) and a friendly name. The server creates the shell row before launch. When the agent calls `login()` in the fleet MCP, it claims that server-created shell and attaches its current session metadata.

**Humans**: each human gets an identity via the browser. On first visit, a name picker appears. The name is stored in localStorage and sent to the server via WebSocket on every connection. The server creates a human agent record with `human: true`. Multiple humans can use the same server — each browser has its own identity.

**Labels**: agents have both a unique name label and optional group labels (like "qa", "ui", "writing") that they self-assign. Labels are the basis for chat filtering.

### Agent lifecycle

1. **Spawn**: `fleet-spawn` creates tmux session + launches Claude Code
2. **Login**: agent calls `login()` via MCP → claims the pre-created shell and starts heartbeating
3. **Active**: agent processes tasks, sends/receives chat, heartbeats periodically
4. **Stale**: no heartbeat for 10+ minutes → amber dot
5. **Dead**: no heartbeat AND tmux session gone → grey dot, collapsed in panel
6. **Respawn**: `fleet-spawn [name]` resumes the most recent session for that agent

---

## Versioning — Working

### Shadow repo

Every successful build creates a git commit in a shadow repository managed by tlda. Every version of the document you've ever built is recoverable.

### Version wheel — Working

A small control in the top-left showing timestamps for document versions and the current version's commit hash. Useful for debugging and version identification.

### Git mirror — In progress

Being added: on successful build, the fleet daemon auto-pulls so your working copy mirrors the shadow repo. Toggled on the index page. This means agents can use ordinary git tools in the working copy instead of specialized MCP tools for version operations.

### Diff viewer — Untested

A diff viewer tied to the history system. An old broken version exists; a new version was in development. Status unclear.

---

## Build Status — Working

Bottom-left of the screen:

- **Build pill**: shows the current build status (building, success, error)
- **Warning icon**: click to see a scrollable list of build warnings from the LaTeX process
- **Error count**: when errors occur, they show here first, then the doc viewer provides detailed navigation through error regions

---

## How Things Connect

### The feedback loop

The typical collaborative flow:

1. You open a document and read/annotate it
2. An agent monitors the document via `tlda monitor` — a hook-based system that fires after every tool call
3. When you draw a highlight or drop a note, the monitoring agent gets a chat notification
4. The agent can read your annotations in detail via `read_pen_annotations` or `get_highlight_feedback`
5. The agent responds — with a chat message, a reply annotation, a multiple-choice note, or by editing the source file
6. The document rebuilds automatically, and your annotations stay anchored

### Feedback paths

- **Lightweight (`tlda monitor`)**: agent gets notified "new annotation on doc X" as a chat message. Quick, automatic, just tells the agent something happened.
- **Heavyweight (`read_pen_annotations`)**: agent explicitly reads all annotations with full detail — text, source lines, colors, intent. For when the agent needs to process the feedback.

### Chat + canvas integration

Fleet chat is wired into the canvas:

- Drag labels from the agent panel onto chat to filter
- Reference links in messages show live doc previews on hover
- Messages carry document/version/location metadata
- Plan approval and task lifecycle happen inline
- Messages render with full markdown and math
- File drag-and-drop for sharing images and attachments

### MCP tools

Agents interact with the canvas through MCP tools. Key tools:

| Tool | What it does | Status |
|------|-------------|--------|
| **Notes** (rename from "annotation") | | |
| `add_note` | Place a math note at a source line (supports multiple-choice) | Working — rename from `add_annotation` |
| `list_notes` | List all math notes | Working — rename from `list_annotations` |
| `delete_note` | Delete a note | Working — rename from `delete_annotation` |
| `suggest` | Post a suggestion card with Accept/Reject buttons | Rethink — unify with `add_note` (always markdown, text or file) |
| **Drawing** | | |
| `draw_highlight` | Highlighter stroke over source lines | Working (partial) — needs word-level reimplementation |
| `draw_arrow` | Curved arrow connecting two locations | Working |
| `mark_highlight_addressed` | Desaturate a highlight (marks it handled) | Working |
| `place_response_bar` | Margin bar next to highlight indicating agent responded | Working |
| `create_shape` | Generic low-level shape creation | Working |
| **Feedback reading** | | |
| `read_annotations` | Read all annotations (notes + drawn shapes) with source mapping | Working |
| **Navigation** | | |
| `scroll_to_line` | Scroll viewer to a source line | Working |
| `flash_location` | Flash a red circle at a source line | Working |
| `screenshot` | Capture viewer (target: viewport / screen / annotation ref / explicit bounds) | Working |
| **Understanding** | | |
| `set_understanding` / `get_understanding` | Line-level reading status | Untested — good idea, needs docs and verification |
| **Build** | | |
| `build` / `build_status` | Trigger and poll builds | Working |
| `push` | Push source files and trigger build | Working |
| **Versioning** | | |
| `doc_version` | List version history | Working |
| `doc_view` | View an old version temporarily | Working |
| `lookup_theorem` | Find a theorem by number or label | Untested |
| **Chat/rendering** | | |
| `set_chat_target` | Change which agent a chat panel targets | Working |
| `set_preamble` | Set KaTeX macros for chat math rendering | Working |
| **Remove** | | |
| `signal_reload` | Reload SVGs after build | Remove — fold into `push` |
| `scratch` | Publish scratch file to fleet workspace | Remove — no fleet workspace |
| `doc_revert` | Restore old version | Remove — use local git |
| `doc_diff` | Source diff between versions | Remove — use local git |
| `doc_compare` | Side-by-side comparison | Remove — use local git |
| `wait_for_feedback` | Block until annotation | Remove — use `tlda monitor` |
| `reply_annotation` | Reply in thread | Remove — threading removed |
| `mark_annotation_done` | Mark done | Remove — done state removed |

---

## Pre-Release Testing Plan

### Bugs to fix
- Math notes not draggable (blocks drag-into-chat)
- Terminal cards don't auto-pop (detection pipeline broken)
- Agent panel has no scroll (can't see all agents)
- Spawn/respawn buttons don't work
- `draw_highlight` needs word-level reimplementation (currently line-level only)
- Doc viewer: add Return button (jump back after Go)

### Features to verify
- History tab (version slider — does it work with shadow repo?)
- Diff viewer (old version exists, new version in progress)
- `set_understanding` / `get_understanding`
- `lookup_theorem`
- Math mode in voice
- Notes tab sort/filter controls
- Search panel scope (what does it actually search?)

### Features to rethink
- Health/status display (three dots for one server is meaningless — needs redesign)
- `screenshot` — should use doc viewer instead of hijacking main screen
- `suggest` vs `add_note` — unify note creation (always markdown, text or file)
- `signal_reload` — fold into `push`

### MCP tools to remove
- `wait_for_feedback` (replaced by `tlda monitor`)
- `mark_annotation_done` (done state removed)
- `reply_annotation` (threading removed)
- `doc_revert` (use local git)
- `doc_diff` (use local git)
- `doc_compare` (use local git)
- `scratch` (no fleet workspace)

### MCP tools to rename
- `add_annotation` → `add_note`
- `list_annotations` → `list_notes`
- `delete_annotation` → `delete_note`

### UI to remove or clean up
- "Hide defs" button (vestigial)

---

## Feature Requests

### Markdown/files in chat → doc viewer source
Markdown documents and files shared in chat should open as a doc viewer source instead of requiring an external app. Render as a math note at an off-screen canvas position, then show via the doc viewer.

### Agent annotations → doc viewer source
When an agent drops a highlight or note, it could optionally surface in the doc viewer. MCP tools would include an **attention level** parameter — "informational" vs "look at this now" — to control whether the doc viewer switches to show it.

### Configurable doc viewer source priority
The current priority order (errors > refs > proof) is fixed. It should be a **draggable reorder list** with a "below the bar" slider — sources below the bar are disabled, sources above are active in priority order.
