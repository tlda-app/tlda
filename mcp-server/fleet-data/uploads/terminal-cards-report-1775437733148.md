# Terminal Cards in Chat — Implementation Report

## Summary

When an agent's terminal needs attention (permission prompt, MCP disconnect, crash), a live xterm.js terminal card auto-pops into fleet chat. Skip can type into it directly — approve permissions, run `/mcp`, fix things — without switching to Terminal.app.

## What was built

### tlda (worktree `terminal-cards`, 4 files)

**`src/fleet/fleet-data.mjs`** — `terminal_attention` event type
- Added to all 4 type filter lists (initial load, SSE reconnect, history fetch, thread fetch)
- Converter extracts `reason`, `agentId`, `agentLabel`, `snippet` from metadata

**`src/fleet/chat-render.mjs`** — Terminal card renderer
- Renders as a card with orange accent border
- Header: ⚠ icon, agent name (colored), attention reason, ✕ dismiss button
- Body: `<div class="terminal-card-mount" data-agent-id="...">` placeholder for xterm.js

**`src/shapes/FleetChatShape.tsx`** — xterm.js hydration
- `useEffect` on `linkedHtml` finds `.terminal-card-mount` divs after render
- Creates `Terminal` + `FitAddon` + WebSocket per card
- Connects to `ws://localhost:5199/ws/terminal?agent=ID`
- Forwards keyboard input to tmux via WebSocket
- Event propagation stopped (keydown, keyup, pointerdown) so TLDraw doesn't intercept
- Cleanup on card removal and component unmount
- Dismiss button click handler removes card and disposes terminal

**`src/shapes/fleet-chat.css`** — Terminal card styles
- Orange-accented border (`rgba(255, 160, 0, 0.3)`)
- Dark background matching existing terminal shape
- Header with subtle orange tint background
- xterm viewport with auto-scroll

### Fleet server (live repo, 2 files)

**`server/terminal-state.mjs`** — `detectAttention(agentId)`
- Checks last 20 lines of terminal content
- **Permission prompts**: `(y)es | (n)o` pattern (Claude Code approval dialogs)
- **MCP disconnect**: `MCP server.*disconnected` pattern
- **Agent crash**: `claude.*exited`, `session ended` patterns
- Returns `{ reason, snippet }` or `null`

**`server/server.mjs`** — Periodic attention scanner
- Runs every 5 seconds
- Checks all live agents with tmux sessions
- Broadcasts `terminal_attention` events via `fleetStore.share()`
- 60-second cooldown per agent (no spam)
- Logs to stderr: `[fleet-server] terminal attention: agent-name — reason`

## Test results

### Integration tests (9/9 pass)

| # | Test | Result |
|---|------|--------|
| 1 | Terminal attention card exists in DOM | ✓ |
| 2 | Terminal card mount point exists | ✓ |
| 3 | Card has correct agent ID | ✓ |
| 4 | xterm.js mounted successfully | ✓ |
| 5 | xterm screen element rendered | ✓ |
| 6 | WebSocket connected to fleet terminal bridge | ✓ |
| 7 | Received terminal output (19,120 chars) | ✓ |
| 8 | Keyboard input handler attached | ✓ |
| 9 | Dismiss button exists | ✓ |

### Detection pattern tests (6/6 pass)

| Pattern | Expected | Result |
|---------|----------|--------|
| `Allow Bash(...)? (y)es \| (n)o` | attention | ✓ |
| `Allow Edit(...)? (y)es \| (n)o \| yes to (a)ll` | attention | ✓ |
| Normal thinking (✽ Thinking...) | no attention | ✓ |
| Idle prompt (❯) | no attention | ✓ |
| `MCP server "fleet" disconnected` | attention | ✓ |
| Normal tool call (⏺ Bash) | no attention | ✓ |

### Build

- TypeScript: clean (0 errors)
- Vite build: success (44s)

## Screenshot

See `/tmp/tc-standalone.png` — shows the card rendering with a live terminal from the `chip-fixes` agent. Orange header with agent name and reason, dark terminal body showing actual tmux output with prompt and status bar, all test checkmarks green below.

## To go live

1. **Fleet server restart** — picks up `detectAttention` + scanner in `server.mjs` and `terminal-state.mjs`
2. **Merge worktree** — merge main → worktree, test, get approval, fast-forward main
