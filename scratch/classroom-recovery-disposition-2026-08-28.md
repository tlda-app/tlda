# Public classroom recovery — disposition

Owner: `alassroom-pm` (fleet:1e24c50c). Task `fleet:1e24-mtdconlr`.
**Written 2026-08-28 ~21:25Z. Every row below was measured against
`https://tlda-pic.cormorant-matrix.ts.net`. Re-check before acting: a
disposition is as of now, and this one has already been wrong twice today.**

## The box

`tlda-pic` is the only classroom box with a public A record (`208.111.34.11`,
`208.111.35.209` via `dig @1.1.1.1`). `tlda-pic-dev` and `tlda-fly` return
none — work verified there is a measurement of nobody.

Serving `d41f6839e` since ~21:05Z. Deploy remote `/Users/skip/work/deploy/pic`.

## The five criteria

| # | criterion | state | evidence |
|---|---|---|---|
| 1 | enrollment registers, Continue opens `qtm285-book` | **PASSES — seen in a browser** | advocate typed into the real form, clicked the real button, 0 console errors; DOM link reads `?course=qtm285&project=qtm285-book&classroomToken=…`. Screenshot `.playwright-cli/page-2026-08-28T21-20-43-612Z.png` |
| 2 | book renders Intro → HW−1 → HW0 nonblank | **BROKEN — build failing, see below** | `page-info.json` 404. Content proven present at 20:25Z: 28,497 / 1,845 / 42,365 visible chars |
| 3 | template download + Positron submit | submit works; **download blocked** | `templateDocKey: null`; download 404 |
| 4 | photo → receipt | **PASSES** | advocate drove upload 200 → receipt → submission project built 6 s → PNG served byte-identical |
| 5 | instructor list shows the submission | **PASSES — seen as a screen** | "QTM 285 — Submissions and grading", `4 missing · 3 ungraded · 0 returned`, three rows linking to the marking view. Screenshot `.playwright-cli/page-2026-08-28T21-21-44-181Z.png` |

**Verification method that finally worked, and it is the standing one:**
`playwright-cli -s=shared` directly, bypassing the `tlda-dev pw` pool, whose
tab targeting forwards verbs to an `about:blank` marker tab while claiming
tab-select is missing. **Always open a known-good project alongside the suspect
one** — `qtm285-lecture-1` is the control. That single move is the only thing
tonight that produced an unambiguous answer.

**Do not trust `[FetchAsync] N/M pages rendered`** — it counts the text-selection
overlay, not the visual render. A *working* project reports `0/18`.

## DIAGNOSED 21:10Z — why the book cannot rebuild itself

**Ruled out on the box**, running the real Quarto (1.9.38) against the live
source at `/app/server/projects/qtm285-book/`:

| variant | result |
|---|---|
| source copy, scratch `HOME` | exit 0, HTML produced |
| source copy, server's default `HOME=/root` | exit 0, HTML produced |
| copy of the **output** dir, stale `.quarto/` and all | exit 0, HTML produced |

So Quarto, the environment, the source and the stale cache are all fine. Also
ruled out: the build queue is **not** wedged — a build ran at 20:47:41Z, one
minute after the machine came up at 20:46:24Z.

**The defect is in `server/lib/build-qmd.mjs`, and it is three steps that do
not agree:**

1. `cpSync(srcDir, outDir, {recursive: true})` **replaces the output tree with
   source**, which contains no HTML.
2. `qmdRootsToRender(mainFiles, srcDir, changedFiles)` renders **only the roots
   whose dependency closure contains a changed file**.
3. A loop then demands rendered output for **every** root and throws on the
   first one missing:
   `throw new Error('[qmd] render produced neither …')`

**So a root that was not re-rendered has no output, and the build throws.**

**The consequence is worse than the wipe: once a project's output is lost,
every subsequent incremental build fails on the same missing file, forever.**
The project cannot rebuild itself from its own source. That is why two accepted
pushes produced nothing.

