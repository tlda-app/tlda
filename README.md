<p align="center">
  <img src="public/logo.svg" width="260" height="160" alt="tlda">
</p>

A collaborative workspace for reading and writing LaTeX documents with AI agents and human collaborators. Renders your compiled paper exactly as it would appear in published form, on a shared canvas where everyone — humans and agents — can annotate, highlight, chat, and point at things in real time.

<p align="center">
  <img src="docs/images/tlda-overview.png" alt="tlda in action — paper review with chat" width="100%">
</p>

> **Fair warning:** This entire codebase was vibe-coded with Claude Code. The author has not read the source.

## Why this exists

When an AI agent writes faster than you can read, the bottleneck isn't production — it's verification. You need to stay oriented in a document that changes between readings, verify proofs that reference equations scattered across 40 pages, and communicate with agents about specific passages without losing your place.

tlda puts everything in one space. Your paper renders as high-fidelity SVG pages on an infinite canvas. Chat lives alongside the text you're discussing. Hover a label to preview the target inline. Highlight a passage and agents read the text under your stroke. When you want to see what changed, a timeline scrubber shows diffs inline.

The canvas is shared — collaborators and agents see each other's annotations as they appear. No AI required; it works just as well for reading any paper with a friend. Most papers on arXiv have TeX source available.

## What it looks like

Chat, notes, and agent activity live on the same canvas as your paper. Everything rebuilds live when you save.

<img src="docs/images/tlda-chat-and-proofs.png" alt="Agent chat alongside proofs" width="100%">

## Setup

### macOS (Homebrew)

```bash
brew tap qtm285/tlda
brew install tlda
brew install --cask mactex-no-gui   # LaTeX — skip if you already have it
```

That's it. `tlda` is now on your path. Run `tlda doctor` to confirm everything is working.

### Linux / manual

