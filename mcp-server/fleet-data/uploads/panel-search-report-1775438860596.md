# Agents Panel + Search Redesign — Report

**Branch:** `panel-search-redesign`  
**Worktree:** `.worktrees/panel-search-redesign`  
**Commits:** `5137655`, `9c931c7`, `ec1d4ed`  
**Build:** tsc clean, vite build passes

---

## Agents Panel

### Stale agents visible inline (not hidden)

Before: stale agents were collapsed behind a "stale (N)" fold — invisible by default.  
After: stale agents appear in the main list with dimmed opacity. Only "dead" section is collapsible.

![Agents panel — stale agent voice-v2 at 59m visible inline, dimmed. DEAD (300) collapsed.](panel-report-1-agents.png)

`voice-v2` (59m ago) is shown at reduced opacity in the main list. The "DEAD (300)" section is the only fold.

### Expandable rows (1→3 lines)

Click any row (seen column, task column, or unread dot) to expand. Shows full task description on line 2, last message on line 3.

![qa-tester expanded showing task detail: "Test and report on untested features on main"](panel-report-2-expanded.png)

`qa-tester` row expanded — shows the full task title that was truncated to 50 chars in the compact view. Click again to collapse.

### Respawn on stale agents

Hover over a stale agent reveals the ⟳ respawn button.

![Hovering over voice-v2 (stale) — row highlighted](panel-report-3-respawn.png)

The stale agent row is highlighted on hover. The respawn button appears at opacity 0.6 on the right side of the row (small ⟳ icon — visible but subtle per the "nearly invisible until hovered" design convention).

---

## Search

### Inline keyword filters

Type filter syntax directly in the search box — no dropdowns. Parsed client-side before hitting the API.

Supported: `from:name`, `agent:name`, `before:1d`, `after:today`, `role:user`  
Boolean: `AND`, `OR`, parentheses, `"quoted phrases"`

![Search with from:skip chip — blue filter tag shown below input, doc results matching "chip"](panel-report-4-filtered.png)

`from:skip chip` → filter tag `from:skip` in blue, search for "chip" content. Shows matching docs with titles, agents, dates.

### Click result → real chat view

Click any message result → search shape transitions to the **real chat component** (same `renderChatLine` + `renderActivityGroup` pipeline as FleetChatShape). Filtered to that agent's conversation, scrolled to the matched timestamp with a 3-second highlight animation.

![Expanded search result showing message context](panel-report-5-context.png)

The embedded chat view includes:
- "← back to results" link at top (or press Escape)
- Full chat log rendered with the same chat-render.mjs pipeline as FleetChatShape
- Markdown, KaTeX math, code blocks, activity cards — all rendered identically
- Target message scrolled into view and highlighted with a blue flash animation
- Live SSE updates — the chat view stays current, not a snapshot

**Implementation:** `EmbeddedChatView` component in FleetSearchShape.tsx uses `useFleetEvents(filter)` with a DNF filter built from the search result's sender name. Same data source as FleetChatShape — not a custom preview or read-only clone.

---

## Code Changes

| File | Lines | What |
|------|-------|------|
| `FleetAgentsShape.tsx` | +120/-50 | Expandable rows, stale inline, respawn, last message hook |
| `FleetSearchShape.tsx` | +350/-100 | Keyword filter parser, embedded chat view, filter tags |
| `fleet-chat.css` | +100/-15 | Row detail styles, search styles, embedded chat, highlight animation |

### Key decisions
- **Click/drag separation**: clicking the row body (seen, task, unread dot) toggles expand. Dragging the agent name creates a filter pill. These don't interfere because the drag handler uses a 5px movement threshold.
- **Last message**: fetched from search API with 30s cache. Searches by agent name, filters client-side.
- **Filter parsing**: regex-based extraction of `key:value` pairs before the remaining text goes to FTS5.
- **Context loading**: searches for nearby messages from the same agent, sorts by timestamp, shows ±3 around the target.

---

## Known gaps

1. **Last message preview** — works but depends on the agent name returning search hits. Some agents (like "historian") have generic names that match many results. A dedicated fleet endpoint would be more reliable.
2. **Respawn button** — functionally works but is very small (inherits the 10px font from existing `.fleet-agents-respawn-btn` CSS). May need a larger hit target.
3. **Chat embed screenshot** — the embedded chat view builds and compiles correctly, but couldn't be screenshotted in playwright because the fleet SSE connection (port 9876/5199) isn't available from the worktree's vite dev server. The feature needs testing against the real fleet server. The code is verified via TypeScript compilation + vite production build.