The comment above the throw shows the author saw half of it — the throw exists
so an empty render does not publish over a good one. **It does not help when the
good render is already gone**, which is the state `cpSync` creates two steps
earlier.

**The escape hatch, and it is in the same function:**

```js
// A project file outside every root closure can affect all renders …
return accountedFor.size === changed.size ? affected : mainFiles
```

**A changed file outside every root's closure forces all roots to render.**
`_quarto.yml` is such a file, so a push touching it rebuilds everything. That is
tonight's recovery, and it depends on knowing an internal rule of the build
scheduler — which is why the real fix matters.

**Two separate properties the fix must have**, and only the first was in Skip's
ask: a failed build must not destroy the previous output, **and** a project with
no output must be buildable from its source alone.

**Also found, real but not the outage:** `_quarto.yml` declares two resources
that do not exist — `homework/handouts/hw-minus-1-setup-handout.zip`, and
`lectures/data/social-pressure-data.csv` which actually lives at
`data/social-pressure-data.csv`. Quarto renders anyway.

## The original symptom: `qtm285-book` output is gone

**What happened.** A `tlda project push` at 20:44Z mirrored a checkout's
**untracked** artifact tree — `_cache/`, `*_files/`, stale `.html`, `.quarto/` —
into live project source, because **a push mirrors the directory, not the
tracked tree**. The build failed and **cleared published output on the way
down**. `logMissing: true`, so nothing recorded why.

**Current state.** `source-head 8a89428e`, `acceptSeq 30` — the restored good
source **is** in place. `building: false`, `phase: null`, `lastBuild` still
`18:50:32.829Z`. Nothing queued, nothing running, no output.

**Why it is stuck, and this is the finding worth keeping:**

- **`tlda build` does not exist.** `cli/tlda.mjs:221` documents it as *"Trigger a
  rebuild without pushing files"*. There is no `cmdBuild` and no `case 'build'`
  in the dispatcher; running it prints the top-level menu.
- **`tlda project push` no-ops on an unchanged tree** (`printPushBuildStatus`,
  *"No changes detected"*).

**Therefore a project whose published output has been destroyed cannot be
rebuilt from its own unaltered source.** The only way back is a genuine tree
change. That is why restore-only stopped being a viable instruction.

**In flight:** `classroom-hw1-handout` is pushing the intended change from a
**clean** checkout — `_quarto.yml` filter + resource, corrected register link,
two handout zips, nothing else — as both the fix and the rebuild trigger. If
that build fails they stop and escalate rather than try a fourth thing.

**Control that rules out the box and the machine roll:** `qtm285-lecture-1`,
`qtm285-slides`, `pic-install` and `qtm285-hw-minus-1` all return `200` on
`page-info.json` after the same deploy. Only the project whose build failed
lost its output.

## Committed, deliberately NOT deployed

Ship these together **after** the book is verified serving. The pipeline cost
96 minutes tonight; being wrong about ordering costs that twice.

| sha | what |
|---|---|
| `3e1cab370` | a failed page-info fetch throws, so a 401 renders the existing 🔒 error screen instead of a blank book. Four loaders fixed; red/green counterfactual run both ways |
| `67ecf5422`, `a1494f60b` | `project share` refuses to print a token the target box rejects; unreachable box prints `Unverified` rather than claiming a bad link |
| `c2b13459c` | the process proposal |

## Traps that cost time today — do not re-learn these

- **A blank book means 401**, not unbuilt. `htmlLoader.ts:44` parsed the 401 body
  as the page list. Fixed in `3e1cab370`, **not yet deployed**, so the trap is
  still live on the box.
- **`buildStatus: success` is not a render.** It read `success` for half an hour
  while `/docs/qtm285-book/` was entirely 404. `lastBuild` is the field that
  cannot lie; the student surface is the only real check.
- **`project share` printed a token that 401s on `pic`.** `getReadToken()`
  (`shared/config.mjs:503`) takes no environment and `tokens.json` holds one
  pair, while four environments run four boxes with four secrets. Guarded now.
