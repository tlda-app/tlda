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
