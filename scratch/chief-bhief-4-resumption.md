# Chief of staff resumption point — `bhief-4`, 2026-08-23

Force-added under `scratch/` deliberately: this is a resumption point, not a report.
`scratch/` is gitignored, so an untracked copy would not survive. See `AGENTS.md`
§"Repository workflow".

**Relative to:** `main` at `d6009b693`. Deployed sha on `tldraw-sync-skip` is
`25825e519`. `main` carries two undeployed commits — `c5c8ec8d3` (docs) and
`d6009b693` (the parts migration). **Neither needs a deploy**: the migration was
run directly against the box, and the code path it protects only matters at
startup.

## His priorities, his words, this morning

**SYNC. PERFORMANCE. LOCKUPS.** He is writing to a deadline.

## Closed

### The gray hole in his document panel — fixed, verified

The `html-page` shape `spatial-document-1tztltd` pointed at
`/docs/<project>/parts/a1b81267.html`, which returned `{"error":"Not found"}`.
The part had been destroyed by the build-publish swap before `25825e519` fixed
that class. Restored under the same path so his existing shape resolved without
him touching anything; both iframes now render 9,666 characters.

**Read his shape props over `air-agent` to get this** — `window.__tldraw_editor__`
`.getShape(id)`, read-only. The `meta.spatialWorldTitle` carries the source path
the part was materialized from, which is how the content was recovered.

### 16 parts stranded across 7 projects — fixed live, migration committed

`25825e519` moved the parts root from `sourceDir` to `projectDir` and **did not
move the parts**. Every part written before it deployed was under `source/`,
where nothing looks. It does not error — `addMarkdownColumn` returns on ENOENT,
so the column stops existing.

`d6009b693` adds `server/lib/migrate-project-parts.mjs`, run at startup. Rename
plus manifest merge, nothing deleted, a file moves only when the destination is
absent, so a part already at the new root wins and a second run is a no-op.

The same code was run against the live box without a deploy. Verified by
fetching two carried parts: 200, 151 KB and 41 KB.

## Open, with owners

### `air-file-refs` (fleet:dc630e1a) — the renderer memory

**A finding was retracted here and the retraction is the important part.** The
33.5M-pixel chat sensor layers were reported as ~780 MB and are not: measured in
an isolated repro, a 20,000,000 px spacer and a 20,000 px spacer both cost
~227 MB, painted or empty. Chrome tiles it. **Do not shrink
`ANCHORED_SENSOR_HEIGHT` believing it is a memory fix.**

What the memory actually is, from `Tracing.requestMemoryDump` on his renderer:
GPU shared images and IOSurfaces ~490 MB, canvas backing stores 208 MB (two at
4282×2084 — his `devicePixelRatio` is 2.2), Blink heap 308 MB, malloc 275 MB,
tile memory 121 MB across the whole page. **No single runaway thing.**

**Live lead:** one `shared_memory` segment of 310 MB, a quarter of the
deduplicated total, unattributed. `air-file-refs` is chasing its ownership edges
and whether it is constant or reallocated.

**Also owed by it:** corrected errata text for `docs/chat-rendering.md`, whose
errata claims the anchored list "has never been rendered in the app" while
`f34e43f77` merged it and `grep -c Virtuoso src/shapes/FleetChatShape.tsx` is 0.

**Constraint on it:** the session is confined to `~/work/dot-claude` and cannot
write to `~/work/tlda` or `~/worktrees`. It produces measurements and text; a
different agent lands them. Fixing the grant is better than being its hands.

### `build-on-push` (fleet:bbe407d8) — every push runs a full render

`shouldBuildOnPush` has no production caller, so every accepted proposal
dispatches a full build.

**My first brief was wrong and it caught it.** `advanceHead` has exactly one
production caller, inside `publishBuildInstance`, which only runs inside a build
that ran — so the build **is** the accept. Suppressing it would leave a pushed
revision as a proposal ref that never becomes head, with the pusher getting a
200.

**The agreed shape:** one branch in the build worker, on `outside-tree` **alone**
— stage `source/`, advance the head, skip only the render.

**Why only that case** (from `chief-advocate-3`, reading the code rather than
the doc): `relevant-files-parse-failed` returns `build: true`, so it is not a
suppression case at all; `already-building` fires only for
`format === 'svg' && pages === 0`. On a mature SVG project `outside-tree` is the
only verdict that can ever fire.

**Gated on two numbers before it commits:** what a render costs on a large LaTeX
project, and what fraction of accepted revisions are `outside-tree`. If that
fraction is near zero the branch buys nothing.

**Also owed by it:** `docs/what-the-old-push-did.md` §2, now stale in three ways
— measured against `applyAcceptedSourceEffects`, which no longer exists, plus the
two above.

### `silent-drop` (fleet:714622de) — a dropped document reports success

**Measured.** A new document in a project with roots configured, not referenced
by any root:

```
not staged   →  not in the submitted revision   ·  status=SubmittedToBuildQueue ok=true
git added    →  not in the submitted revision   ·  status=SubmittedToBuildQueue ok=true
```

Reporting only. **It is not to change what syncs** — that decision is with Skip
and is not settled.

The harness is `bin/a-new-document-reaches-the-server-test.mjs`, which already
builds the fixture; the shape it was missing is the standalone unreferenced
document.

### `stale-copy` (fleet:d806be8d) — a chat click makes a frozen copy of a live document

**Measured on the box at 15:15Z.** Three copies of one file:

```
his disk                         11,647 bytes   11:13
the project document on server   11,654 bytes   11:12   live, syncing
the part he was reading          10,235 bytes   10:45   frozen
```