- **A read token alone gets 401 on the assignment surface** — `classroomPrincipal`
  returns `null` without an enrolment token. **QA done with the rw token is
  checking the instructor's view** and cannot reproduce a student.
- **A bare `?token=` does work in a browser** and fails under `curl`, because
  `authToken.ts` patches `window.fetch` to inject `Bearer`. Prefer
  `/auth/login?token=…&redirect=…` anyway: fewest live parts.
- **Do not drive a browser at `qtm285-book`.** An automated session applies the
  `3-col` fleet preset and writes six shapes into the room students open, once
  per launch, unremovable.

## Decisions taken, and by whom

- **The full book `pic` is off the critical path — mine.** 72 roots, `pages: 0`,
  `lastBuild: null` since 2026-08-12, while `qtm285-book` built in seconds the
  same day. Nothing Skip named for midnight needs it. Deliberately **not**
  claiming "building for sixteen days": nothing refreshes `buildStatus`, so a
  died-mid-build and a running one are indistinguishable. The claim rests on
  `pages: 0` and `lastBuild: null`.
- **Env-keyed tokens are not being built tonight — mine.** A config-schema change
  at the end of a deadline day, when the shipped guard already removes the harm.
  Goes to Skip as a named recommendation.

## THE FINDING: a read-only reader cannot create document shapes

**Document page shapes are created by the CLIENT and written into the synced
room. A read-only reader cannot create them. So a project that has never been
opened by a read-write session renders blank for every reader, permanently.**

Proved by `classroom-blank-401` on a disposable `pic` project — same box, same
bundle, same source, one variable:

| token in the URL | canvas |
|---|---|
| read | 1 page, still named `"Page 1"`, only `doc-version` 1×1 — **blank** |
| rw | 3 pages, `html-page` **800×490, 800×1200, 800×1200** |

**Then reopened with the read token alone: it renders.** One read-write visit
persists the shapes for every subsequent reader.

**Everything else from the night collapses into this.** `qtm285-lecture-1`
rendered because its 18 shapes were already persisted — the slides loader was
never special. The blank rooms hold exactly `document` + `page` + `doc-version`,
with no `user` record and no fleet shapes, which is what read-only produces.
`pic-schedule` blank since 2026-08-13 is a project nobody ever opened
read-write. The 403 on `/api/projects/:name/signal` was that same refusal, in
the console the whole evening.

### The operational rule nobody had written down

**Students open with a read token by design.** Therefore **every project a class
opens must already have been visited read-write at least once**, or they get a
blank canvas. Nothing checks this, nothing warns, and every server-side signal
reads green — built, right page count, content present.

**That is the exact shape of an unusable class where every layer reports fine.**

**Recovery needs no deploy:** open each affected project once with the RW token.

### Dead ends, so nobody re-runs them

All of these were confidently held at some point tonight and are refuted:

- geometry not reaching the shape (mine)
- `createShapes.ts:241`, declared height applied only at creation
- `defaultPageId` page-mapping
- the `source`-block correlation — 6/6 and it did not generalise
- client/server schema mismatch (`sync-rooms.mjs` byte-identical across the shas)
- stale bundles on either box
- `tokenGating` breaking a fetch (mine — right variable, wrong mechanism; the
  gate makes the reader read-only, which is what it is for)

**And two instruments that proved nothing while looking like proof:**
`.tl-page` count is **0 on a fully working render too**; and
`[FetchAsync] N/M pages rendered` counts the text-selection overlay, so a
working project reports `0/18`.

## In a daemon-bound checkout, saving a file publishes it

**`classroom-hw1-handout` never ran `tlda project push` for the solution
removal.** The daemon committed, pushed and built on its own — `acceptSeq 37`,
`a2308b7`, built 23:30:25Z — and the build was finished before they went
looking for it.

**On a live student surface that is a loaded gun**, and nothing in the workflow
says so. **Anyone editing in such a checkout merely to inspect a change has
already shipped it.**

