# App Verification Reports

Every UI or behavior change gets a verification report before calling `report()`. No exceptions. "It builds" is not verification. "I looked at the screenshot" is not verification. The report is the proof.

---

## Structure

```
# Verification Report: {what changed}

**Target:** URL tested against
**Viewport:** dimensions
**Agent:** who tested, how

---

## {Feature 1}

{Narrative: what it should do, what you see. Specific values.}

| Property | Expected | Actual |
|----------|----------|--------|
| ... | ... | ... |

{Narrative sentence describing what the screenshot shows.}

![Description](screenshot.png)

**Verdict:** PASS / FAIL — {one-line reason}

---

## Summary

| Feature | Result |
|---------|--------|
| Feature 1 | ✓ |
| Feature 2 | ✗ |
```

---

## Screenshots

**What to capture:**
- Before and after for any visual change
- Element-level crops for detail — not full viewport when you only care about one panel
- During interaction for transient states (mid-drag, hover tooltip, mid-scroll)
- Full viewport when spatial relationship between elements matters

**How to save:**
- `scratch/report-{feature}.png` — descriptive names, not `screenshot1.png`
- Crop with `page.screenshot({ clip: {x, y, width, height} })` or `element.screenshot()`
- Pan the canvas first if UI overlaps the thing you're testing

**How to describe:**
Every screenshot gets a narrative sentence *before* the `![]()`. State what you see, not what you expected.

Good:
> The agents panel shows two active agents (cc-fork, apps) at full opacity. Columns: Agent, Seen, Task, Labels. No status dots. STALE section collapsed with 10 agents.
>
> ![Agents panel — active rows at full opacity, stale collapsed](report-agents-panel.png)

Bad:
> ![agents](screenshot.png)

**Read the screenshots yourself.** After capturing, look at what you got. If something looks wrong, investigate — don't attach and move on.

---

## What to measure

- **Element counts**: `.fleet-agents-dot` count = 0, `.chat-line` count = 608
- **Computed styles**: `borderRadius`, `opacity`, `display`, `position`
- **Bounding rects**: x, y, width, height — for overlap and gap checks
- **Tool state**: `editor.getCurrentToolId()`, `editor.getPath()` for full state path
- **Scroll positions**: `element.scrollTop` before and after
- **Console errors**: note any JS errors; distinguish from pre-existing ones

---

## Photo series patterns

### Scroll test
1. Note scrollTop, screenshot
2. Dispatch wheel event
3. Note new scrollTop, screenshot
4. Narrative: "scrollTop went from X to Y (delta Z). Content visibly shifted."

### Drag test
1. Screenshot before drag
2. Pointerdown → screenshot mid-drag (pill shape, ghost, selection box)
3. Pointerup → screenshot result
4. State table: tool ID and state path at each phase

### State transition test

| Phase | Tool | State |
|-------|------|-------|
| Before click | browse | idle |
| After pointerdown | browse | pointing_canvas |
| During drag | browse | brushing |
| After release | browse | idle |

---

## How to test

