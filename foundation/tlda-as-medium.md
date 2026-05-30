# tlda as the Medium

What tlda is, technically. The shared substrate Skip and agents work in.

This is descriptive — for reference. Authoritative configuration / commands / API live in `CLAUDE.md` and the codebase.

---

## At one glance

A canvas-based document review and collaboration system. Two parties (Skip + agents) work in the same space, on the same documents, with the same conversations.

```
Skip (human, voice/touch)                 Agents (programmatic, MCP)
       │                                          │
       ▼                                          ▼
┌─────────────────────────────────────────────────────────────┐
│  tlda canvas (browser, served from localhost:5176)         │
│                                                             │
│  Document viewer  ←→  Fleet chat  ←→  Agent panel  ←→ ... │
│                                                             │
└─────────────────────────────────────────────────────────────┘
       │                                          │
       ▼                                          ▼
   (mouse, voice,                          (MCP tools,
    iPad, hover)                            tmux panes,
                                            shell)
```

Both surfaces talk to the same backend. Both see the same state in their own way.

## The pieces

### Documents

LaTeX papers, markdown notes, PDFs, HTML — anything that can be rendered. Each project is a directory; tlda's daemon watches for changes and triggers a build, which produces SVGs (for LaTeX), HTML (for markdown), or just serves the file.

The viewer renders documents page-by-page on the canvas, anchored in source lines. Annotations (highlights, sticky notes, arrows, pens) are stored as TLDraw shapes with source-line anchors that survive document rebuilds.

### Fleet chat