It also produced a near-miss worth keeping, because it is unfalsifiable from
outside: they diffed against `git show HEAD:` for a "before" and got a perfect
match — **the daemon had already committed the edit, so HEAD *was* the after.**
Had they trusted it they would have reported "prose preserved" from a
comparison of a file with itself. They caught it and refetched the real before
from the box.

## The solution exposure, and how it was missed for four hours

**The published homework pages carried the worked solutions to students** — 19
on HW0 with the arithmetic in them, 1 on HW−1 — in the raw read-token HTML,
with no CSS hiding them.

**Why it survived so long: the artifact everyone verified was the wrong one.**
The downloadable zip was the *filtered handout* and it was clean, checked twice.
**The published page is the *master*, and nobody fetched it.** I found the
mechanism on HW−1 hours earlier, saw one block whose answer was *"any photo of
anything"*, called it harmless and **never counted the other chapter.** One page
sampled, conclusion generalised.

**The fix, and why the obvious one was wrong.** Adding the course's
`solution-callout.lua` looks like the fix and is not: it is
`quarto.Callout({… collapse = true})`, **a disclosure widget rather than a
removal**, so it converts a visible leak into a collapsed one that *looks*
handled. The course's real filter is `encrypt-solutions`, whose own docs say
that without `SOLUTION_WEEK_KEYS` it falls back to the same collapsed callout —
and the tlda build sets no such variable. **The fix was to publish the generated
handout instead of the master**, using the generator that already existed.

**Acceptance was deliberately two-sided**, because a page stripped of questions
*and* answers passes a naive check: zero `callout-solution` **and** the
exercises still present, with visible-text length compared before and after.

## An acceptance criterion can be a lying instrument too

**The sharpest self-inflicted lesson of the night, and it belongs with the
others because it is the same disease from the other side.**

Fixing the orphan `qtm285-hw-minus-1` produced a 1.2 MB self-contained page
where an 83 KB externally-linked one had been. I called that a regression and
set acceptance as: **"byte size back in the same order as the book's
chapters."**

That was met exactly — 51,317 bytes — **and the resulting page referenced four
stylesheets that all 404**, because a single-file project has no sibling
directory to serve `index_files/` from. **51 KB correct and 51 KB broken are
indistinguishable to a byte count**, and the byte count was what I asked for.

**The criterion was a proxy for "renders like a normal page" and the proxy
passed on a page that does not render.** Every other lying instrument recorded
here — `.tl-page` counts, `N/M pages rendered`, `buildStatus: success` over a
destroyed render — fooled somebody who inherited it. **This one was built into
the gate, by the person writing the gate.**

**The corrected criterion, which is the durable form:** *every asset the page
references resolves* — fetch each one and confirm 200, or confirm there are
none. **"Does it work", not "is it about the right size."**

**And the diagnosis under it was wrong in the same direction.** I called
`embed-resources` a category error — a download's settings inherited by a
served page. That holds for a project with sibling asset directories. **A
single-file project has none, so self-contained is the only correct mode**, and
the page I reopened was already right.

## A standing defect found tonight, with no owner

**A project can be permanently unrenderable while every HTTP signal on it is
green, and one has been since 2026-08-13.**

`classroom-advocate` surveyed all six projects on `tlda-pic`:

| project | entries carrying `source` | `toc.json` | renders |
|---|---|---|---|
| `qtm285-lecture-1` | 18/18 | 200 | ✅ seen |
| `qtm285-slides` | 18/18 | 200 | — |
| `pic-install` | 1/1 | 200 | — |
| `deploy-probe` | 1/1 | 200 | — |
| `qtm285-hw-minus-1` | **0/1** | **404** | ❌ 1×1 empty shape, seen |
| `pic-schedule` | **0/1** | **404** | ❌ 1×1 empty shape, seen |

`source` presence and `toc.json` presence agree on all six — two faces of the
same missing build step.

