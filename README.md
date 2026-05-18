<p align="center">
  <img src="public/logo.svg" width="260" height="160" alt="tlda">
</p>

A collaborative workspace for reading and writing LaTeX documents with AI agents and human collaborators. Renders your compiled paper exactly as it would appear in published form, on a shared canvas where everyone — humans and agents — can annotate, highlight, chat, and point at things in real time.

<p align="center">
  <img src="docs/images/tlda-overview.png" alt="tlda in action — paper review with fleet chat" width="100%">
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
tlda config init                                   # generate auth tokens (one time)
tlda server start                                  # start the server
tlda create my-paper --dir /path/to/paper --main paper.tex
tlda open my-paper                                 # open the viewer for this doc
tlda open                                          # open the index (lists all docs)
```

`tlda config init` generates a read-write token (for you) and a read-only token (for sharing). Your tokens are stored in `~/.config/tlda/config.json` and used automatically.

Run `tlda doctor` to check that all dependencies are installed and the server is healthy.

## Working with agents

tlda integrates with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) via an MCP server. In your paper directory, run:

```bash
tlda mcp-setup
```

This writes `.mcp.json` so Claude Code can see tlda's tools. Open Claude Code in that directory and the `tlda` and `fleet` tool sets are available. Agents can see your highlights, drop anchored notes and questions on the document, read the text you're pointing at, monitor for changes, and edit your LaTeX source directly.

You talk to agents via voice or text in chat panels that live on the canvas. They respond in the same space — with rendered math, clickable labels, and inline diffs of their edits.

### Fleet: managing multiple agents

Fleet is the coordination layer for running multiple Claude Code agents simultaneously. Each agent runs in its own tmux session with a persistent identity.

```bash
tlda spawn proof-writer                            # respawn an existing agent (resume session)
tlda spawn --fresh reviewer --cwd /path/to/paper   # spawn a brand new agent
tlda spawn --fresh writer --model claude-opus-4-6   # specify a model
```

Each agent gets its own tmux session (`fleet-<name>`) that persists across restarts — `tlda spawn reviewer` without `--fresh` resumes where that agent left off.

**Hibernation:** Agents hibernate after 20 minutes of inactivity instead of dying. Send a chat message to a hibernating agent and it wakes up automatically — no `tlda spawn` needed. Just talk to them.

**Spawning from the panel:** The agents panel shows all your agents — who's awake, who's hibernating, context remaining, current task. To spawn a new agent, use the input at the bottom: the folder button selects a project (which sets the working directory), and you type a name. The syntax is `project:name` — e.g. `--draft:jerry`. If you don't provide a name, one is auto-generated.

<img src="docs/images/tlda-agents-panel-projects.png" alt="Agents panel showing awake and hibernating agents" width="32%"> <img src="docs/images/tlda-agents-panel-spawn.png" alt="Project selector dropdown" width="32%"> <img src="docs/images/tlda-agents-panel-spawn-input.png" alt="Spawn input with project:name syntax" width="32%">

**Permission prompts:** When an agent hits a Claude Code permission prompt, it surfaces as an approve/deny card in fleet chat. You can authorize work without switching to the terminal.

Agents coordinate using fleet MCP tools: `chat()` to message each other or you, `delegate()` to assign tasks, `spawn()` to start new agents, `wiretap()` to listen in on other conversations, and `monitor_add()` to subscribe to document changes.

The fleet HUD in the viewer shows all active agents, their current activity (tool calls, file edits), and lets you chat with any of them. Drag an agent's name onto a chat panel to filter to that conversation.

<img src="docs/images/tlda-drag-to-filter.png" alt="Dragging an agent label onto a chat panel to filter" width="49%"> <img src="docs/images/tlda-chat-filter-hover.png" alt="Hovering over the chat filter selector" width="49%">

### Chat

**Voice input:** Dictate into chat instead of typing. **Right Shift** toggles recording on/off. Say "send" to dispatch the message. Say "right chat" or "left chat" to switch between chat panels. Uses Chrome's Web Speech API for transcription. Domain-specific vocabulary — Greek letters, author names, math terms — is auto-corrected. For local transcription without a network dependency, add `&voice=whisper` to the URL (requires [whisper-stream](https://github.com/ggerganov/whisper.cpp) installed locally).

**Voice notes:** While recording, tap the voice note button in the toolbar to drop a note on the canvas. The note shows the live transcript as you speak — drag to position, tap to commit.

<img src="docs/images/tlda-voice-note-recording.png" alt="1. Voice recording active — note appears on canvas" width="49%"> <img src="docs/images/tlda-voice-note-editing.png" alt="2. Speaking into the note — live transcript fills in" width="49%">
<img src="docs/images/tlda-voice-note-result.png" alt="3. Finished voice note placed next to a math note" width="100%">

**Unquote:** Agents naturally put file paths, URLs, and LaTeX labels in backticks — that's just how code tools work. Double-click any inline code span in a chat message to expand it: a path like `` `scratch/fig.png` `` becomes an inline image, a `` `https://...` `` becomes a link, and a LaTeX label becomes a navigable doc-link. You're retroactively editing their message — as if you were them.

