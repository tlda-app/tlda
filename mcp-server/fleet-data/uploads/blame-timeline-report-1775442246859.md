# Blame Timeline Rework — Report

**Worktree:** `.claude/worktrees/blame-timeline`
**Branch:** `worktree-blame-timeline`
**Commits:** `019f96a` (original), `5db8496` (rework), `8802e2f` (sync fix + path matching)
**Build:** tsc clean, vite build passes

---

## Screenshots

### Blame timeline shape — survival-draft (85 edits, 35 pages)

![Blame timeline showing edit history with page-based Y-axis, color-coded by change magnitude](blame-timeline-1-overview.png)

Y-axis shows page numbers (p1–p35). X-axis shows time (4/2–4/5). Teal = 1-5 line edits, amber = 6-20, red/salmon = 20+ lines. The tall red bars on pages 1-9 and 25-35 are large initial commits. Smaller teal edits are scattered across pages 11-15 (experiments section).

### Shape with close/layout buttons

![Blame timeline with tldraw shape controls visible](blame-timeline-2-hover.png)

Close (×) and layout (⊞) buttons visible in top-right. The shape is resizable and movable like any tldraw shape.

---

## What Changed

### 1. Y-axis → compiled document position

**Before:** Y-axis = source file line numbers per file.

**After:** Y-axis = position in compiled document. Server enriches blame hunks with `page` + `renderedY` from lookup.json. Page boundaries shown as horizontal grid lines.

**Path matching fix:** Shadow repo paths like `sections_arxiv_icml/experiments.tex` match lookup keys using basename fallback (`experiments.tex`).

### 2. Panel → tldraw shape

`BlameTimelineShapeUtil` — proper tldraw shape, registered in `SvgDocument.tsx` and `sync-rooms.mjs`.

### 3. Sync schema registration

The `blame-timeline` type is registered in `server/lib/sync-rooms.mjs` `customShapeSchemas`. Without this, creating the shape crashed the app with `INVALID_RECORD` from the TLDraw sync server.

---

## Code Changes

| File | What |
|------|------|
| `src/shapes/BlameTimelineShape.tsx` | New tldraw shape (310 lines) |
| `src/SvgDocument.tsx` | Register shape in utils array |
| `src/historyStore.ts` | BlameHunk type extended with page/renderedY |
| `server/routes/history.mjs` | Enrich hunks with lookup.json positions + basename fallback |
| `server/lib/sync-rooms.mjs` | Register blame-timeline in sync schema |

---

## Verification

- **TypeScript:** clean
- **Vite build:** passes
- **Playwright:** screenshots taken from main server with patched dist + server routes, running survival-draft with 85 real edits
- **No React errors:** sync schema registration fixed the INVALID_RECORD crash
