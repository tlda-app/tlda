# Changelog

## v0.2.0 — 2026-05-18

The theme of this release: **you don't have to leave the canvas.** v0.1.0 was "it works" — you could view papers, annotate, and chat with agents. But you were still bouncing to the terminal for spawning agents, approving permissions, and checking what agents were doing. This release moves all of that onto the canvas.

Two related ideas run through most of the new features. First, agents are always reachable — they hibernate instead of dying, and a chat message wakes them up. Second, agent work is visible in confined spaces — scratch sections appear in the rendered document, file-backed stickies appear on the canvas. You interact with what agents are doing where you already are.

### Agent hibernation and wake-on-message

Agents now hibernate after 20 minutes of inactivity instead of dying. When you send a chat message to a hibernating agent, it wakes up automatically — no `tlda spawn` needed. Just talk to them. The agents panel shows who's awake and who's hibernating; spawn new agents directly from the panel.

### Permission prompts on the canvas

When an agent hits a Claude Code permission prompt (file edit, bash command, etc.), the prompt surfaces as an approve/deny card in fleet chat. You can authorize work without switching to the terminal. Plan-mode approval prompts are surfaced too.

### Terminal peek

Hover the terminal icon on a chat panel to see the agent's live tmux output — current tool call, file being read, shell command. Click to pin it open. The pane has a `^C` button and a text input for typing directly into the terminal.

### Agent work on the canvas

Two new ways for agents to work in visible, confined spaces you can interact with:

**Input scratch** (LaTeX projects) — agents write into the document via `input_scratch`, which creates `\input`-ed scratch sections. Each section is signed (agent name + timestamp), styled with `xcolor`, and appears in the rendered paper immediately. You see agent work in the document as it happens, not buried in a terminal.

**File-backed stickies** — agents write a `.md` file and it appears as a synced math note on the canvas. Drop a `.md` chip from chat onto the canvas to create one. Edits propagate bidirectionally — change the file or the note and the other updates. Notes show a visual indicator when file-backed.

### Eliza — automated agent coaching

A lightweight pseudo-agent that watches your chat messages for frustration signals ("cop-out", "you don't understand", "slow down") and sends corrective nudges to agents before you have to escalate. Pure regex pattern matching — no LLM, no latency. Includes education tracking (did the agent actually read the referenced skill?) and manager escalation ("talk to your manager").

### Ribbon

A per-user annotation strip on the left edge of each page for tracking reading comprehension. Five status colors (unchecked through fully verified), click to cycle. Survives document rebuilds via source-line anchoring with edit resilience — deletions, insertions, and splits are tracked and remapped. Custom eraser and highlighter tools that respect the ribbon zone.

### Fog themes

Two new desaturated cool-gray themes: Fog Light and Fog Dark. Canvas is mid-tone, chrome is lighter. UI elements fade to near-invisible at rest and appear on hover. Toggle in the Prefs tab (gear icon).

### Highlight monitoring

Agents subscribed via `tlda monitor` receive highlight notifications automatically — when you draw on the page, they see the text under your stroke and the source context. Build linter findings (parenthetical asides, passive voice, grammar in display math) are routed to the most recent editor in chat.

### Unquote

Double-click any backtick-wrapped content in a chat message to expand it: file paths become inline images, URLs become links, LaTeX labels become navigable doc-links.

### Fleet search

A searchable shape on the canvas for the full chat history. Inline filters (`from:`, `agent:`, `before:`, `after:`, `role:`). Results render as styled chat lines. The ↗ button on each result opens a live chat panel for that agent inline.

### Writing linters

Per-user linter scripts in `~/.config/tlda/linters/` run automatically after every build. Only new text is checked (diff-scoped). Ships three opt-in linters: parenthetical asides, passive voice, and grammar in display math. Drop any Node.js script there to add your own.

### Other notable changes

- **Axis-lock panning** — pan locks to the dominant axis after 15px of movement, resets after a 250ms pause
- **Layout presets** — SVG icons for preset layouts, wide and grid options
- **Doc clips** — peel a region from the doc viewer onto the canvas as a standalone shape
- **Version history** — edit timeline dots on the shadow history scrubber
- **Magnet scroll** — hard-lock scroll mode (click the magnet icon) for guaranteed live tracking in chat
- **`tlda doctor`** — health check and dependency verification
- **`tlda share`** — prints a shareable URL (Tailscale/Funnel aware)
- **`tlda attach`** — attach to an agent's tmux session
- **Multi-document projects** — `xr`/`xr-hyper` cross-references automatically build companion documents
- **KaTeX in tool cards** — `.tex` Write/Edit cards render math inline
- **Cmd-click navigation** — click rendered text to open the source at that line in your editor
- **Source map** — unified label index and bidirectional source↔page lookup
- **Daemon reliability** — persistent backing file registry, stale watcher detection, WS reconnect resilience
- **Process reapers** — zombie WebSocket connections and orphan playwright chromiums are cleaned up automatically

### Breaking changes

None — this release is backwards compatible with v0.1.0 project data.

## v0.1.0 — 2026-04-27

Initial public release. LaTeX rendering, Yjs real-time sync, MCP tools, fleet chat, version history, voice input.