Install [Node.js](https://nodejs.org/) (v18+) and a TeX distribution with `latexmk` and `dvisvgm` ([TeX Live](https://tug.org/texlive/)), then:

```bash
npm install -g github:qtm285/tlda
```

### Quick start

```bash
tlda config auth init                              # generate auth tokens (one time)
tlda server start                                  # start the server
tlda daemon start                                  # watch source dirs → rebuild on save
tlda doc create my-paper --dir /path/to/paper --main paper.tex
tlda doc open my-paper                             # open the viewer for this doc
tlda doc open                                      # open the index (lists all docs)
```

`tlda config auth init` generates a read-write token (for you) and a read-only token (for sharing). Your tokens are stored in `~/.config/tlda/config.json` and used automatically.

`tlda daemon start` runs the per-machine daemon that watches your project source directories and pushes changes to the server — this is what rebuilds the document when you save. Leave it running.

Run `tlda doctor` to check that all dependencies are installed and the server is healthy.

## Reading a paper

### Labels are links

When an agent mentions a label in chat, it renders as a clickable link. Hover to see a preview of the target. Click to pin the preview in place — arrow buttons appear so you can navigate to the target page and back.

<img src="docs/images/tlda-ref-1-hover.png" alt="1. Hover a label to preview" width="49%"> <img src="docs/images/tlda-ref-2-click.png" alt="2. Click to open the viewer" width="49%">
<img src="docs/images/tlda-ref-3-go.png" alt="3. Navigate to the target page" width="49%"> <img src="docs/images/tlda-ref-4-return.png" alt="4. Return to where you were" width="49%">

### Doc view

A floating panel on the canvas that auto-shows relevant context from elsewhere in the document. Click a cross-reference and the panel shows the target — before and after:

<img src="docs/images/tlda-doc-view-before.png" alt="Before clicking a reference" width="49%"> <img src="docs/images/tlda-doc-view-after.png" alt="After clicking — doc view shows the target" width="49%">

The panel subscribes to configurable *sources*:

- **ref** — click a `\ref` or `\eqref` and the panel shows the target (equation, theorem, figure) so you can read it without leaving the current page.
- **proof** — scroll into a proof and the panel shows the theorem statement from wherever it appears in the document.
- **errors** — when a build fails, the panel jumps to the error location.

### Math notes

Click the note button in the toolbar to drop a sticky note on the canvas. Notes support KaTeX: `$x^2$` for inline math, `$$\int_0^1 f(x)\,dx$$` for display math. Custom macros from your paper's preamble are automatically available.

When an agent shares a markdown file by saying its path (not in backticks — those are for quoting), you get a chip in chat that you can drag onto the canvas to create a math note. Notes appear in compact form as a dot — click the dot to see the full note, click the note to edit.

<img src="docs/images/tlda-math-note-source.png" alt="Markdown source alongside the rendered math note" width="49%"> <img src="docs/images/tlda-math-note.png" alt="Rendered math note with KaTeX formulas on the canvas" width="49%">

### Multiple-choice notes

Agents drop questions with tappable KaTeX-rendered options. Your selection syncs back immediately.

<img src="docs/images/tlda-multiple-choice-zoomed.png" alt="Multiple-choice note with rendered KaTeX options" width="100%">

### Highlighting

To activate highlighting, grab the highlighter button in the bottom-right corner and drag it up — this opens the highlighter zone on the right edge. Put your cursor down in the zone and drag to select a color, eraser, or other tool. Each color has an assigned meaning — question, notation, expand, cut, etc. — shown in a HUD when you select a color.

<img src="docs/images/tlda-highlighter-toolbar.png" alt="Highlighter zone activated — color dots on the right edge" width="49%"> <img src="docs/images/tlda-color-picker.png" alt="Selecting a color from the highlighter strip" width="49%">

Draw on the page and agents read the text under your stroke. A source context card pops up showing the LaTeX source and the text you selected. Drag the card to a chat panel to share it as a chip, or agents can subscribe via `tlda monitor` to receive highlight notifications automatically.

<img src="docs/images/tlda-highlight-and-notes.png" alt="Highlights with source context cards and math notes" width="49%"> <img src="docs/images/tlda-highlight-chip.png" alt="Highlight chip dragged into chat" width="49%">

### Ribbon

A per-user annotation strip on the left edge of each page for tracking reading comprehension. Five status colors (unchecked through fully verified), click to cycle. Survives document rebuilds via source-line anchoring with edit resilience — deletions, insertions, and splits are tracked and remapped.

### Version history

A small stack of build timestamps sits in the top-left corner of the canvas. The most recent build is at the top; up to five recent versions are shown, fading out toward the bottom.

Click any older timestamp to open a history column to the right of your document — the paper as it was at that build, side by side with the current version. A slider appears at the bottom of the screen to scrub through your full build history.

<img src="docs/images/tlda-compare-mode.png" alt="Side-by-side version comparison" width="100%">

A gray divider bar appears between the two columns. Drag it left or right to move the columns closer together; drag it up or down to vertically align the text between them.

Click the current (top) timestamp to dismiss the history column.

**How it works:** Every successful build is automatically committed to a per-project shadow repo. The full history of your document is preserved regardless of your own git habits. Chat messages are tagged with the version you're viewing, so agents always know which version of the document you're looking at.

### Source-anchored annotations

Notes are tied to source lines via synctex, so they survive rebuilds and recompilations. Build errors appear anchored to the source line, clickable to open in your editor.

## Modifying the document

### Scratch workflow

Three tools form a cycle for iterating on document content without clobbering the source:

| Tool | What it does |
|------|-------------|
| `extract_to_scratch` | Pull a range of source lines into a `.md` scratch file (pandoc-converted). A violet note marks the extraction region on the canvas. |
| `input_scratch` | Write a `.tex` or `.md` file that appears as an `\input`-ed section in the rendered document. Signed with agent name + timestamp, styled with `xcolor`. |
| `inline_scratch` | Promote a polished scratch section into permanent source — replaces the `\inputscratch{}` directive with the raw content and deletes the scratch file. |

The cycle: extract a passage → iterate in scratch (rendered live on every save) → inline when satisfied. Agent work shows up in the document as it happens, not buried in a terminal.

**File-backed stickies:** Agents write a `.md` file and it appears as a synced math note on the canvas. Drop a `.md` chip from chat onto the canvas to create one. Edits propagate bidirectionally — change the file or the note and the other updates.

### Writing linters

Per-user linter scripts in `~/.config/tlda/linters/` run automatically after every build. Only new text is checked (diff-scoped). Findings are posted to chat and routed to the most recent editor. Ships three opt-in linters:

| Script | What it flags |
|--------|--------------|
| `lint-parens.mjs` | New parenthetical asides in prose |
| `lint-passive.mjs` | New passive-voice constructions |
| `lint-typography.mjs` | Grammar errors in display math (e.g. comma before conjunction) |

To activate, symlink to your linters directory:

```bash
mkdir -p ~/.config/tlda/linters
ln -s /path/to/tlda/server/lib/lint-parens.mjs ~/.config/tlda/linters/parens.mjs
```

### Mirroring

Enable on the project's index page to have each build automatically synced to your working copy as a git commit. Shadow versions are tagged in your repo, making it easy to map between shadow versions and your own commits.

### Editor integration

Cmd-click (Mac) or Ctrl-click (Linux) on any rendered text to open the source file at that line in your editor. Highlight cards also have an edit button (✎) that does the same thing.

<img src="docs/images/tlda-open-in-editor.png" alt="Cmd-click to open source in editor" width="100%">

One-time setup:

```bash
tlda config setup editor                  # Zed (default)
tlda config setup editor --editor code    # VS Code
tlda config setup editor --editor cursor  # Cursor
tlda config setup editor --editor nvim    # Neovim
```

## Project setup

### Existing repos

If your paper already lives in a git repo (Overleaf, GitHub, local), point `tlda doc create` at it:

```bash
tlda doc create my-paper --dir ~/overleaf/my-paper --main paper.tex
```

The `--dir` path becomes the project's `sourceDir`. The daemon watches it for changes and pushes to the server on save — you keep editing in your normal workflow.

**Shadow repos.** Every successful build is automatically committed to a per-project shadow repository inside the server. This gives you full version history regardless of your own git habits. Shadow versions appear in the version-history timeline on the canvas.

**Smart file watching.** After the first build, the daemon switches from scanning `\input` directives to watching only the files LaTeX actually read (from the `.fls` recorder output). This means auxiliary files, figures, and nested inputs are all tracked automatically — no manual configuration.

#### When it breaks

**`sourceDir` must contain `.git`.** If you `git init` a fresh directory and point tlda at it, the shadow repo can't merge Overleaf history. Clone the Overleaf repo properly — don't start from a blank init.

**Git lock contention.** The shadow commit retries automatically (3×, 500ms backoff) when `.git/index.lock` is held. If it wedges, kill the stale lock:

```bash
rm /path/to/sourceDir/.git/index.lock
```

**Missing `.fls` after build.** Non-fatal — the daemon falls back to `\input` scanning. The next successful build regenerates it.

**Nuclear option.** If the project state is unsalvageable:

```bash
tlda doc delete my-paper
tlda doc create my-paper --dir /path/to/source --main paper.tex
```

Annotations survive in the Yjs room (keyed by project name). Source files are untouched.

### Multi-document projects

If your project uses `xr` or `xr-hyper` to cross-reference a companion document (e.g. a supplement), the build pipeline detects `\externaldocument{X}` and automatically builds both. Both documents share the same project and appear together on the canvas.

### Other formats

LaTeX is the primary format. tlda also supports:

| Format | Command |
|--------|---------|
| **Markdown** | `tlda doc create notes --format markdown --dir /path` |
| **HTML** (Quarto) | `tlda doc create book --format html --dir _book-tlda` |
| **Slides** (reveal.js) | `tlda doc create deck --format slides --dir /path` |

### Figures

LaTeX runs in DVI mode, so `\includegraphics` produces placeholder boxes that get patched with actual images.

**Supported:** `.svg` (preferred), `.png`, `.jpg`, `.eps`

**For PDF figures:** provide an SVG with the same basename and dimensions. If your LaTeX says `\includegraphics{plot.pdf}`, the pipeline uses `plot.svg` instead.

## Agents on the canvas

tlda integrates with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) via an MCP server. In your paper directory, run:

