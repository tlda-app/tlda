# tlda documentation plan + skeleton

Goal (per Skip, 2026-06-22): the app is undocumented and confusing; nobody who
works on it has a clear model. Produce **two** docs, and where the structure is
counterintuitive, fix it so less doc is needed.

1. **`docs/architecture.md`** — for agents working *on* the app. The real model:
   what the pieces are, where they run, how data flows, the invariants.
2. **`docs/usage.md`** — for agents working *in* the app (reviewing papers,
   spawning, chatting). Enough that they aren't confused by the gotchas.

## How this gets built (cheap agents, verified)

Each section below is a bounded chunk = one cheap-agent assignment:
> "Read <these files>. Describe what this subsystem does and how it connects to
> the others. Cite `file:line` for every claim. Do not speculate — if unclear,
> say so."

**I (rescue-lead) verify every drafted section against the actual code before it
lands.** Cheap-but-verified, never cheap-and-trusted — confident-wrong docs are
the exact thing we're trying to kill. Don't fan agents out until disk is healthy
and Skip okays the spend.

Items marked **[VERIFY]** are my current understanding from this session +
CLAUDE.md and must be checked against code by the drafting agent, not taken as
ground truth.

---

## architecture.md — skeleton

### 0. The one-paragraph model
Single server process on Fly (Express + Yjs WS + SPA + REST). Per-machine
**daemons** connect *out* to it and are the only bridge to each machine's files,
tmux, and agent sessions. The browser talks to the server (Yjs + signals). There
is **no local server** in normal use — `air` runs a daemon, not a server. [VERIFY]

### 1. Server — `server/unified-server.mjs`
Express + Yjs sync + SPA + `/api`. Owns: fleet registry in-memory state
(`_aliveAgents`, `_lastActivityAt`, `_daemonConnectedSince`), chat routing, the
auto-hibernate actor, RPC relay down to daemons by `machine_id`. Runs on Fly
(`tldraw-sync-skip`), tailnet-only (`*.cormorant-matrix.ts.net`); public fly.dev
is dead by design. [VERIFY: enumerate the WS message types + REST routes]

### 2. Fleet daemon — `bin/fleet-daemon.mjs`
Per-machine bridge. Connects out to the server over one WS. Watches each
project's source dir (recursive fs.watch + fs.watchFile poller backup) and every
Claude/codex/goose session file; extracts activity; pushes events up. Handles
tmux RPCs (interrupt, send-key, capture-pane, restart-mcp, kick, kill-session,
spawn). Supervises managed bots. **Must be a singleton per (server, watch root)**
— see `architecture-invariants-todo.md` #1. [VERIFY: the cursor/backfill model
in `readNewSessionLines`, the watchSet bootstrap]

### 3. Fleet store — `server/lib/fleet-store.mjs`
SQLite-backed registry: agents, lineages, chat history, events. Status model:
`dead=1` → dead; `dead=0` + in `_aliveAgents` → awake; `dead=0` + not awake →
hibernating (a process-less mark, wakeable). **Roster must be event-maintained,
not query-on-change** — see invariants #4. [VERIFY: the cache vs event-maintenance]

### 4. Build pipeline — `server/lib/build-runner.mjs`
latexmk → dvisvgm → synctex → proof-pairing → SVG pages. Demand-driven: SVG docs
build only when a viewer is connected. [VERIFY: trigger path, change detection]

### 5. Project store — `server/lib/project-store.mjs`
Per-project storage under `PROJECTS_DIR` (default `server/projects`, env-
overridable). **Counterintuitive thing to FIX:** runtime data lives inside the
source tree; should move out of the repo. See invariants + disk note.

### 6. Viewer SPA — `src/`
React + TLDraw. `SvgDocument.tsx` (page load/layout/reload), fleet shapes
(HUD/chat/agents/inbox, scoped by userId+deviceId — `fleet-utils.ts`
`isMyFleetShape`), `useYjsSync.ts`, proof reader. Custom shapes registered in TWO
places (client `src/shapes/` + server `sync-rooms.mjs`). [VERIFY: shape list]

### 7. MCP server / fleet tools — `mcp-server/`, fleet-tools
The tools agents call (chat, spawn, inbox, read_annotations, add_note, ...).
[VERIFY: tool inventory + where each is handled]

### 8. Spawn system — `bin/fleet-spawn.py` + daemon `rpcSpawn` + server relay
3 layers: server relay → daemon `rpcSpawn` → `tlda agent spawn` → fleet-spawn.py.
Per Skip's canonical design, spawn logic belongs in the daemon (node); server =
bookkeeping/naming. [VERIFY against the spawn-relocation plan]

### 9. Two comms channels
Yjs (convergent CRDT — anything that must be correct after reconnect) vs
fire-and-forget signals (transient, self-correcting). Documented in CLAUDE.md;
lift the principle here.

### 10. Voice — `bin/whisper-bridge.mjs`
mic → whisper-stream → bridge → ws:8179 → browser.

### 11. Invariants (link `architecture-invariants-todo.md`)
Singleton daemon, singleton bots, hibernate-fires-and-is-observable, event-
maintained roster.

---

## usage.md — skeleton (for agents using the app)

1. **Where things are.** Server on Fly (tailnet), https only (`getServerUrl`
   picks scheme — empty reply = wrong scheme, not an outage). Daemon per machine.
   No local server normally.
2. **Projects: real vs test.** What's a real paper vs a throwaway test doc, and
   where project data lives (after the move out of the repo). [the confusion that
   hung up the minimax agent]
3. **Spawning agents.** `mcp__tlda__spawn` (fresh vs respawn); **spawn carries no
   prompt — deliver the task via chat after** or the agent boots taskless and
   hibernates. Models via `spawn_models()`.
4. **Chat.** `to` is a filter expression (`|`/`&`/`!`). Talk to Skip via `chat`,
   not terminal.
5. **Reviewing a doc.** `monitor_add`, `read_annotations`, `add_note`,
   `scroll_to_line`, the proof reader.
6. **Gotchas index.** https scheme; tailnet-only; local-vs-Fly; projects folder;
   binary-grep trap on `unified-server.mjs`; demand-driven SVG builds.

---

## Status
Skeleton drafted by rescue-lead from session knowledge + CLAUDE.md. NOT yet
verified against code. Next: once disk is healthy and Skip okays the spend, fan
bounded chunks to cheap (goose/minimax) agents, each reading the real files; I
verify every section against code before it lands.