Each agent has a chat presence. Messages appear as chat-line shapes on the canvas in `FleetChatShape` instances. Skip filters his chat-shape view (typically one-on-one with the agent he's currently talking to).

Chat messages support markdown, KaTeX math, code blocks, lifecycle cards (delegate / done / bounced), tool-result cards (search results, thread reads, screenshots), and content chips (drag-to-share document regions).

### Agents

Each agent is a Claude Code instance running in a tmux pane. Identified by a fleet ID (`fleet:abc12345`) and a friendly name (`help-m7`). Spawned via `fleet-spawn` (tmux-based) or via `mcp__tlda__spawn` (MCP wrapper).

Agents communicate via the fleet daemon, which writes/reads from the tlda server. Skip sees agents as participants in chat, not as backend mechanisms — they have names, they have presences, they have draggable handles.

### The daemon

A long-running process (`bin/fleet-daemon.mjs`) that watches:
- Source directories of every project
- Claude Code session JSONLs on this machine
- WebSocket connection to the tlda server

It pushes events upstream — source changes (triggering rebuilds), activity events (so Skip sees agent tool calls in chat), terminal-user chat (when humans type in tmux). It receives events downstream — RPCs to interrupt agents, send keystrokes, capture panes.

### The server

`server/unified-server.mjs` — single Node process serving the SPA, the API, the Yjs sync rooms, and the document assets. Runs on port 5176 by default. Started via `tlda server start`.

### MCP

Two MCP servers:
- **fleet** (`mcp-server/fleet.mjs`) — tools for chatting, delegating, reading threads, managing agents, recording playbacks. The "social" surface for agents.
- **tlda** (`mcp-server/tlda-mcp.mjs`) — tools for document operations (annotations, screenshots, pushing files, builds). The "document work" surface for agents.

## Configuration

- `~/.config/tlda/config.json` — server URL config
- `~/work/tlda/CLAUDE.md` — project-specific agent instructions
- `~/.claude/CLAUDE.md` — global agent instructions
- `~/.claude/projects/<slug>/memory/` — per-project auto-memory (now symlinked to `~/work/dot-claude-memory/<slug>/`)

## Where to look for what

- **Document loading / SVG rendering** — `src/svgDocumentLoader.ts`, `src/SvgDocument.tsx`
- **Chat shape (the heart of fleet chat)** — `src/shapes/FleetChatShape.tsx`
- **Chat rendering (HTML structure of messages)** — `src/fleet/chat-render.mjs`, `src/fleet/activity-render.mjs`
- **HUD overlay / fleet positioning** — `src/overlays/FleetHUD.tsx`
- **MCP tool implementations** — `mcp-server/fleet.mjs`, `mcp-server/index.mjs` (tlda)
- **Server endpoints** — `server/unified-server.mjs`, `server/routes/*.mjs`
- **Daemon** — `bin/fleet-daemon.mjs`
- **Spawn / agent lifecycle** — `bin/fleet-spawn.py`

## How the surfaces talk

When Skip drags a chip → JS handler in `FleetChatShape.tsx` → emit a tldraw shape change → Yjs sync → server stores → broadcast to other clients (including agents via the chat rendering pipeline).

When an agent calls `chat()` → MCP tool in `mcp-server/fleet.mjs` → POST to the server → server emits via WebSocket → `FleetChatShape.tsx` renders the message in Skip's view.

When the daemon detects a document source change → POST to server → trigger build → SVGs regenerated → server emits `signal:reload` → viewer reloads.

When an agent runs a tool that's in `PRETTY_PRINT_TOOLS` (`get_thread`, `search_logs`, `screenshot`) → daemon parses the result → emits a `_prettyResult` activity event with rendered HTML → `chat-render.mjs` renders it as a card.

## Major design choices (and why)

- **Single port, single process** — tlda's server, Yjs sync, and SPA all on the same Node process at 5176. Removed the old separate-fleet-app architecture because cross-process state was a constant source of bugs and Skip's mental model didn't include "two apps."

- **Fleet chat in the document margin** — not a separate app. Skip needs to see the chat right next to the document so the transition between talking and looking is shallow. Originally fleet was its own thing; this caused him to talk about the doc, then open the doc, and discover the agent did something he didn't expect. Felt like being lied to. Merging fleet into tlda removed that.

- **Memory in its own repo** — `~/work/dot-claude-memory/` is a separate git repo, symlinked into `dot-claude/memory` and into each project's `.claude/projects/<slug>/memory/`. Was previously gitignored under `.claude/projects/`; refactored 2026-05-09 so memory is versioned (cleanup work was unsafe on un-versioned files).

- **TLDraw-native UI for canvas elements** — anything on the canvas uses TLDraw's shape system, props, event model. Don't layer a different UI framework on top; that breaks selection / editing / sync. Shape state lives in props, not in coordinated meta fields.

- **No backward compatibility** — when interfaces change, just change them. No compat shims, no migration layers. Callers adapt. Code stays clean.

- **Voice/touch first, not keyboard first** — keybindings exist (`r` for proof reader, `m` for math note, `n`/`p` for diff navigation) but they're not the primary access path. Anything important works without keyboard. Skip's iPad reviews have no keyboard at all; iPad workflows must work end-to-end with touch alone.

## The build pipeline (LaTeX projects, briefly)

`tlda watch start` runs the fleet-daemon. Daemon watches each project's source dir for changes. On change, POST to server. Server runs the build:

1. `latexmk` → DVI
2. `dvisvgm` → per-page SVG
3. `synctex` parsing → source-line anchors
4. Proof-pairing analysis → cross-reference data

Output goes to `server/projects/<name>/output/`. Multi-target builds use flat `<texBase>-page-N.svg` naming; staleness tracked via `build.stamp`. xr / xr-hyper auto-detected from `\externaldocument{}` declarations in `.aux` files.

## What the medium gives both parties

Both Skip and the agents have:
- A persistent shared canvas (state survives reloads)
- Real-time sync (Yjs)
- Document version-tagged conversation
- Cross-references between chat, document regions, and agent state
- Replayable history (chat + edits + agent activity)
- The ability to point at things ("this region," "this label," "this agent")

This is the *medium* — the substrate that makes the mirror principle technically possible. Without persistent shared state, real-time sync, and cross-reference machinery, Skip and the agents could not actually see what the other is doing. The technology is the mirror's enabling layer.

---

*See also: `mirror-principle.md`, `agent-experience.md`, `skip-experience.md`. Authoritative configuration and current commands: `~/work/tlda/CLAUDE.md`.*