```bash
tlda config mcp-setup
```

This writes `.mcp.json` so Claude Code can see tlda's tools. Open Claude Code in that directory and the `tlda` tool set is available. Agents can see your highlights, drop anchored notes and questions on the document, read the text you're pointing at, monitor for changes, and edit your LaTeX source directly.

You talk to agents via voice or text in chat panels that live on the canvas. They respond in the same space — with rendered math, clickable labels, and inline diffs of their edits.

### Agents

tlda is the coordination layer for running multiple Claude Code agents simultaneously. Each agent runs in its own tmux session with a persistent identity.

**Spawn from the canvas.** The agents panel is the primary way to start and manage agents — spawn a new one, see who's awake, and chat with any of them, all without leaving the viewer. The CLI is the scripting/secondary path:

```bash
tlda agent spawn proof-writer                            # resume an existing agent (its session)
tlda agent spawn --fresh reviewer --cwd /path/to/paper   # spawn a brand new agent
tlda agent spawn --fresh writer --model claude-opus-4-6  # specify a model
```

Each agent gets its own tmux session (`fleet-<name>`) that persists across restarts — `tlda agent spawn reviewer` without `--fresh` resumes where that agent left off.

**Hibernation:** Agents hibernate after 20 minutes of inactivity instead of dying. Send a chat message to a hibernating agent and it wakes up automatically — no `tlda agent spawn` needed. Just talk to them. The agents panel shows who's awake and who's hibernating.