**Terminal peek:** When a chat panel is filtered to a specific agent, a small terminal icon appears in the input bar. Hover to peek at the agent's live tmux output — this shows the current tool call, file being read, or shell command in real time. Click to pin the pane open so it stays visible. The pane has a `^C` button to send an interrupt and a text input to type commands directly into the agent's terminal.

<img src="docs/images/tlda-terminal-peek.png" alt="Pinned terminal pane showing agent tool calls alongside chat" width="100%">

**Scroll modes:** Smart scroll (default) tries to keep the view at the bottom when messages arrive but backs off when you've scrolled up to read. Hard-lock mode (click the magnet icon to the left of the chat input) scrolls to the bottom unconditionally on every update. Two modes, two tradeoffs — use smart scroll when reading back, hard-lock when you want guaranteed live tracking.

**Interrupting an agent:** With the chat input focused and filtered to an agent, pressing Escape interrupts the agent. Three escalating tiers:

| Presses | Action |
|---------|--------|
| 1×Esc | Soft interrupt — sends Escape to the tmux session |
| 2×Esc | Hard interrupt — sends a forceful interrupt signal |
| 3×Esc | Kill session — tmux kill-session; agent dies immediately |

### Record keeping

All fleet chat history is persisted and searchable — both for you and for agents.

**For you:** The fleet search shape lives in every default layout. Type in the box to search the full chat history — results render as complete chat lines with the same styling as the fleet chat view (colored nick chips, tool cards, rendered math).

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

### Arranging the canvas

Fleet shapes (chat panels, agent notes, search, doc viewer) can be arranged however you want. The **Fleet** button in the bottom-left corner toggles them on or off. Click and drag it to the right to open the layout picker with presets.

<img src="docs/images/tlda-proof-reader.png" alt="Fleet button with layout picker showing two presets" width="100%">

Each shape has a layout button — click it to get drag handles. With drag handles active, drag a box around multiple shapes to select them as a group. Drag the group to reposition all your shapes at once, or resize the bounding box to rescale them together.

<img src="docs/images/tlda-fleet-agents.png" alt="Resize/move handle on a fleet shape" width="49%"> <img src="docs/images/tlda-layout-3.png" alt="Fleet shapes arranged across the canvas" width="49%">

## Core features

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

### Version history

A small stack of build timestamps sits in the top-left corner of the canvas. The most recent build is at the top; up to five recent versions are shown, fading out toward the bottom.

Click any older timestamp to open a history column to the right of your document — the paper as it was at that build, side by side with the current version. A slider appears at the bottom of the screen to scrub through your full build history.

<img src="docs/images/tlda-compare-mode.png" alt="Side-by-side version comparison" width="100%">

A gray divider bar appears between the two columns. Drag it left or right to move the columns closer together; drag it up or down to vertically align the text between them.

Click the current (top) timestamp to dismiss the history column.

**How it works:** Every successful build is automatically committed to a per-project shadow repo. The full history of your document is preserved regardless of your own git habits. Chat messages are tagged with the version you're viewing, so agents always know which version of the document you're looking at.

**Mirroring** (optional): enable on the project's index page to have each build automatically synced to your working copy as a git commit. Shadow versions are tagged in your repo, making it easy to map between shadow versions and your own commits.

### Source-anchored annotations

Notes are tied to source lines via synctex, so they survive rebuilds and recompilations. Build errors appear anchored to the source line, clickable to open in your editor.

## Power features

### Review & interaction

**Highlighting:** To activate highlighting, grab the highlighter button in the bottom-right corner and drag it up — this opens the highlighter zone on the right edge. Put your cursor down in the zone and drag to select a color, eraser, or other tool. Each color has an assigned meaning — question, notation, expand, cut, etc. — shown in a HUD when you select a color.

<img src="docs/images/tlda-highlighter-toolbar.png" alt="Highlighter zone activated — color dots on the right edge" width="49%"> <img src="docs/images/tlda-color-picker.png" alt="Selecting a color from the highlighter strip" width="49%">

Draw on the page and agents read the text under your stroke. A source context card pops up showing the LaTeX source and the text you selected. Drag the card to a chat panel to share it as a chip, or agents can subscribe via `tlda monitor` to receive highlight notifications automatically.

<img src="docs/images/tlda-highlight-and-notes.png" alt="Highlights with source context cards and math notes" width="49%"> <img src="docs/images/tlda-highlight-chip.png" alt="Highlight chip dragged into chat" width="49%">

