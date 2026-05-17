# Terminal Cards Visual Verification Report

**Commit:** `71c2292` feat: terminal card dismiss = freeze as static snapshot  
**Worktree:** `.claude/worktrees/terminal-cards`  
**Test method:** Headless Playwright, worktree dist served via route interception, live tlda server at :5176, fleet WS at :5199  
**Test agent:** `inbox-reporter` (fleet:f724c502) — live tmux session  
**Date:** 2026-04-07

---

## 1. Canvas Loads — TerminalShape Registered

The worktree build loads cleanly. `TerminalShapeUtil` is registered in the TLDraw editor before any shape creation.

**Verified:** `editor.getShapeUtil('terminal')` returns `TerminalShapeUtil` ✓

![Empty canvas with tlda viewer loaded](../server/projects/scratch-terminal-cards-report/output/01-canvas-empty.png)

---

## 2. Disconnected State (No Agent)

When no agent is selected (`agentId: ''`):

- Header shows macOS-style **red/yellow/green traffic light dots**
- Title reads **"terminal"**
- **Agent picker dropdown** appears ("— pick agent —")
- **× freeze button is NOT shown** — correct, nothing to freeze
- Body shows hint: *"Pick an agent above to connect to its terminal"*

![Terminal shape with no agent selected — picker visible, no × button](../server/projects/scratch-terminal-cards-report/output/02-terminal-no-agent.png)

---

## 3. Live Terminal — Connected to Fleet Agent

After selecting `inbox-reporter` (fleet:f724c502):

- xterm.js connects via `ws://localhost:5199/ws/terminal?agent=fleet:f724c502`
- Live terminal output is rendered — real tmux content from the agent's active session
- Header title becomes **"fleet:f724c5"** (agent name/truncated ID)
- **× dismiss button appears** in the header (only when `agentId` is set)
- Tooltip on button: `"Dismiss (freeze as snapshot)"`

The terminal content visible is inbox-reporter's actual work — vite preview output, playwright commands, error traces.

![Terminal with live xterm.js output from inbox-reporter agent](../server/projects/scratch-terminal-cards-report/output/03-terminal-connected.png)

---

## 4. Freeze Button — Hover State

The × button (`<button class="terminal-shape-freeze-btn">`) is visible in the right side of the header. On hover, color transitions from `#666` to `#ccc` over 0.15s.

`stopEventPropagation` prevents TLDraw from intercepting the click.

![× dismiss button visible and hovered](../server/projects/scratch-terminal-cards-report/output/04-freeze-btn-hover.png)

---

## 5. Frozen State — After Clicking ×

`handleFreeze()` executes:
1. Reads all xterm buffer lines via `buffer.getLine(i).translateToString(true)`
2. Trims trailing empty lines
3. Calls `wsRef.current.close()` — WebSocket disconnected
4. Calls `editor.updateShape({ meta: { frozen: true, frozenText, frozenAgent, frozenAt } })`

Shape re-renders as static snapshot:

- **`.terminal-shape-frozen` class** → `opacity: 0.7` on the whole card
- **All three dots grey** — `rgb(102, 102, 102)` instead of red/yellow/green
- **Header background** `#0e0e0e` (darker than live state)
- **Time label** in header: `"2:15 AM"` (from `frozenAt`)
- **Agent label** preserved: `"fleet:f724c5"`
- **`<pre class="terminal-shape-frozen-output">`** with captured terminal text
- **Text is selectable** — `user-select: text` confirmed

![Frozen terminal card — static snapshot with greyed dots and time label](../server/projects/scratch-terminal-cards-report/output/05-terminal-frozen.png)

---

## 6. Frozen State — Zoomed Detail

Close-up shows:
- Greyed traffic-light dots (left of header)
- Agent label + timestamp (right of header)
- Full scrollable `<pre>` with real terminal history
- No xterm canvas — pure static HTML

![Frozen terminal card zoomed in — shows grey dots, time, and terminal text](../server/projects/scratch-terminal-cards-report/output/06-frozen-zoomed.png)

---

## 7. Side-by-Side: Frozen vs Disconnected

**Left:** Frozen card — grey dots, static pre block, 70% opacity, timestamp  
**Right:** Fresh disconnected card — colored dots, "terminal" title, picker, dark body

The visual distinction between frozen and unconnected is clear and unambiguous.

![Frozen terminal (left) vs fresh disconnected terminal (right)](../server/projects/scratch-terminal-cards-report/output/07-side-by-side.png)

---

## Test Results

| Feature | Result |
|---------|--------|
| TerminalShape registered in editor | **PASS** |
| No-agent: agent picker visible | **PASS** |
| No-agent: × button hidden (correct) | **PASS** |
| Connected: live xterm output rendered | **PASS** |
| Connected: × button appears | **PASS** |
| × button title: "Dismiss (freeze as snapshot)" | **PASS** |
| Freeze: xterm buffer captured as text | **PASS** |
| Freeze: WebSocket closed | **PASS** |
| Freeze: `.terminal-shape-frozen` class applied | **PASS** |
| Freeze: card opacity 0.7 | **PASS** |
| Freeze: all three dots greyed | **PASS** |
| Freeze: time label shown | **PASS** |
| Freeze: agent label preserved | **PASS** |
| Freeze: `<pre>` with terminal content | **PASS** |
| Freeze: text selectable (`user-select: text`) | **PASS** |
| No app-related console errors | **PASS** |

**16/16 pass. No failures.**

---

## Notes

- **Console noise (not failures):** 404s for `/api/playback/stream` and a CORS block for `localhost:5199` in Chromium's loopback policy — both pre-existing, unrelated to terminal cards.
- **Frozen state in `meta` not `props`:** Intentional — avoids TLDraw schema migration. State persists in Yjs as a record.
- **Freeze button conditional:** Only renders when `agentId` is set — correct guard verified in test.
- **xterm WS not intercepted:** Playwright route interception only handles HTTP. WS connects directly to `:5199` and works correctly.