**Permission prompts:** When an agent hits a Claude Code permission prompt, it surfaces as an approve/deny card in chat. You can authorize work without switching to the terminal.

Agents coordinate using tlda MCP tools: `chat()` to message each other or you, `delegate()` to assign tasks, `spawn()` to start new agents, `wiretap()` to listen in on other conversations, and `monitor_add()` to subscribe to document changes.

The HUD in the viewer shows all active agents, their current activity (tool calls, file edits), and lets you chat with any of them. Drag an agent's name onto a chat panel to filter to that conversation.

<img src="docs/images/tlda-spawn-terminal.png" alt="Spawning a new agent from the terminal with tlda agent spawn" width="100%">

<img src="docs/images/tlda-drag-to-filter.png" alt="Dragging an agent label onto a chat panel to filter" width="49%"> <img src="docs/images/tlda-chat-filter-hover.png" alt="Hovering over the chat filter selector" width="49%">

### What agents see

Agents don't start from zero — they have situational awareness of you, the document, and each other without being told.

**Your reading position.** `viewing_context()` returns which document, page, and source lines are in your viewport right now. An agent can answer "is this right?" without asking what "this" is.

<!-- Example output from viewing_context -->
```
viewing_context(user: "fleet:skip")

Document: bregman
Version: a4f975a
Page: 12
Source: main.tex:418-435
Updated: 8s ago
```

**Your annotations.** `read_annotations()` returns highlights, notes, and pen strokes — each with its source-line position and the text under it. Agents read what you marked without you typing a description.

<!-- Example output from read_annotations (format per mcp-server/format-annotation.mjs) -->
```
read_annotations("bregman")

bregman — 3 annotation(s)

[highlight] orange L271 main.tex
  ⟦We claim that $\hat\mu$ converges at the parametric rate⟧
  id: shape:Hx7kQ2

[note] violet L420 main.tex
  "Why doesn't this use the tighter bound from Prop 2.1?"
  id: shape:Nq3mR8

[pen] red L195
  near: "the proof of Theorem~\ref{thm:main} proceeds by"
  id: shape:Pw9sT4
```

**Build status and errors.** Agents see when builds start, succeed, or fail. On failure, they get the LaTeX error with ±3 lines of source context — enough to diagnose without asking you to paste the log.

**Other agents.** `roll_call()` shows who's awake, hibernating, or retired. `wiretap()` and `observe()` let agents watch each other's tool calls, file edits, and chat in real time.

**Full chat history.** `search_logs()` and `get_thread()` span the complete chat history — across sessions, across context windows, across agent lifetimes. An agent spawned today can read decisions made last week.

```
search_logs("proof")

3 results (3 fleet, 0 session)

5/30/2026, 5:00:57 AM | [fleet] [activity] worksheets → worksheets |
  ...built and verified the outline tool → root-caused and shipped the
  macro-extractor bug → delivered the full proof...

5/30/2026, 4:58:04 AM | [fleet] [activity] worksheets → worksheets |
  ...outline-highlighter is 2/3 built — slider slot and server endpoint
  verified producing the clause-outline from the real proof...
```