**The part is a snapshot and nothing on screen says so.** The file was already a
document root, and the server already served a live render of it at
`/docs/<project>/<root>.html` — 200, 70 KB, current. So the click produced a
second frozen copy of a document the app already had.

**Note against my own work: restoring that part restored a snapshot.** It filled
the gray hole, which is what he asked for, and it did not give him a live view.
I told him so.

## With Skip, actually asked, not parked

**What makes a file a member of a project.** He said at 08:06 EDT it is *"supposed
to bea. fucking git add"*, *"to the fucking lda branch"*, and that a manifest
*"wasn't lke, fucking not included in the design."*

What it does today: the sync set is the transitive closure of the declared
document roots. A file gets in by being referenced by a root or by being one.
There is **no verb for adding a document** — `tlda project link <name> <root...>`
replaces the whole list.

**Why plain `git add` cannot be the rule as stated:** his repo has 398 tracked
`.md`/`.tex`/`.qmd` files, 225 under `scratch/` and 122 under `revision/`.

**Put to him as an actual question:** append-a-root verb (my recommendation), or
a declared directory — *everything under `paper/` is a document*. Unanswered as
of writing.

**Correction, established after the above and after I had already put the
general finding to him: the document he was editing today IS a configured
document root**, and its bytes are on the server, current. Sync works for it.
The silent-drop defect is real and general; **it was not his case.** What died
this morning was a *second* copy — the chat-materialized part of the same file.
Do not carry "his document does not sync" forward. It does.

**And that same fact is the load story.** His project has three document roots;
the render's `relevant-files.json` holds 25 paths, all `.tex`, and the markdown
root is not among them. So every edit to it dispatches a full compile that does
not read it — which is precisely `outside-tree`, the one verdict the unused
filter would return.

## Standing facts worth not re-deriving

- **His tab, read-only, over `air-agent`.** `ssh -N -L 9222:localhost:9222
  air-agent` then a `ws` client against `ws://localhost:9222/devtools/page/<id>`.
  **Tunnel on local port 9222, not another number** — Chrome rejects the upgrade
  with a 500 when the `Host` header does not match. A 500 saying `No such target
  id` means he reloaded and the target id changed; re-list.
- **`performance.memory` is misleading here.** It reports V8's heap (72 MB) and
  says nothing about Blink's (308 MB) or the compositor's, which is where this
  page's memory is.
- His Air is 8 GB with ~2.4 GB swapped. The renderer oscillates 850 MB – 1.7 GB.
  A sampler writes `/tmp/renderer-rss.txt` on the Air every 60s: epoch, renderer
  RSS in KB, swap used in MB.
- **The 55 Terminal sessions on his Air are 88 MB of shells plus 129 MB of
  Terminal.app.** They are macOS window restore at boot. Not the memory story,
  and telling him to close them would be user-blame on a wrong number.

## Inherited and NOT established — do not act on these as facts

- **`dev`'s file-materialization probe**, failing continuously from `13:57Z`. It
  is absent from the failure report as of `14:46Z`, so it appears to have
  cleared, and **I have not established why**. The previous chief's "it's
  contention" was explicitly unverified. Its decisive test is calling
  `createProjectThroughGit` from `dev-bot.mjs` directly; **Skip stopped that
  command once**, so it is not to be re-run without asking him.
- **`qynth-advocate` (fleet:9088cd80) has no `permission_grants` row.**
  Operator-only. He knows.
- **The reason-less `unhandledrejection` bursts.** Three at `14:34:29`–`:31`,
  and bursts back to `11:19` — before `25825e519`, so not that deploy. The
  rejections genuinely carry `undefined` as their reason; Chrome's own protocol
  reports `"Uncaught (in promise)"` with no object and no frames, so the beacon
  is honest, not blind. `air-file-refs` has a read-only listener attached for
  the next one.

## Ruled out — do not re-derive these

- **The build storm is not what escalated the crash rate at 15:07Z.** Client
  `unhandledrejection` bursts went from three every 5–15 minutes to three to
  five *every* minute at 15:07. Build submissions for that project ran at
  roughly one a minute, flat, from 14:34 to 15:21 — 35 of them, all `complete`.
  The rate changed against a constant build rate. Cause still unknown;
  `air-file-refs` is diffing the 14:45 and 15:07 windows of Fly's `client.log`.
- **`Reload signal (full)` does not blank his document, so it is not the gray
  box.** It fires on every build — about once a minute — but its only
  subscribers are `docInfoCache`, `synctexLookup`, `TocTab` and
  `FleetInboxShape`. Cache invalidation and two refetches, not a page reload. I
  was about to tell him it was his gray box and checked first.
- **The xterm crash is real and unattributed.** `TypeError: Cannot read
  properties of undefined (reading 'dimensions')` from `Viewport._innerRefresh`
  — a `requestAnimationFrame` callback landing after the renderer is gone, i.e.
  a terminal-pane teardown race, over a non-null assertion in
  `RenderService.get dimensions`. One occurrence, `12:02:21Z`, `kind: "error"`.
  **It is not established as the white screen** and a `requestAnimationFrame`
  throw is not caught by a React error boundary, so it is not obviously what
  blanks a tree. It is in the `xterm` dependency, not our tldraw fork.

## What I got wrong today, so the next person does not repeat it

- Told him "none stranded anywhere else" **without having checked**. Sixteen
  were. Corrected in a separate message rather than an amend.
- Told him three times to reload his tab **after it had already filled in**. The
  advocate caught it; the fix was to read the tab instead of assuming.
- Handed him the compositor answer as his lockup cause before it was measured.
  Retracted.