**It is falsifiable and survived an attempt.** They opened `pic-schedule`
*because* a no-source project rendering correctly would have refuted the lead.
It renders the same 1×1 empty shape and "No headings found" — predicted in
advance, on a project nobody had touched.

**`pic-schedule` has been in that state since 2026-08-13 and nobody noticed**,
because `page-info.json` returns 200 and the page count is right. So whatever
build step writes `source` and `toc.json` has been silently skipping projects
for over two weeks.

**Deliberately not chased tonight** — it is not one of the five criteria and
starting a seventh workstream at that hour is how an evening stops converging.
It needs an owner.

## For Skip, not for us

- Whether `pic` should gate on `testing` the way `stable` does. It currently
  does not.
- Env-keyed read tokens (`classroom-share-token`'s shape A).
- Whether `tlda project push` should refuse, warn, or respect `.gitignore`
  rather than silently mirroring untracked files into a live project.
- That **a failed build empties published output with no rollback to the last
  good render.** This is what turned a content mistake into an outage.
- `CLAUDE.md` imports `~/work/dot-claude/reference/lane-app.md`, which does not
  exist on this machine.

## A student can read another student's submission, with the class read token

**Measured on the PUBLIC box `tlda-pic` (`5784f5787`), using only the shared
read token — the one on the QR code that every student holds.** No rw token, no
enrolment token, no browser.

```
/api/projects                                            200
  → 13 projects, 3 named with student logins:
      submission-hw-minus-1-setup-qtm285:advocate-check-1
      submission-hw-minus-1-setup-qtm285:heicprobe01
      submission-hw-minus-1-setup-qtm285:photo-demo-0828-1519

/api/projects/submission-…:photo-demo-0828-1519          200
/docs/submission-…/page-info.json                        200
/docs/submission-…/hw-minus-1.html                       200   49,153 bytes
/docs/submission-…/my-photo.png                          200  320,849 bytes  image/png
```

**The rendered submission and the student's photograph both come back**, and
`page-info.json` is 200 for all three submissions — it is the class of them,
not one project.

**The control that makes this a finding rather than a misread:** the classroom
API is correctly gated against the same token —
`/api/classroom/courses/qtm285/status` → **401**,
`…/assignments` → **401**.

**So the authority model holds where it was written and is absent where it was
not.** Submissions are published as **ordinary projects**, and `/docs/*` is
gated by the shared read token alone — which every classmate has by design.
**Nothing in the document layer knows a submission belongs to one student.**

**The exercise is "take a photo of something in the room you are in", so the
artifact is a photograph of a student's home.**

**No real student is exposed today.** All three submissions are ours —
`advocate-check-1`, `heicprobe01`, `photo-demo-0828-1519`. **The mechanism is
live; the harm is not, yet.** It becomes real at the first hand-in, which is
the thing the whole flow exists to produce.

**Not fixed and not touched.** It is the authority model — the same class of
question as the first-reader decision, one surface over — and that is Skip's.
**Unlike the first-reader decision, this one has a date on it.**

## `main` cannot be deployed to `pic`, `pic-dev` or `stable`

**Found 2026-08-29 02:35Z, before deploying the submission gate. Not fixed —
it belongs to the front-door cutover owner. Re-check before any deploy of
`main` to those three apps.**

`51574efd9` moved the tailnet node and `tailscale serve`/`funnel` **out of**
`scripts/fly-entrypoint-live.sh` and **into** `scripts/fly-entrypoint-edge.sh`,
which runs as a separate Fly **process group**. `fly.live.toml` declares that
group. **`fly.pic.toml`, `fly.pic-dev.toml` and `fly.stable.toml` declare no
`[processes]` at all**, so they run the image's default
`CMD ["/app/fly-entrypoint-live.sh"]` and never run the edge entrypoint.

Measured with controls in both directions:

| | tailscale references |
|---|---|
| `fly-entrypoint-live.sh` at `51574efd9^` | 9 |
| `fly-entrypoint-live.sh` on `main` | **0** |
| `fly-entrypoint-edge.sh` on `main` | 10 |
| `fly-entrypoint-live.sh` at `5784f5787` — what `pic` serves today | 9 |

And `deploy/hooks/pre-receive-common.sh:229` passes `--process-groups app`
**only** when the config is `fly.live.toml`; every other app gets a plain
`fly deploy`.

**So deploying `main` to `pic` starts no tailscale node**, and
`TS_HOSTNAME=tlda-pic` / `TS_FUNNEL=1` in `fly.pic.toml` do nothing.
`tlda-pic.cormorant-matrix.ts.net` is the QR code, the PWA `start_url`, and the
only public A record. **`stable` is the same shape.**

**What was done instead:** the submission gate was cherry-picked onto the sha
`pic` is already serving — `3aeea40e4` = `5784f5787` + one commit, five files,
nothing from the cutover — and that was deployed. `170e4e6de` is the same
commit on `main`, waiting for `main` to be deployable to these apps again.

## `pic-dev` serves a frontend from before 18 June

**The reported first-time-student failure is not a code defect.** `pic-dev`'s
server reports `e0220ac74` (28 August) and hands out
`/assets/index-BETHBNov.js`, which carries a login modal deleted from `src` on
2026-06-18 and none of the classroom student-registration feature.

| string in the served bundle | present? | introduced |
|---|---|---|
| `Enter your name to log in` | **yes** | `49ff7f658` 2026-04-19, deleted `300780038` 2026-06-18 |
| `Using temporary identity` | no | `300780038` 2026-06-18 |
| `identity-auto-notice` | no | `300780038` 2026-06-18 |
| `Keep this token` | no | `237e32a38` 2026-08-11 |
| `classroomContinueLink` | no | `a2a7fb530` 2026-08-28 |

**Control — `pic` is current:** entry `index-B8K9teHu.js`, 5,492,169 bytes, modal
absent, auto-assign present, classroom registration present. `pic-dev`'s entry is
3,629,454 bytes with the reverse.

**So the fix is a `pic-dev` rebuild, and it is blocked by the section above.**

**The lesson is the standing one:** `/api/build-info` names what the **server**
checked out. It says nothing about the bundle the browser loads, and the two can
be two months apart. Inspect the bundle named by the served `index.html`.

## Every way the class read token reached a student's handed-in work

**The first fix closed the documents and I called it done. Four more doors were
open, and I found them one at a time — which is the wrong way and is why this
list exists.** The right move was the one I made third: **enumerate everything
that can name or serve a project, then check each.**

| # | door | how it was measured | closed by |
|---|---|---|---|
| 1 | `/api/projects` index names submissions by student login | read token, 3 listed | `170e4e6de` |
| 2 | `/api/projects/<submission>` and every `/:name/*` under it | read token, 200 | `170e4e6de` |
| 3 | `/docs/<submission>/{page-info.json,*.html,my-photo.png}` | read token, 200, 320 KB of `image/png` | `170e4e6de` |
| 4 | `/api/projects/<submission>/history/shadow{,/bounds}` | read token, **200 after 1–3 shipped** | `4d40ce681` |
| 5 | `history/shadow/changelog/batch`, `history/shadow/index` — names in the **request body**, invisible to any path gate | read token, answered for 1 | `4d40ce681` |
| 6 | `/docs/manifest.json` names every project on the box | read token, 3 submissions named | `4a5471003` |
| 7 | `/sync/doc-<submission>` — the room holding its page shapes and grading marks | real WebSocket, **accepted**; book's room accepted as the control | `4a5471003` |
| 8 | `/source-sync/<submission>/<file>` — the file the student uploaded | **not measurable**: 502 from outside to every request including the no-token control | `7ae691084`, by inspection only |

**Why 4 and 5 existed after 1–3:** `router.use('/:name', requireClassroomDocumentAccess)`
is declared **below** two mounts that also match a project name, so express
reaches those first. **A gate is only as wide as the line it sits on.**

**Why 7 is the worst of them:** `classroomRoomAccess` refuses one student another's
private overlay **because the room name says whose it is**. A submission's room is
`doc-submission-<assignment>-<student>` — an ordinary document room to look at. The
name cannot carry the fact, so the caller resolves the owner from the submissions
record.

### The check that kept being wrong, and the one that worked

**A node one-liner reading `/docs/manifest.json` reported `submissions named: 0`
while the raw bytes carried three.** It read the wrong shape — the manifest is
`{documents: {...}}`, not an array — and answered confidently. **Looking at the
first 700 bytes is what found it.**

**`scratch/verify-submission-access-gate.sh` was run against the deploy that only
closed 1–3, and four checks went red while the old ones stayed green.** That red
run is what makes a later green run mean anything.

**The instructor half is in the script and the script exits nonzero without it.**
A gate nobody can get through passes every refusal check ever written.

### One thing the first fix got wrong in the other direction

**It was stricter than the rule the app already had.** `canReadStudent` lets a
classmate read a submission **row** when the owner's `layerScope` is `common` — an
explicit opt-in, never the default, covered by two existing tests. My gate refused
that classmate the document, the index entry, the history and the room. **Nobody
asked for that, and it would have arrived under a privacy fix.** `52e1f3582` moves
the rule into the store as `mayReadStudentWork` and has `canReadStudent` call it.

**No live instance:** all ten students on the course box are `layerScope=student`,
read with the rw token at 2026-08-29 03:00Z. So the narrowing broke nothing that
exists; it was still wrong.

### Correction to row 7: the door was real, my evidence was the wrong spelling

**The probe used `encodeURIComponent`, so the `OPEN` it measured was an EMPTY
room.** Read on the box, read-only:

```
/app/server/persist/projects/submission-…-qtm285:photo-demo-0828-1519/sync-snapshot.json
    2,584 bytes, 1 html-page shape        ← the room that holds the work
directories matching %3A                    0
```

Snapshots are keyed by the project directory with a **literal colon**, and
`getOrCreateRoom` uses the room name verbatim with no normalisation, so
`doc-…%3A…` is a different name with no snapshot behind it.
`SvgDocument.tsx:841` builds the sync URL as a plain template literal with **no
encoding**, so the real client opens the literal-colon room.

**So row 7 was a real door** — pre-fix `classroomRoomAccess` returned `read` for
any non-overlay room on a read token, that room included, which is unambiguous
from the code — **and the measurement offered for it was of a different room.**

**The percent-encoded spelling is a check that can be spelled around.** Closing
it is right; it exposed nothing. That is the fourth instrument tonight that
answered without measuring, and the first where the answer happened to point at
a real defect anyway. **A right conclusion does not make the evidence for it
good**, and the next person reading row 7 needs to know which part was measured.

### Why `pic-dev`'s bundle is two months old: the image copies `dist/`, it does not build it

`Dockerfile.live:319` is `COPY dist/ ./dist/`, and **nothing in that Dockerfile
runs a client build.** So the bundle in any image is whatever `dist/` was sitting
in the directory `fly deploy` ran from.

- **A pushed deploy is always current**, because `deploy/hooks/pre-receive-common.sh`
  makes a fresh checkout and runs `npm run build` in it before `fly deploy`.
- **A hand-run `fly deploy -c fly.pic-dev.toml` from the shared checkout ships
  whatever is lying in `/Users/skip/work/tlda/dist`** — a directory a dozen agents
  write to and nobody owns.

`pic-dev` reports `builtAt 2026-08-28T14:33:30.944Z` and `checkoutPath
/Users/skip/work/tlda`. **That is the signature of a hand-run deploy**, and it is
how a server at `e0220ac74` came to hand out a client from before 18 June.

**The fix for `pic-dev` is a deploy whose build is its own**, which is what the
deploy remote already does for `pic` and `stable` — and there is no deploy remote
for `pic-dev`.