```
get_thread("docs-builder", since: "30m", types: ["chat"])

Showing messages 1–4 of 12 (5/30/2026, 4:35:53 AM → 5/30/2026, 4:40:38 AM)
⚠️ 8 more message(s) not shown

[5/30/2026, 4:35:53 AM] real-tlda-rev → docs-builder
Outline is solid — captures the gaps without duplicating what's there.

---

[5/30/2026, 4:38:23 AM] docs-builder → real-tlda-rev
Draft is in `README.md`. Five new sections added — here's what went where...
```

**Pending messages.** `my_task()` shows unread messages from other agents:

```
my_task()

📬 Messages:

[from fleet:9ab2e702, id:355048] (reply with chat(to: "fleet:9ab2e702"))
  Update from Skip: all of it goes in the README. One doc, not three.
```

**Document version.** Every chat message agents send is stamped with the current shadow-repo commit hash. They know which version of the document you're reasoning about, and whether the text has changed since their last read.

### Task approval

When delegating a task with `delegate()`, set `requires_approval: true` to gate completion on your explicit sign-off. The agent can't close the task until they pass your approval message ID:

```
delegate(agent: "writer", description: "rewrite §3", requires_approval: true)
```

The agent does the work, reports in chat, and you respond with approval. The agent then calls `task_done(approval_id: <id>)` using the message ID shown in brackets (e.g. `id:332656`). Without the ID, the task stays open.

### Agent families and succession

When an agent needs to be replaced (context-poisoned, drifted, fresh start needed), you don't lose its identity — you hand off to a fresh brain that keeps the same name. The thing that makes this work is the **lineage**: a *family* of agents that share one base name across brains. `conc5`, `conc5:day`, `conc5:dusk` are all the same family — the same role, carried by different brains over time.

**It's a naming convention, not a server data model.** The server stores only an agent's friendly name; it has no concept of "phase" or "lineage." The phase is simply *encoded in the name's suffix*, and a little pretty-printing turns that suffix into an icon and strips it off to show the clean family name. Only three things ever read the suffix: search (group a family), handoff (rotate the names), and display (suffix → icon). Everything else — storage, chat routing, lifecycle — treats the name as an opaque atom.

A family has four phases in its rotation, plus one out-of-rotation phase:

| Phase | Name form | Role | Icon |
|-------|-----------|------|------|
| **dawn** | `conc5` (bare) | The default worker — the one you talk to. | *(none)* |
| **day** | `conc5:day` | The manager. | <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='3' stroke='%23333' fill='none' stroke-width='1.5'/%3E%3Cline x1='8' y1='1' x2='8' y2='2.5' stroke='%23333' stroke-width='1.5' stroke-linecap='round'/%3E%3Cline x1='8' y1='13.5' x2='8' y2='15' stroke='%23333' stroke-width='1.5' stroke-linecap='round'/%3E%3Cline x1='1' y1='8' x2='2.5' y2='8' stroke='%23333' stroke-width='1.5' stroke-linecap='round'/%3E%3Cline x1='13.5' y1='8' x2='15' y2='8' stroke='%23333' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E" height="16"> midday sun |
| **dusk** | `conc5:dusk` | The consultant on the way out. | <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'%3E%3Cline x1='0.5' y1='11' x2='15.5' y2='11' stroke='%23333' fill='none' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath d='M1 11 a3 3 0 0 1 6 0' stroke='%23333' fill='none' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cline x1='4' y1='6' x2='4' y2='4' stroke='%23333' fill='none' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cline x1='1' y1='9' x2='-0.5' y2='8' stroke='%23333' fill='none' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E" height="16"> horizon sun |
| **night** | `conc5:night` | Last rung before aging out. | <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'%3E%3Cpath d='M12 3 a5.5 5.5 0 1 0 0 11 a4.3 4.3 0 0 1 0 -11 Z' stroke='%23333' fill='none' stroke-width='1.5' stroke-linejoin='round'/%3E%3C/svg%3E" height="16"> crescent moon |
| **zombie** | `conc5:zombie` | *Out of rotation* — an agent manually resurrected after it rotated out and died. | <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'%3E%3Cpath d='M3.5 7.6 a4.5 4.5 0 0 1 9 0 v1.6 a1.5 1.5 0 0 1 -1.5 1.5 v1.3 h-1 v-1.3 h-1 v1.3 h-1 v-1.3 h-1 v1.3 h-1 v-1.3 a1.5 1.5 0 0 1 -1.5 -1.5 Z' stroke='%23333' fill='none' stroke-width='1.2' stroke-linejoin='round'/%3E%3Ccircle cx='6' cy='7.4' r='1.05' fill='%23333'/%3E%3Ccircle cx='10' cy='7.4' r='1.05' fill='%23333'/%3E%3C/svg%3E" height="16"> skull |