**Ribbon:** A per-user annotation strip on the left edge of each page for tracking reading comprehension. Five status colors (unchecked through fully verified), click to cycle. Survives document rebuilds via source-line anchoring with edit resilience — deletions, insertions, and splits are tracked and remapped.

### Writing tools

**Input scratch** (LaTeX projects): Agents write into the document via `input_scratch`, which creates `\input`-ed scratch sections. Each section is signed (agent name + timestamp), styled with `xcolor`, and appears in the rendered paper immediately. Agent work shows up in the document as it happens, not buried in a terminal.

**File-backed stickies:** Agents write a `.md` file and it appears as a synced math note on the canvas. Drop a `.md` chip from chat onto the canvas to create one. Edits propagate bidirectionally — change the file or the note and the other updates.

**Writing linters:** Per-user linter scripts in `~/.config/tlda/linters/` run automatically after every build. Only new text is checked (diff-scoped). Findings are posted to fleet chat and routed to the most recent editor. Ships three opt-in linters:

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

**Qualification rules** (`~/.claude/qualifications.json`): The fleet daemon watches every agent's tool calls. When an agent tries to edit a file without having read the required prerequisite files, it fires a warning to you in chat.

### Editor & project

**Editor integration:** Cmd-click (Mac) or Ctrl-click (Linux) on any rendered text to open the source file at that line in your editor. Highlight cards also have an edit button (✎) that does the same thing.

<img src="docs/images/tlda-open-in-editor.png" alt="Cmd-click to open source in editor" width="100%">

One-time setup:

```bash
tlda setup editor                  # Zed (default)
tlda setup editor --editor code    # VS Code
tlda setup editor --editor cursor  # Cursor
tlda setup editor --editor nvim    # Neovim
```

**Multi-document projects:** If your project uses `xr` or `xr-hyper` to cross-reference a companion document (e.g. a supplement), the build pipeline detects `\externaldocument{X}` and automatically builds both. Both documents share the same project and appear together on the canvas.

**Fog themes:** Two desaturated cool-gray themes — Fog Light and Fog Dark. UI elements fade to near-invisible at rest and appear on hover. Toggle in the Prefs tab (gear icon).

## Reference

### CLI

| Command | What it does |
|---------|-------------|
| `tlda config init` | Generate auth tokens (run once) |
| `tlda server start` | Start the server (port 5176) |
| `tlda server stop` | Stop the server |
| `tlda create <name> --dir /path` | Create a project, push files, build |
| `tlda push [name]` | Push source files, trigger rebuild |
| `tlda watch-all start` | Watch all projects for changes, auto-rebuild on save |
| `tlda open [name]` | Open viewer for a doc; omit name to open the index |
| `tlda list` | List projects |
| `tlda status [name]` | Show build status |
| `tlda errors [name]` | Show LaTeX errors/warnings |
| `tlda spawn <name>` | Spawn or resume a fleet agent in tmux |
| `tlda setup editor` | Install editor integration (Cmd-click → open source) |
| `tlda share [name]` | Print shareable read-only URL (Tailscale/Funnel aware) |
| `tlda mcp-setup` | Write `.mcp.json` for Claude Code integration |
| `tlda doctor` | Health check + dependency verification |
| `tlda attach <name>` | Attach to an agent's tmux session |
| `tlda config set <key> <val>` | Persistent configuration |
| `tlda delete <name>` | Delete a project |

Configure with `tlda config set server <url>` or the `TLDA_SERVER` environment variable.

### Other formats

LaTeX is the primary format. tlda also supports:

| Format | Command |
|--------|---------|
| **Markdown** | `tlda create notes --format markdown --dir /path` |
| **HTML** (Quarto) | `tlda create book --format html --dir _book-tlda` |
| **Slides** (reveal.js) | `tlda create deck --format slides --dir /path` |

### Sharing

`tlda share my-paper` prints a shareable URL with your read-only token embedded. Anyone with that URL can view and annotate. It checks for Tailscale and Tailscale Funnel automatically — if either is running, you get a network-reachable URL instead of localhost.

### Figures

LaTeX runs in DVI mode, so `\includegraphics` produces placeholder boxes that get patched with actual images.

**Supported:** `.svg` (preferred), `.png`, `.jpg`, `.eps`

**For PDF figures:** provide an SVG with the same basename and dimensions. If your LaTeX says `\includegraphics{plot.pdf}`, the pipeline uses `plot.svg` instead.

## Third-party licenses

This project uses the [tldraw SDK](https://tldraw.dev) under the [tldraw license](https://tldraw.dev/legal/tldraw-license). The viewer works fine on `localhost` — local use and collaboration over Tailscale/LAN are unaffected. For public deployments, you'll need a [tldraw license key](https://tldraw.dev/get-a-license/plans) (free hobby tier available).

## License

[MIT](LICENSE)
