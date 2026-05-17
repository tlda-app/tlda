# Blame Timeline Rework — Report

**Worktree:** `.claude/worktrees/blame-timeline`
**Branch:** `worktree-blame-timeline`
**Commits:** `019f96a` (original), `5db8496` (rework)
**Build:** tsc clean, vite build passes

---

## What Changed

### 1. Y-axis → compiled document position

**Before:** Y-axis = source file line numbers. Each file gets its own color. The user sees "line 147 of appendix.tex" which is meaningless without having the file open.

**After:** Y-axis = position in the compiled document. Each hunk is mapped through `lookup.json` (synctex data) to its rendered page + Y position. Y-axis labels show page numbers (`p1`, `p2`, ...) with horizontal grid lines at page boundaries.

**Server change** (`server/routes/history.mjs`): The `/shadow/blame` endpoint now loads `lookup.json` after computing hunks, and enriches each hunk with `page` and `renderedY` fields. For multi-file projects, lookup keys use `"filename.tex:N"` format for input files vs plain `"N"` for the main file. Falls back to nearest-line search (±20 lines) when no exact match.

**Type change** (`historyStore.ts`): `BlameHunk` interface extended with optional `page` and `renderedY` fields.

### 2. Panel → tldraw shape

**Before:** `BlameTimeline` was a React component rendered inside `HistoryTab` as a fixed-height panel (280px). Not movable, not resizable.

**After:** `BlameTimelineShapeUtil` — a proper tldraw shape (`src/shapes/BlameTimelineShape.tsx`):
- Registered in `SvgDocument.tsx` alongside FleetChatShape, etc.
- Resizable via tldraw's native resize handles
- Movable like any shape on the canvas
- Close button (×) and select button (⊞)
- Gets `docName` from `DocContext` (same pattern as other doc-aware shapes)

### UI details

- **Color = change magnitude** instead of per-file:
  - Teal (#6aafb0) = 1-5 lines changed
  - Amber (#c8a86a) = 6-20 lines
  - Red (#c87a6a) = 20+ lines
- **Legend** below header showing the magnitude scale
- **Hover tooltip**: page number, file path, line range, timestamp, commit hash
- **Click a hunk** → navigates the main editor to that page position (`editor.centerOnPoint`)
- **Header** shows "Edit History" with count of positioned edits and total pages

---

## Code Structure

```
src/shapes/BlameTimelineShape.tsx  — new tldraw shape (310 lines)
  ├── BlameTimelineShapeUtil       — BaseBoxShapeUtil, type='blame-timeline'
  ├── BlameTimelineComponent       — React component
  │   ├── Canvas rendering         — 2D canvas with page-based Y axis
  │   ├── Mouse hover              — finds nearest hunk, shows tooltip
  │   └── Click handler            — navigates main editor to page
  └── Uses: fetchBlameData, DocContext, PDF_HEIGHT

server/routes/history.mjs          — server endpoint enrichment (+40 lines)
  └── /shadow/blame now loads lookup.json and adds page/renderedY to hunks

src/historyStore.ts                — BlameHunk type extended with page/renderedY
src/SvgDocument.tsx                — shape registered in utils array
```

---

## What wasn't changed

- Old panel `BlameTimeline.tsx` still exists in `src/panels/` — can be removed after shape is verified
- Server `history.mjs` backward compatible — hunks without lookup data just don't get page/renderedY fields
- The shadow repo blame API format unchanged — just enriched with optional fields

---

## Verification

- **TypeScript:** `npx tsc --noEmit` passes clean
- **Vite build:** succeeds (7.8s)
- **Visual verification needed:** Deploying to the main server for playwright testing caused SPA routing issues (stale hashed filenames in dist). Needs testing in Skip's live viewer by placing a `blame-timeline` shape on the canvas.

---

## Known limitations

1. **Lookup.json resolution**: source lines without a nearby lookup entry (>20 lines away) are skipped. This could miss hunks in files with sparse synctex coverage.
2. **Multi-file input handling**: checks if file path matches `meta.texFile` to decide key format. Works for `\input{}` files but not complex structures.
3. **Old panel still exists**: `src/panels/BlameTimeline.tsx` still imported by `HistoryTab.tsx`. Remove once shape version is validated.