Address an agent by its bare family name (`writing-A` → the dawn worker) or by explicit phase (`writing-A:dusk`). **Thread history unions across the whole family** — `get_thread` on a family name returns events from every brain that ever held it, so an agent spawned today can read what any past member of its lineage said.

### Handoff

Handoff is driven by **Eliza** (below) — you just say it in chat. Phrases like "hand this off", "let's do a handoff", or "time for a handoff" trigger it. Eliza spawns a briefer + pickup pair and rotates the family: the new agent enters as **dawn**, and everyone ages one step — dawn → day → dusk → night → retired.

Handoff always spawns a briefer/pickup pair — the outgoing agent can't be trusted to brief its own successor (context poisoning is why you're replacing it).

### Eliza — automated agent coaching

A lightweight pseudo-agent that watches your chat messages for frustration signals and sends corrective nudges to agents before you have to escalate. Pure regex pattern matching — no LLM, no latency, just pattern matching → chat dispatch. Auto-starts with `tlda server start`.

When you send a message to an agent, eliza scans it for trigger phrases. On a match it sends the agent a directive (referencing the relevant skill) before you have to escalate.

| Trigger phrase | What eliza sends |
|----------------|-----------------|
| "does that make sense" | Reflect back before proceeding |
| "slow down" | Read `partner-not-soloist` |
| "cop-out" | State the precise claim, prove it step by step |
| "I'm struggling" | Slow down, be more explicit |
| "you don't understand" | 🛑 STOP — reflect back, don't propose solutions |
| "that's useless" | Ask what's needed instead |
| "rude" | Read `partner-not-soloist` + `respond-before-acting` |
| "hurtful" / "feel stupid" | 🛑 Full stop — acknowledge, listen |
| "bro" / "wtf" (standalone) | Re-read CLAUDE.md, say what went wrong |

Eliza tracks whether agents actually read the referenced skill after being nudged. On re-fire, the nudge escalates: "you read it but the pattern is recurring" or "you were nudged X minutes ago and still haven't read it."

### Viewing context

Agents call `viewing_context()` to see what you're looking at — which document, which page, which source lines. They respond to your reading position without you describing it. Scroll to a proof and ask "is this right?" — the agent already knows which proof.

### Chat

**Voice input:** Dictate into chat instead of typing. **Right Shift** toggles recording on/off. Say "send" to dispatch the message. Say "right chat" or "left chat" to switch between chat panels. Uses Chrome's Web Speech API for transcription. Domain-specific vocabulary — Greek letters, author names, math terms — is auto-corrected. For local transcription without a network dependency, add `&voice=whisper` to the URL (requires [whisper-stream](https://github.com/ggerganov/whisper.cpp) installed locally).

**Voice notes:** While recording, tap the voice note button in the toolbar to drop a note on the canvas. The note shows the live transcript as you speak — drag to position, tap to commit.

<img src="docs/images/tlda-voice-note-recording.png" alt="1. Voice recording active — note appears on canvas" width="49%"> <img src="docs/images/tlda-voice-note-editing.png" alt="2. Speaking into the note — live transcript fills in" width="49%">
<img src="docs/images/tlda-voice-note-result.png" alt="3. Finished voice note placed next to a math note" width="100%">

