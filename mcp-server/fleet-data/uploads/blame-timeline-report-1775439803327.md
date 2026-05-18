# Blame Timeline Report

**Branch:** `worktree-blame-timeline` | **Commit:** `019f96a`
**Files changed:** 4 source files (+506 lines)

---

## What it does

A 2D visualization of document edit history in the History tab panel.

- **X axis** = time (dates across the edit range)
- **Y axis** = line number in the document
- **Color** = which file was edited
- **Hover** = shows file, line range, adds/deletes, timestamp, commit hash
- **Click** = selects that version in the history scrubber

Activated by the **▦** button in the History tab's toolbar row, next to the existing shadow history (↻) and timeline (⏱) buttons.

---

## Screenshot

Blame timeline for `survival-draft` (55 shadow commits over 4 days):

![Blame timeline canvas showing edits by file and line position over time](scratch/blame-timeline-canvas.png)

The timeline shows:
- Rose/pink bars: large file changes (proof files, arXiv.tex)
- Teal bars: datasets.tex and experiment edits  
- Vertical spread shows WHERE in the file changes happened (line numbers)
- Dense cluster on 4/3: major restructuring (appendix split, new proof files)

Full page with panel visible:

![Full page with blame timeline in right panel](scratch/blame-timeline-full.png)

---

## Architecture

### Server: `/shadow/blame` endpoint

`server/routes/history.mjs` — new `GET /api/projects/:name/history/shadow/blame`

1. Runs `git log --format="COMMIT %H %at" --numstat` on the shadow repo
2. For each consecutive commit pair, runs `git diff --unified=0` to get hunk headers
3. Parses `@@ -old,count +new,count @@` into structured data
4. Returns `{ commits: [{ hash, timestamp, files: [{ path, added, deleted, hunks }] }] }`

Single API call for all blame data — no N+1 fetches.

### Frontend: `BlameTimeline` component

`src/panels/BlameTimeline.tsx` — pure canvas rendering

- Fetches blame data on mount
- Builds file→color map from all unique file paths
- Draws on HTML canvas (DPR-aware, responsive via ResizeObserver)
- Legend shows file colors, hover tooltip shows edit details
- Adapts padding/labels for narrow panels (< 300px)

### Integration

`src/panels/HistoryTab.tsx` — blame button + collapsible panel

- ▦ button toggles `showBlame` state
- When active, renders `BlameTimeline` in a 280px-tall container
- `onSelectVersion` callback maps commit hashes to history scrubber indices

---

## Files changed

| File | Changes |
|------|---------|
| `server/routes/history.mjs` | New `/shadow/blame` endpoint with numstat + unified diff parsing |
| `src/historyStore.ts` | `BlameCommit`, `BlameHunk`, `BlameFileChange` types + `fetchBlameData()` |
| `src/panels/BlameTimeline.tsx` | New canvas-based visualization component (250 lines) |
| `src/panels/HistoryTab.tsx` | Import + ▦ toggle button + BlameTimeline render |

---

## Test evidence

- **API verified:** `curl` returns 55 commits with hunk data for `survival-draft`
- **Canvas verified:** playwright extracted canvas pixel data: 3.2% colored pixels (edit bars), 83% non-white (background + grid)
- **Canvas exported:** raw `toDataURL()` shows clear file-colored bars at correct time/line positions
- **Build:** `tsc --noEmit` clean, `vite build` succeeds
