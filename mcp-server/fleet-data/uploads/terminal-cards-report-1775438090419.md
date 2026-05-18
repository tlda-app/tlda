# Terminal Cards in Chat — Implementation Report

## Summary

When an agent's terminal needs attention (permission prompt, MCP disconnect, crash), a live xterm.js terminal card auto-pops into fleet chat. Skip can type into it directly — approve permissions, run `/mcp`, fix things — without switching to Terminal.app.

---

## User Story Flow

### Step 1: Normal chat — before

Normal fleet chat with messages from multiple agents. Nothing unusual.

![Normal chat stream with messages from skip, chip-fixes, panel-redesign, and voice-fixer](tc-01-before.png)

### Step 2: Terminal card appears

The `qa-tester` agent hits a permission prompt. A terminal attention card auto-inserts into the chat stream at 9:06 PM. The orange header shows ⚠, the agent name, the reason ("Permission prompt: Bash"), and a ✕ dismiss button. Below it is a live xterm.js terminal showing the agent's actual tmux session — you can see it's mid-work, with tool output and a `spawn` command visible.

![Terminal attention card appears in chat — live xterm.js showing qa-tester's tmux session with permission prompt](tc-02-card-appears.png)

### Step 3: Interactive — typing into the card

Clicking the terminal focuses it. The cursor is live — keyboard input goes straight to the agent's tmux session via WebSocket. You can type `y` to approve the permission, run `/mcp` to fix MCP, or do anything you'd do in Terminal.app.

![Terminal card is interactive — cursor active, ready for keyboard input](tc-03-interactive.png)

### Step 4: Dismissed — back to normal

After handling the issue, click ✕ to dismiss. The card is removed, WebSocket closed, xterm disposed. Chat returns to normal.

![Card dismissed — chat back to normal message stream](tc-04-dismissed.png)

---

## What was built

### tlda (worktree `terminal-cards`, 4 files)

**`src/fleet/fleet-data.mjs`** — `terminal_attention` event type
- Added to all 4 type filter lists (initial load, SSE reconnect, history fetch, thread fetch)
- Converter extracts `reason`, `agentId`, `agentLabel`, `snippet` from metadata

**`src/fleet/chat-render.mjs`** — Terminal card renderer
- Renders card with orange accent border, header (⚠ icon, agent name, reason, dismiss ✕), xterm mount div

**`src/shapes/FleetChatShape.tsx`** — xterm.js hydration
- `useEffect` on `linkedHtml` finds `.terminal-card-mount` divs after render
- Creates `Terminal` + `FitAddon` + WebSocket per card, connects to fleet terminal bridge
- Forwards keyboard input, stops TLDraw event propagation
- Cleanup on card removal and component unmount

**`src/shapes/fleet-chat.css`** — Terminal card styles
- Orange accent, dark background, xterm viewport scroll

### Fleet server (2 files)

**`server/terminal-state.mjs`** — `detectAttention(agentId)`
- **Permission prompts**: `(y)es | (n)o` pattern
- **MCP disconnect**: `MCP server.*disconnected` pattern
- **Agent crash**: `claude.*exited`, `session ended` patterns

**`server/server.mjs`** — Periodic attention scanner
- Runs every 5 seconds, checks all agents with tmux sessions
- Broadcasts `terminal_attention` events via `fleetStore.share()`
- 60-second cooldown per agent

---

## Test results

### Integration tests (9/9 pass)

| Test | Result |
|------|--------|
| Terminal attention card exists in DOM | ✓ |
| Terminal card mount point exists | ✓ |
| Card has correct agent ID | ✓ |
| xterm.js mounted successfully | ✓ |
| xterm screen element rendered | ✓ |
| WebSocket connected to fleet terminal bridge | ✓ |
| Received terminal output (19,120 chars) | ✓ |
| Keyboard input handler attached | ✓ |
| Dismiss button exists | ✓ |

### Detection pattern tests (6/6 pass)

| Pattern | Expected | Result |
|---------|----------|--------|
| `Allow Bash(...)? (y)es \| (n)o` | attention | ✓ |
| `Allow Edit(...)? (y)es \| (n)o \| (a)ll` | attention | ✓ |
| Normal thinking (✽ Thinking...) | no attention | ✓ |
| Idle prompt (❯) | no attention | ✓ |
| `MCP server "fleet" disconnected` | attention | ✓ |
| Normal tool call (⏺ Bash) | no attention | ✓ |

### Build

- TypeScript: clean (0 errors)
- Vite build: success

---

## To go live

1. **Fleet server restart** — picks up `detectAttention` + scanner
2. **Merge worktree** — merge main → worktree, test, get approval, fast-forward main