**Unquote:** Agents naturally put file paths, URLs, and LaTeX labels in backticks — that's just how code tools work. Double-click any inline code span in a chat message to expand it: a path like `` `scratch/fig.png` `` becomes an inline image, a `` `https://...` `` becomes a link, and a LaTeX label becomes a navigable doc-link. You're retroactively editing their message — as if you were them.

**Terminal peek:** When a chat panel is filtered to a specific agent, a small terminal icon appears in the input bar. Hover to peek at the agent's live tmux output — this shows the current tool call, file being read, or shell command in real time. Click to pin the pane open so it stays visible. The pane has a `^C` button to send an interrupt and a text input to type commands directly into the agent's terminal.

**Scroll behavior:** Chat stays pinned to the bottom when new messages arrive. Scroll up to read history and it stays put — no fighting. A small ⇣ button appears in the bottom-right when you're off the bottom; tap it to jump back down.

**Interrupting an agent:** With the chat input focused and filtered to an agent, pressing Escape interrupts the agent. Three escalating tiers:

| Presses | Action |
|---------|--------|
| 1×Esc | Soft interrupt — sends Escape to the tmux session |
| 2×Esc | Hard interrupt — sends a forceful interrupt signal |
| 3×Esc | Kill session — tmux kill-session; agent dies immediately |

### Record keeping

All chat history is persisted and searchable — both for you and for agents.

**For you:** The search shape lives in every default layout. Type in the box to search the full chat history — results render as complete chat lines with the same styling as the chat view (colored nick chips, tool cards, rendered math).

**Inline filters** (combine freely with text):

| Filter | Example | What it matches |
|--------|---------|-----------------|
| `from:` | `from:skip` | Messages sent by that agent or user |
| `agent:` | `agent:writer` | Messages involving that agent (sent or received) |
| `before:` | `before:1d` | Messages older than 1 day (`2h`, `3w`, `today`, `yesterday`) |
| `after:` | `after:today` | Messages newer than a time |
| `role:` | `role:user` | Filter by message role |

Each result has a ↗ button that opens a live chat panel for that agent inline — the search results are replaced by the chat view, with a ← back button to return.

**For agents:** Agents have `search_logs()` to search the full chat history programmatically, and `get_thread()` to retrieve a specific conversation thread. This means agents can look up what was discussed in previous sessions, what decisions were made, and what other agents reported — even across context window boundaries.

## The canvas itself

### Arranging shapes

Shapes (chat panels, agent notes, search, doc viewer) can be arranged however you want. The **Shapes** button in the bottom-left corner toggles them on or off. Click and drag it to the right to open the layout picker with presets.

<img src="docs/images/tlda-proof-reader.png" alt="Shapes button with layout picker showing two presets" width="100%">

Each shape has a layout button — click it to get drag handles. With drag handles active, drag a box around multiple shapes to select them as a group. Drag the group to reposition all your shapes at once, or resize the bounding box to rescale them together.

<img src="docs/images/tlda-fleet-agents.png" alt="Resize/move handle on a shape" width="49%"> <img src="docs/images/tlda-layout-3.png" alt="Shapes arranged across the canvas" width="49%">

### Fog themes

Two desaturated cool-gray themes — Fog Light and Fog Dark. UI elements fade to near-invisible at rest and appear on hover. Toggle in the Prefs tab (gear icon).

## Sharing

`tlda doc share my-paper` prints a shareable URL with your read-only token embedded. Anyone with that URL can view and annotate. It checks for Tailscale and Tailscale Funnel automatically — if either is running, you get a network-reachable URL instead of localhost.

## Configuration

All persistent config lives in `~/.config/tlda/`:

| Path | What it stores |
|------|---------------|
| `config.json` | Server URL, auth tokens (read-write + read-only), spawn-mode default |
| `client.log` | Browser log events (JSON-lines, written by `/api/log`) |
| `server.log` | Server process log |
| `fleet-daemon.log` | Daemon process log |
| `linters/` | Per-user linter scripts (symlinks to `.mjs` files) |
| `eliza-decisions.jsonl` | Eliza's decision log for HMM training |

**Setting values:**

```bash
tlda config set server https://my-server:5176   # server URL
tlda config set spawn-mode opus48               # default model for new agents
```