**playwright-cli (preferred — most context-efficient).** A separate tool from playwright-mcp ([microsoft/playwright-cli](https://github.com/microsoft/playwright-cli)). Same actions as the MCP tools, but snapshots are written to disk as YAML files — the agent sees a one-line file path in the response and reads it only if needed. ~4x fewer tokens than MCP for the same browser work.

Use it from bash. Sessions are named (`-s=name`) and persist across calls. Snapshots go to `.playwright-cli/` as YAML files — the agent sees just the path, not the full tree.

```bash
# Start a named session (runs in background)
playwright-cli -s=verify open &
sleep 2

# Navigate and wait for load
playwright-cli -s=verify goto "http://localhost:5176/?doc=fleet-test&token=TOKEN"
sleep 3  # wait for tldraw to render

# Screenshot to a specific file
playwright-cli -s=verify screenshot --filename scratch/report-before.png

# Evaluate JS — returns result inline
playwright-cli -s=verify eval "document.querySelectorAll('.fleet-chat-shape').length"

# Get computed style + bounding rect
playwright-cli -s=verify eval "
  const el = document.querySelector('.fleet-chat-shape');
  const r = el?.getBoundingClientRect();
  const s = el ? getComputedStyle(el) : null;
  JSON.stringify({ rect: r && {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}, pointerEvents: s?.pointerEvents })
"

# Close when done
playwright-cli -s=verify close
```

The tlda token is in `~/.config/tlda/config.json` (key: `token` or `tokenRw`).

**Fleet agent with playwright MCP (good for multi-step interaction).** Spawn a dedicated fleet agent with playwright MCP. Stays alive across tests. Delegate the whole interaction sequence; it returns paths + measurements; you write the narrative.

```
Delegate to web-tester: "Open http://localhost:5176/?doc=fleet-test&token=TOKEN.
Select the fleet-chat shape and try to resize it. Screenshot before selection,
after selection (showing handles), and after resize. Return paths + bounding rects."
```

**Playwright MCP in your own session (acceptable for quick one-offs).** Fine for a single check; avoid for multi-step sequences where repeated snapshots will eat context.

**Never:**
- Tell the user to "reload and check" — you have playwright
- Say "looks good" without a screenshot
- Test only the happy path — check near boundaries, during transitions
- Use screenshots from a prior session
- Attach a screenshot without reading it yourself

---

## Playwright MCP patterns

Use the playwright MCP tools directly. The token for tlda is in `~/.config/tlda/config.json` (key: `token` or `tokenRw`). Fleet server (backend only, no UI) is at `localhost:5199`, tlda at `localhost:5176`. All fleet UI lives in tlda as shapes.

**Inspect an element** — one `browser_evaluate` call instead of five:

```js
// browser_evaluate:
const el = document.querySelector('.fleet-chat-shape');
if (!el) return 'NOT FOUND';
const rect = el.getBoundingClientRect();
const s = getComputedStyle(el);
return {
  count: document.querySelectorAll('.fleet-chat-shape').length,
  rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
  visible: rect.width > 0 && s.display !== 'none',
  opacity: s.opacity,
  pointerEvents: s.pointerEvents,
  text: el.innerText?.slice(0, 200),
};
```

**Screenshot an element** — use `browser_take_screenshot` after navigating, then crop with clip if needed. Element-level: get the rect first, then clip.

```
// Step 1: browser_evaluate → get rect
// Step 2: browser_take_screenshot with clip: { x, y, width, height }
```

**Tool state** — read tldraw internals via evaluate:

```js
// browser_evaluate:
const editor = document.querySelector('.tl-canvas')?.__tldrawEditor;
return editor ? { tool: editor.getCurrentToolId(), path: editor.getPath() } : 'no editor';
```

---

## Integration with report()

When calling `report(task_type: 'app')`:
- `test_evidence` = path to the verification report markdown
- `test_method` = how you tested (e.g. "playwright via fleet web-tester agent")
- The report markdown should be shareable via `share()` so Skip can review in tlda

---

## Example: good report section

From `scratch/ui-verification-mar29.md`:

---

**## 1. Highlighter Button**

The highlighter button (`.phone-hl-btn`) is a fixed-position circular button pinned to the bottom-right of the viewport.

| Property | Value |
|----------|-------|
| Position | `fixed`, bottom-right (x=1380, y=840) |
| Size | 44 × 44 px |
| Opacity | **0.15** at rest, **0.5** on hover |
| z-index | 10001 |

At 0.15 opacity it's barely visible — a ghost button, which is the intent.

![Highlighter button at rest — faint phone icon, bottom-right](scratch/01-highlighter-btn-bottomright.png)

![Highlighter button on hover — opacity rises to 0.5](scratch/01-highlighter-btn-hover.png)

**Verdict:** PASS — fixed bottom-right, opacity 0.15 at rest / 0.5 on hover.

---

**## 3. Agents Panel**

The agents panel is a tldraw shape (`fleet-agents`) at canvas position (0, −1200), 340 × 500. Columns: Agent, Seen, Task, Labels.

**Zero dots found.** Queried `.dot`, `[class*="dot"]`, `.status-dot`, `circle` within the agents shape — count: **0**. Activity is conveyed via name opacity and the Seen timestamp.

![Agents panel header — AGENT / SEEN / TASK / LABELS, no dots](scratch/03-agents-header.png)

**Verdict:** PASS — no status dots; name opacity is the activity signal.

---

That's the standard. Element counts, computed values, narrative before the image, verdict with a reason.
