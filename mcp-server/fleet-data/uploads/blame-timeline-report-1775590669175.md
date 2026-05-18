# Blame Timeline Rework — Report

**Worktree:** `.claude/worktrees/blame-timeline`
**Branch:** `worktree-blame-timeline`
**Commits:** `019f96a` → `5db8496` → `8802e2f` → `c01eb0c`
**Build:** tsc clean, vite build passes

---

## Screenshot

### Overview — survival-draft (85 edits, 35 pages)

![Blame timeline with author-colored bars, page-based Y-axis, accurate sizing](blame-timeline-1-overview.png)

- **Y-axis**: compiled document position (p1–p35), mapped via lookup.json synctex data
- **X-axis**: time (4/1–4/5)
- **Color**: author (legend shows "tlda" — shadow repo auto-commits; source repos with real git show actual authors)
- **Bar height**: proportional to actual edit size — small edits = thin marks, large edits = tall bars
- **Dense layout**: thin columns per commit, no inflation

### Hover tooltip — author, location, timestamp

![Hover tooltip showing author (tlda), page 11, experiments.tex, lines 16-21, timestamp, commit hash](blame-timeline-2-hover.png)

Hovering over a hunk shows:
- **Author** in color ("tlda")
- **Document position**: Page 11 · sections_arxiv_icml/experiments.tex
- **Edit extent**: Lines 16–21 (5 lines)
- **Timestamp**: 4/2/2026, 7:42:15 PM
- **Commit hash** with "click to navigate" hint

---

## What Changed (from original)

1. **Y-axis = compiled document position** — server enriches hunks with page + renderedY from lookup.json. Basename path fallback for shadow repos with different directory structures.

2. **Proper tldraw shape** — `BlameTimelineShapeUtil`, registered in SvgDocument.tsx and sync-rooms.mjs.

3. **Color = author** — each git author gets a distinct color. Hover tooltip shows author prominently. Shadow repos show "tlda"; source repos with real git history show actual author names.

4. **Accurate bar sizing** — bar height proportional to actual line count (12pt per line in doc space). No minimum height inflation.

5. **Sync schema registration** — `blame-timeline` added to `server/lib/sync-rooms.mjs` customShapeSchemas. Without this, creating the shape crashed the app with INVALID_RECORD.

---

## Files Changed

| File | What |
|------|------|
| `src/shapes/BlameTimelineShape.tsx` | New tldraw shape |
| `src/SvgDocument.tsx` | Register shape |
| `src/historyStore.ts` | BlameHunk + BlameCommit types extended |
| `server/routes/history.mjs` | Author in blame data + lookup.json enrichment + basename fallback |
| `server/lib/sync-rooms.mjs` | Register blame-timeline in sync schema |