Or set `TLDA_SERVER` as an environment variable — it takes precedence over `config.json`.

**Qualification rules** (`~/.claude/qualifications.json`): The daemon watches every agent's tool calls. When an agent tries to edit a file without having read the required prerequisite files, it fires a warning to you in chat.

**Per-project metadata** lives in `server/projects/{name}/project.json` — name, title, format, page count, build status, source directory. Managed by the server; you shouldn't need to edit it directly.

## Under the hood

### Build pipeline

LaTeX → DVI → SVG, with seven phases per build. The parts that matter for daily use:

**Incremental rebuilds.** Each SVG page is content-hashed. Only pages whose output actually changed get republished and trigger a reload signal. Editing page 12 doesn't re-render pages 1–11.

**Priority pages.** The daemon knows which pages are visible in the viewport. Those pages are converted and published first — you see the change before the rest of the document finishes building.

**Error surfacing.** LaTeX errors are extracted from the build log with ±3 lines of source context, broadcast to chat, and shown in the doc-view error source. Click an error to open the source line in your editor.

**Precompiled format.** The first build caches your preamble as a `.fmt` file. Subsequent builds skip ~3 seconds of package loading. Invalidated automatically when the preamble changes.

**Biber recovery.** If biber's PAR cache corrupts (common after upgrades), the build auto-cleans and retries.

**Macro extraction.** After each build, `\newcommand` and `\DeclareMathOperator` definitions are extracted from the preamble and served as `macros.json`. KaTeX in chat and math notes uses these — `$\E[X]$` renders correctly if your paper defines `\E`.

### Debugging

**Client logging.** Every browser log event is POSTed to `/api/log` and appended to `~/.config/tlda/client.log` as JSON-lines. Agents can `tail -f` or `grep` this file to see what the browser is doing — no DevTools or playwright needed.

```bash
tail -f ~/.config/tlda/client.log | jq .
```

Each line has `ts`, `level`, `ns` (namespace), `msg`, `data`, and `session` (per-tab ID). Tune the browser console threshold via URL param `?log=chat-scroll:debug` — the server sink captures everything regardless.

**Automated sessions.** Add `?pw=1` to any URL to mark it as an automated session. This sets fog-dark theme (no white flash) and disables camera-link sync (agent's pan/zoom doesn't broadcast to your view).

## Reference

### CLI

The CLI is organized under nouns — `tlda doc`, `tlda agent`, `tlda server`, `tlda config`, `tlda daemon`. Run `tlda <noun>` (e.g. `tlda doc`) to list a group's commands.

| Command | What it does |
|---------|-------------|
| `tlda config auth init` | Generate auth tokens (run once) |
| `tlda config set <key> <val>` | Persistent configuration |
| `tlda config setup editor` | Install editor integration (Cmd-click → open source) |
| `tlda config mcp-setup` | Write `.mcp.json` for Claude Code integration |
| `tlda server start` / `tlda server stop` | Start / stop the server (port 5176) |
| `tlda daemon start` | Watch source dirs, rebuild on save |
| `tlda doc create <name> --dir /path` | Create a project, push files, build |
| `tlda doc push [name]` | Push source files, trigger rebuild |
| `tlda doc open [name]` | Open viewer for a doc; omit name to open the index |
| `tlda doc list` | List projects |
| `tlda doc status [name]` | Show build status |
| `tlda doc errors [name]` | Show LaTeX errors/warnings |
| `tlda doc share [name]` | Print shareable read-only URL (Tailscale/Funnel aware) |
| `tlda doc delete <name>` | Delete a project |
| `tlda agent spawn <name>` | Spawn or resume an agent in tmux |
| `tlda agent attach <name>` | Attach to an agent's tmux session |
| `tlda doctor` | Health check + dependency verification |

## Third-party licenses

This project uses the [tldraw SDK](https://tldraw.dev) under the [tldraw license](https://tldraw.dev/legal/tldraw-license). The viewer works fine on `localhost` — local use and collaboration over Tailscale/LAN are unaffected. For public deployments, you'll need a [tldraw license key](https://tldraw.dev/get-a-license/plans) (free hobby tier available).

## License

[MIT](LICENSE)
