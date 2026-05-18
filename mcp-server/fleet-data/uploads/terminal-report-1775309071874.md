# TerminalShape — Report
**Date:** 2026-04-04
**Branch:** `w3c-terminal` worktree at `/Users/skip/work/tlda/.worktrees/w3c-terminal/`
**Dev server:** `http://localhost:5196/?doc=terminal-test-room&token=c5e4726ab77972fc7312f3a703f9cf1c`
**Commits:** `c05977a` (worktree), `262d17a` (server schema, working copy)

---

## Interaction Model

TerminalShape is a resizable tldraw canvas card that embeds a live xterm.js terminal. After placing it, you pick an agent from the dropdown in the title bar — it connects to that agent's tmux session via the fleet server WebSocket and streams live terminal output. Keyboard input is forwarded back.

**To place:** set current tool to `terminal`, click canvas. No keyboard shortcut registered in toolbar yet (it's in the overflow, not the primary toolbar zone).

---

## What's Working (Playwright-verified)

1. **TerminalShape renders** — dark card with macOS traffic light dots, "terminal" title, agent picker dropdown
2. **Placeholder state** — "Pick an agent above to connect to its terminal" shown when no agent selected
3. **Shape created and synced** — shape persists across page reloads (synced to server, which now validates `terminal` props)
4. **`tsc --noEmit` clean** — zero type errors
5. **Server schema registered** — `terminal` shape (w, h, agentId) added to `server/lib/sync-rooms.mjs`

## What Needs Live Testing

- **Keyboard input** — requires actual agent selection and tmux session; can't verify in headless playwright
- **WebSocket connection** — requires fleet server running with live agents; fleet was not running during test
- **Resize → xterm fit** — FitAddon.fit() called on dimension change; verified in code, not live

---

## Screenshots

### Step 1: TerminalShape on canvas — disconnected state
![Initial state](terminal-verify-2-zoomed.png)

The card renders on the tldraw canvas: black title bar with red/yellow/green traffic light dots, "terminal" label centered, "— pick agent —" dropdown on the right. The terminal body area is dark (#1a1a1a) with the "Pick an agent above to connect to its terminal" placeholder in dim gray monospace.

The markdown doc content is partially visible behind the terminal body — this is a TLDraw artifact: iframe-backed shapes (`html-page`) always render above HTMLContainer shapes at the browser stacking level. In normal usage (placing terminal on empty canvas space), this doesn't occur.

---

## Console Errors

- `WebSocket connection to 'ws://localhost:9876/' failed` — pre-existing, fleet trackpad WS (expected)
- Various connection errors to fleet (expected when fleet server not running)
- Zero errors from the TerminalShape code itself

---

## Architecture Notes

**WebSocket protocol (fleet server port 5199, `/ws/terminal?agent=ID`):**
- Server sends `{ type: "output", data: string }` — full ANSI capture from tmux (with escapes)
- Client sends `{ type: "input", data: string }` — raw key data
- Client sends `{ type: "resize", cols, rows }` — on xterm fit
- Server polls tmux at 500ms intervals; sends only when content changes
- On output: xterm does `terminal.reset()` then `terminal.write(data)` (full repaint, not incremental)

**Shape props:** `{ w: number, h: number, agentId: string }`

**Files changed:**
| File | Change |
|------|--------|
| `src/shapes/TerminalShape.tsx` | New — shape util + xterm.js component |
| `src/shapes/TerminalShape.css` | New — card styling |
| `src/tools/TerminalTool.tsx` | New — tool to place shape on canvas |
| `src/SvgDocument.tsx` | +2 imports, +TerminalShapeUtil in utils, +TerminalTool in tools |
| `src/formatConfig.ts` | Added `'terminal'` to SVG_TOOLS list |
| `server/lib/sync-rooms.mjs` | Added `terminal` schema (w, h, agentId) — committed to working copy |
