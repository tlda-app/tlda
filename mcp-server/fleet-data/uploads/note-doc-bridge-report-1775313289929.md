# Math-note ↔ tlda Doc Bridge

## What was built

A bidirectional bridge between `MathNoteShape` and tlda markdown docs. A math-note with a `docName` prop becomes a live two-way view of a linked doc.

## Changes

### `src/shapes/MathNoteShape.tsx`
- Added `docName: T.optional(T.string)` and `docView: T.optional(T.boolean)` to shape props
- `canEdit` returns false when `docView` is true (prevent text edit while showing iframe)
- **note→doc sync**: debounced 1s `useEffect` on `shape.props.text` — auto-creates the project if missing, then pushes `main.md` via `POST /api/projects/:name/push`
- **doc→note sync**: polls `GET /api/projects/:name/source/main.md` every 3s, updates shape text if changed; skips when editing or mid-push (tracked via `pushingToDocRef`)
- **tlda logo button**: small doc icon, top-right of shape; `onPointerDown` toggles `docView` prop (TLDraw-native, `stopEventPropagation` from tldraw)
- **iframe region**: when `docView: true`, content area is replaced with `<iframe src="/?doc=${docName}">` filling the shape

### `server/routes/projects.mjs` + `server/lib/project-store.mjs`
- Added `GET /api/projects/:name/source/:file` endpoint — reads raw source file content as `text/plain`
- Path traversal guard: rejects paths that escape the source dir

### `server/lib/sync-rooms.mjs`
- Added `docName` and `docView` to the `math-note` schema so the worktree sync server accepts the new props (production server not touched)

### `server/unified-server.mjs`
- Added `{ dotfiles: 'allow' }` to all 4 `res.sendFile()` calls — fixes 404s when serving from the `.worktrees/` directory (Express blocks dot-prefixed dirs by default)

### `vite.config.ts` + `.env.local`
- Vite proxies point to worktree server (port 5177)
- `VITE_SYNC_SERVER=ws://localhost:5177` routes Yjs shapes to the worktree server

---

## Verification screenshots

### 1. Note with linked doc (docName: 'nb-test-doc')
Note rendered with markdown content. tlda logo button visible top-right (opacity 0.3). Note→doc sync fires within 1s — `main.md` and `page-info.json` title both updated on the worktree server.

![note with linked doc](nb-step2-note.png)

### 2. iframe open (docView: true)
Clicking the logo button sets `docView: true`. The note's content area is replaced by an embedded iframe showing the linked tlda viewer.

![iframe open](nb-step3b-iframe.png)

### 3. Doc→note sync confirmed
Manually edited `server/projects/nb-test-doc/source/main.md` to "# Doc→Note Sync Test / This content was **edited externally**...". Within 3s the shape's text prop updated to match — note now displays the externally-edited content.

![doc→note sync](nb-step4-synced.png)

---

## Notes / not done
- **Zoom param** (`&zoom=Z`): confirmed by manager as the right approach. The iframe src currently passes `/?doc=${docName}` without zoom. Implementing requires reading the canvas zoom value at toggle time and threading it into the URL — straightforward but skipped since the doc viewer zoom-on-mount feature doesn't exist yet.
- **Production sync-rooms**: `sync-rooms.mjs` in the worktree is patched but main isn't — needs to land before merging.
