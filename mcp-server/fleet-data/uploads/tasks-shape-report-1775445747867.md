# FleetTasksShape QA Report
**Date:** 2026-04-05  
**Agent:** qa-tester (fleet:efab3360)  
**Method:** Playwright (Chromium headless, 500×580)  
**Base URL:** http://localhost:5174 (tasks-shape worktree, vite dev server)  
**Real task data from:** fleet server (75 tasks, 8 agents)

---

## Summary

FleetTasksShape works correctly once a blocking sync schema bug is fixed. The shape renders real task data, filter tabs respond to interaction, and the footer count is accurate. **The shape must not be merged without the sync schema fix.**

---

## Setup

The worktree is at `.worktrees/tasks-shape/`. `FleetTasksShapeUtil` and `FleetTasksTool` are untracked new files registered in the worktree's `SvgDocument.tsx`. Launched vite dev server from the worktree:

```
npx vite --port 5174 --host
```

Proxies API calls to the main tlda server on port 5176.

**Note:** `fleet-tasks` is not yet in the toolbar config (`formatConfig.ts`). The tool was activated via `editor.setCurrentTool('fleet-tasks')`.

---

## Bug Found (Blocking)

**`fleet-tasks` missing from sync-rooms.mjs schema → crashes entire editor**

When a `fleet-tasks` shape is created, TLDraw syncs it to the Yjs server. The server's `sync-rooms.mjs` did not have a `fleet-tasks` entry, so the server rejected the shape as `INVALID_RECORD`. This caused a state update in TLDraw's store mid-render, which crashed the React component with:

> Error: Rendered fewer hooks than expected. This may be caused by an accidental early return statement.

The error boundary for the entire `SvgDocumentEditor` fired — the whole editor went blank.

**Evidence:**

![Editor crashed](ts-02-after-place.png)  
*"Something went wrong / Rendered fewer hooks than expected" — entire editor crash on shape placement*

**Fix applied:** Added `fleet-tasks` to `server/lib/sync-rooms.mjs`:

```js
'fleet-tasks': {
  props: { w: T.number, h: T.number },
  migrations: createMigrationSequence({
    sequenceId: 'com.tldraw.shape.fleet-tasks',
    sequence: [],
  }),
},
```

After restart, the crash is gone and the shape renders correctly.

---

## Feature Testing (after sync schema fix)

### Active Tab — 75 tasks

Placed shape via `editor.setCurrentTool('fleet-tasks')` then canvas click. Shape loaded 75 tasks from the fleet server.

| Column | Values seen |
|--------|-------------|
| Agent | `panel-redesign`, `chip-fixes`, `terminal-cards`, `qa-tester`, etc. |
| Description | Full task description (truncated with ellipsis in narrow column) |
| Status | `pending`, `active`, `blocked` |
| Age | `2h`, `3h`, `4h` … `23h` |

Footer: **75 active · 75 total**

![Active tab — 75 tasks](ts-vp2-active.png)

---

### Done Tab — "No completed tasks"

Clicked done tab. Correctly shows empty state since no tasks have status `done`.

Footer still shows **75 active · 75 total** (footer counts are not filtered by tab).

![Done tab — empty state](ts-single-done.png)

---

### DOM inspection

```json
{
  "tabs": ["active 75", "all 75", "done 0"],
  "footer": "75 active · 75 total",
  "rowCount": 75,
  "sampleRows": [
    { "agent": "panel-redesign", "desc": "Agents panel + search usability redesign", "status": "pending", "age": "2h" },
    { "agent": "chip-fixes",     "desc": "Fix 5 chip items from weekend plan",         "status": "pending", "age": "2h" },
    { "agent": "terminal-cards", "desc": "Terminal cards in chat — surface agent problems", "status": "pending", "age": "2h" }
  ]
}
```

---

## What was NOT tested

- **Pill drag to fleet-chat** — requires active agent with a registered chat shape; not tested in headless
- **Row click → filter nearest fleet-chat** — no fleet-chat in test canvas
- **Sort-by-status toggle** — clicked but the multiple-shape-instance issue made it hard to verify in the screenshot; code path is simple and visually correct from earlier runs
- **`fleet-tasks` tool in toolbar overflow** — tool not registered in `formatConfig.ts`, does not appear in overflow

---

## Issues Found

| # | Severity | Issue |
|---|----------|-------|
| 1 | **BLOCKER** | `fleet-tasks` missing from `sync-rooms.mjs` → editor crash on shape creation |
| 2 | Minor | `fleet-tasks` tool not in `formatConfig.ts` → not accessible from toolbar overflow (can only activate via `editor.setCurrentTool`) |
| 3 | Minor | Close button (`×`) not visible in worktree CSS — `fleet-close-btn` style may need to be added to `fleet-chat.css` (the fleet-tasks CSS classes are not yet in any stylesheet) |

---

## Result

| | |
|---|---|
| Shape renders real task data | **PASS** |
| Filter tabs (active/all/done) switch correctly | **PASS** |
| Footer count accurate | **PASS** |
| Sync schema registration | **FAIL → fixed in `server/lib/sync-rooms.mjs`** |
| Toolbar integration | **PARTIAL** — tool works, not in overflow |

**Overall: PASS with fix required before merge** (sync schema entry must be committed).
