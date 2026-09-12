# Every production reach into the old sync path {#inventory}

> ## ⚠ THIS DOCUMENT'S SWEEP WAS SCOPED WRONG. READ THIS FIRST.
>
> **The list below searched `cli/` and `src/` only. `mcp-server/` was never searched and holds
> two live callers.** Every sweep that used this list inherited that blind spot, for the whole
> night, including my own re-runs of it.
>
> **The two it hid:**
>
> - `mcp-server/source-push-orchestration.mjs:12` — `pushMcpSourceFiles`, imported live at
>   `mcp-server/index.mjs:49`. Found on `main` by `route-probe-cn`. **Already cut** on
>   `browser-callers-json` / the fold.
> - `mcp-server/report-doc-post.mjs:89` — `postReportDoc`, imported live at
>   `mcp-server/fleet-tools.mjs:438`. **How an agent's task report becomes a document.**
>   **Still live on the fold. This is the last caller.**
>
> **Both build their own `sourceManifest`** — the same class of producer that refused every push
> Skip made from 2026-08-17 onward.
>
> **So the count is 19, not 17.** And the lesson is not "add `mcp-server/`":
>
> **A directory list written into a document is an instrument, and this one was wrong from its
> first hour while returning confident, controlled, correctly-formatted answers.** The controls
> were real. The enumeration was real. **The scope was the lie, and no control inside the scope
> can see it.**
>
> **Before the deletion commit, sweep the WHOLE TREE against the assembled branch** — not this
> list, not `cli/` and `src/`, and not `main`.

## THE CLOSING STEP — a procedure, not a caution

**The final sweep takes NO DIRECTORY ARGUMENT. Whole tree, tests included, positive control on
the zero. If it has a directory in it, it is not the final sweep.**

**This is written as a step because the warning above did not work.** I wrote that warning, then
made the same mistake three more times, the last one in the sweep whose entire purpose was to be
the final check — and reported *"the strip is done"* on the strength of it, with the chief about
to integrate. **A rule you wrote yourself does not fire when you are the one sweeping.**

The four, all one shape:

1. `mcp-server/` — outside this document's scope. **Two live callers.**
2. `bin/live-editor-acceptance.mjs` — a live caller behind a `*-test.mjs` naming convention.
3. `overleaf-sync-remote-provenance.test.mjs` — filed into the dies column **by its filename**,
   when reading it shows the old function appears once, as a *setup step*.
4. **The whole of `bin/`** — swept `server/`, `cli/`, `src/`, `mcp-server/` and called it clean.
   Four more test files were broken.

## A DEFERRAL HELD BY A PERSON IS LOST WHEN THAT PERSON'S ATTENTION MOVES

**Three of those four broken files were my "needs a decision" trio.** I told the implementer to
bring me the three and not to default. **Then I never took the decision, and the strip landed
around them.**

**Nothing in the tree says a decision is outstanding.** A missing file is visible; an open
deferral is not. **If it matters, it goes in this file — not in a chat message, not in someone's
head.**

## A DECODER THAT SWALLOWS ABSENCE TURNS DATA LOSS INTO A MERGE CONFLICT

**`source-room-daemon.mjs`'s `bufferFromBase64` is `Buffer.from(String(value || ''), 'base64')`.**
So a payload arriving with **no `content` decodes to `''` and does not throw.**

**That is why the empty fan-out surfaced as a conflict rather than naming itself.** The room
compared live text against an empty string, found a disagreement, and presented a person with
`<<<<<<<` markers against nothing. **A missing field became a semantic event.**

`incoming` has exactly one source (`:462`), so there is no second route to the bytes — established
end to end by `agent-0bai`, not inferred.

**General form, worth more than the instance: `String(value || '')` inside a decoder converts
"this field was never sent" into a valid empty value.** Every consumer downstream then behaves
correctly on data that does not exist. Look for it wherever a payload crosses a boundary and is
decoded rather than validated.

## FIFTH INSTANCE OF THE DIRECTORY-BOUNDED MISS: `test/`

**Four files were dead at import, not one.** Two of them were in `test/` — a directory that
appears in none of the sweeps above, including the whole-tree sweep I ran after writing the
closing-step rule, because I scoped that one to a branch and read its output for `bin/`.

**The closing step is unchanged and this is its fifth justification: no directory argument, tests
included, positive control on the zero.**

## TEST-SORT CORRECTION, SECOND ONE

**`project-parts-push-live-render` moves OUT of the dies column.** Its header is *"Skip's rule: a
file belongs to a project because something refers to it"* — the standing check applies and I
filed it wrong.

**And when it was repointed, three subtests failed — on `main` as well.** Verified by running both:
identical, same three passing, same three failing, same values. **Those failures are `main`'s and
were invisible until someone ran the file.** Repointing a test can expose a pre-existing failure
that has nothing to do with the change; check the base before attributing it.

## JUDGEMENT THAT IS NOT ELSEWHERE

**A gap closed on one path is not closed on the path that replaced it.** The fan-out-carries-no-
content gap is recorded as closed in the dossier and is **open on the branch**. Re-check a closed
gap against the replacement rather than against the record.

**When a test changes in the same commit as the code it guards, ask whether it now says MORE or
LESS.** More is a strengthened test; less is a repoint wearing one. Three tests changed tonight
and all three said more afterwards — that is the bar, and it is checkable in seconds.

**A repoint that preserves the old mechanism's shape can hide the defect the new mechanism has.**
The room-daemon test read the mutation off the accept's result. Repointing that mechanically
would have passed. **Registering the handler the way the server does is what surfaced the empty
fan-out** — the test had to be rewritten around the *production wiring*, not around its own
previous shape.

**A non-enumerable property does not survive a spread**, and nothing warns you. `projects.mjs:972`
attaches `acceptedSourceMutation` with `Object.defineProperty`. `{...body}` drops it, and the
assertion that fails is about text three lines away.

**A guarded dispatch makes a test HANG rather than fail.** The mutation dispatch sits inside
`if (targets.length)`. With no binding target, a test awaiting it waits forever — which reads as
a slow box, not as a wrong assumption.

**Measured on `main` (`6f6a18117`), enumerated rather than counted, tests excluded.** Control
run alongside: `dispatchBuild` → present, `zzz_absent` → 0. **Two of my earlier counts were
wrong because I aggregated instead of listing, so this is a list.**

This exists because three production callers turned out to be in nobody's column. Two more
are below. **If you own a track, your rows are here; if a row has no owner, say so.**

## Where the strip actually stands — measured 2026-08-19, controls clean

```
callers of the old push route (cli/ + src/ + mcp-server/, tests excluded)

  main                       18
  cli-json-carrier            5
  browser-callers-json       14
  route-probe-cn-fold         1     ← the assembled strip; the survivor is report-doc-post.mjs
  accept-path-daemon-push    18     ← the accept work; touches no callers
```

**`route-probe-cn-fold` is the assembled strip.** It is not two branches awaiting
reconciliation — it already carries the CLI migrations, the browser migrations, the source
editor's move off `PUT /source/:file`, and the MCP orchestration caller.

**`MathNoteShape.tsx` was deleted rather than migrated** — Skip ruled note file-sync out of
existence, so it is a removal, not a carrier change.

**`accept-path-daemon-push` is 3 ahead of the fold and 78 behind it.** The accept work and the
caller cutover have run in parallel all night and have never met. **They integrate for the first
time at the end, and §11's three-way merge is the most expensive place for that to be
discovered rather than planned.**

## THE DELETION MANIFEST — whole-tree sweep on `route-probe-cn-fold`, controls clean

**This is the sweep my scope error prevented all night. Run it again against the branch at the
moment the deletion commit is written, not from this list.**

```
DIES — all server/routes/projects.mjs unless noted

  :2298  router.post('/:name/push', …)            the route
  :2299  await processProjectPush(…)
  :1501  export async function processProjectPush
  :1546  export async function processProjectPushSerialized
  :814   router.put('/:name/source/:file', …)     the PUT handler
  :819   await processProjectPush(…)
         persistSnapshot's snapshot write

  server/unified-server.mjs:9740   the WS source-change handler   ← LAST, after the daemons
```

**Seven sites plus the snapshot write. That is the whole deletion.**

**Already done, do not re-derive:**

- **The room checkpoint is converted.** `source-room-daemon.mjs:130` now *throws* if handed
  `processProjectPush` and requires `acceptSourceSnapshot`.
- **Overleaf is migrated.** Both in-process callers from the original list are finished.

**The only live caller left on the fold is `mcp-server/report-doc-post.mjs:89`.** When it lands,
the count is zero and the deletion is unblocked.

**The WS handler is also, right now, the only thing that logs manifest-validation rejections at
all.** Deleting it early removes the only instrument on a live failure mode, on top of the
severed-wire risk.

### LANDED: Commit A — `d315293db` on `old-sync-deletion-land`, off the fold at `341a56b07`

**Verified independently, not taken from the report.**

```
GONE      router.post('/:name/push'              0
          router.put('/:name/source/:file'       0
SURVIVES  router.get('/:name/source/:file'       1
          processProjectPush / Serialized        present, as ruled

field drift across server/, fold vs commit A — zero on all six:
  deletedFiles 40/40  editOperation 12/12  editOperations 10/10
  deliveryId   30/30  sourceMachineId 4/4  sourceEnvName   3/3
```

**The route header block was updated in the same commit**, so no documentation survives
describing routes that no longer exist — the §13 trap avoided in the diff that creates it.

**`persistSnapshot`'s snapshot write was already gone.** It commits through `acceptRevision`;
nothing writes `revisions/<id>/snapshot.json` outside tests (`source-lifecycle.mjs:158`), and the
only surviving reference is a **read** at `:317` for pre-cutover revisions. **The item in this
document was stale and was reported as "nothing to delete" rather than satisfied by deleting
something.**

**A 20th caller was found and migrated in the same commit:** `bin/live-editor-acceptance.mjs`, a
live PUT caller **deliberately not named `-test.mjs`**, so every `*-test.mjs` sweep was blind to
it.

> **Two callers hidden by a directory scope, one by a filename convention. Three instances of one
> disease: a query correct within its bounds, where nothing inside the bounds can reveal that the
> bounds are wrong.**

**`assertPutRequiresCallerManifest` was split rather than deleted.** The route half died with the
route; **the client half is not about manifests at all** — it asserts the editor sends the
revision its buffer was loaded at and does not re-read authority before overwriting a loaded
buffer. **That is the three-deleted-passages guard.** Kept and renamed to say what it asserts.

**Test-sort correction:** `test/project-parts-push-live-render.test.mjs` quotes Skip at line 4 —
*"a file belongs to a project because something refers to it."* **By the standing check it moves
out of the dies column.** `source-transaction-snapshot-cost` is not on the fold at all.

### The deletion is TWO commits, and the second is not a repoint

**Commit A** — the `/push` route (`:2298`), the `PUT` handler (`:814`), `persistSnapshot`'s
snapshot write. **`processProjectPush`/`Serialized` stay this round.** Does not touch Skip's
path: his daemon sends `source-change` over the socket, not `POST /push`.

**Commit B** — repoint `unified-server.mjs:9740` onto the new accept, then delete both
functions. **Waits on `audit-2wk`'s live watch, which is measuring that exact handler.**

**`acceptSourceSnapshot` CANNOT stand in at `9740` as written.** Measured on the fold:

```js
processProjectPush   → FLAT       { status, lifecycleStatus, ok, error, sourceOperationResult, … }
acceptSourceSnapshot → NESTED     { status: 200, body: { ok: true, … } }
```

**The handler does `const { status: httpStatus, lifecycleStatus, ...payload } = result` and then
`status: … || (result.ok ? 'accepted' : 'error')`.** With the nested shape, `result.ok` is
`undefined` — it lives at `result.body.ok` — so **every successful accept is reported to the
daemon as `status: 'error'`**, on the socket path Skip's own daemon uses. Not a crash, not a
500: a green accept reported as a failure.

**~~Six of the thirteen fields the handler passes are not destructured by the accept.~~ WRONG —
and the correction is the more useful finding.**

**Five of the six ARE carried.** `acceptSourceSnapshot`'s destructure names only what the accept
uses *itself*; **the payload object is passed WHOLE to two consumers that read the rest
directly:**

```
projects.mjs:2505   acceptUnderOperationJournal(name, lifecycle, payload, …)
projects.mjs:2596   sourceConflictOwner(payload)

source-lifecycle.mjs:956,972   payload.deliveryId
projects.mjs:1119              payload.editOperation
source-sync-conflicts.mjs:5-6  sourceMachineId, sourceEnvName
```

**Gap 3 and gap 7 are already closed in the accept, and `projects.mjs:2585` says so** in a
comment written for exactly this reason: ***"Hand it the payload, do not enumerate."***

> **This is the reconstruction hazard read backwards.** Auditing a destructure list is the right
> instinct and here it produces a **false positive**. The rule that survives is unchanged: **do
> not rebuild the object.**

**So the requirement on commit B is "pass the body through," and that is the whole correctness
argument** — a later reader naming the fields explicitly "for clarity" reintroduces the bug.

**`deletedFiles` is the one genuinely open question**, and it is a property of **the sender**,
not the accept: does the daemon's `sourceManifest` already omit what it lists in `deletedFiles`?
**Carried or retired with the sender's behaviour as evidence — not the accept's comment.**

**THE REAL FINDING IS THE CRASH BOUNDARY, and the names map while the semantics do not:**

| old | new |
|---|---|
| `simulateCrashAfterTerminalResult` | `crashAt: 'after-terminal-result'` — direct |
| `simulateCrashAfterSourceMutation` | closest is `crashAt: 'after-accept'`, **not a synonym** |
| `crash: () => process.kill(pid, 'SIGKILL')` | **no equivalent — returns `{status: 599, simulatedCrash: true}`** |

**The old harness killed the process; the new one returns a marker.** A test asserting recovery
after real process death, repointed onto a return value, **does not fail — it passes while
testing something weaker.** `durable-source-acceptance` owes a decision about whether its window
is still its window. **Translate the names, state the gap in the commit message, do not silently
repoint a death test onto a return value.**

**And the crash boundary changes signature:** `processProjectPush(name, body, transactionTest)`
with `simulateCrashAfterSourceMutation` versus `acceptSourceSnapshot(name, payload, { crashAt })`.
`unified-server.mjs:9736` builds the old shape. **Repoint without translating and
`durable-source-acceptance`'s harness silently stops firing** — a test that passes because the
hook does nothing.

**This is the reconstruction hazard in its hardest form: an argument list rebuilt from named keys
between a producer and a consumer. Both ends contain every literal. Every grep succeeds.**

**I endorsed this repoint as "the wire stays, the implementation moves" before checking whether
the two functions were interchangeable.** The framing was right about the socket and wrong about
the swap. Seventeenth instrument, and mine.

## HTTP write callers — 17 as originally listed, 19 in fact

**None of these hold the project's git objects, so none can use the bundle POST.**

| # | site | shape | owner |
|---|---|---|---|
| 1–12 | `cli/tlda.mjs` 452, 557, 619, 685, 803, 860, 968, 1016, 1317, 1334, 1351, 2922 | five shapes (A–E) | `audit-2wk` |
| 13 | `cli/lib/dev-worktree.mjs:805` | bootstrap, `expectedRevision: null` | `audit-2wk` |
| 14 | `src/panels/TocTab.tsx:213` | create-then-seed, base64 | `read-one-grammar` |
| 15 | `src/shapes/FleetPillShape.tsx:204` | scratch overwrite, base64 | `read-one-grammar` |
| 16 | `src/shapes/MathNoteShape.tsx:464` | 1s-debounce continuous edit, utf8 | `read-one-grammar` |
| 17 | `src/shapes/FleetSourceEditorShape.tsx:884` | **the source editor — `PUT /source/:file`** | `read-one-grammar` |

`FleetSourceEditorShape.tsx:1398` is a **GET** and is not a write caller.

## In-process callers — 5, and two had no owner until now

| site | what it is | disposition |
|---|---|---|
| `server/routes/projects.mjs:735` | the `PUT /source/:file` handler | dies when caller 17 moves |
| `server/routes/projects.mjs:1854` | the `POST /push` handler | dies when 1–16 move |
| `server/lib/source-room-daemon.mjs:334` | room checkpoint, injected dep, called in `flushRoom` | `actual-versioning` — in-process, reaches the accept directly |
| `server/lib/overleaf-sync.mjs:520` | **Overleaf remote pull** — applies a remote's changes | **was unowned** → `actual-versioning` |
| `server/unified-server.mjs:9740` | **the WS `source-change` handler** — the server end of the old socket path | **was unowned** → see ordering below |

## The ordering constraint nobody has stated yet

`unified-server.mjs:9740` is the **receiving end of what the daemon cutover just stopped
sending**. The comment above it says so: *"Hand off to the same pipeline used by HTTP
/api/projects/:name/push."*

**It must not be deleted before every daemon runs the new code.** A daemon still on the old
build sends `source-change` over the socket; delete the handler and that message is accepted
and silently does nothing — the exact severed-wire-reports-health failure this repo has
shipped three times. **It is the last thing to go, after the daemons, not with the route.**

Its crash-boundary test hooks (`TLDA_TEST_SOURCE_CRASH_BOUNDARY`) are the durability
harness for `durable-source-acceptance`, which is a **move**, not a die — so whatever
replaces this path still owes those boundaries.

## Overleaf is a carrier question, not a caller question

`overleaf-sync.mjs:520` is not a person pushing. It is a **remote's** changes arriving, with
`nonRemotePaths` deliberately preserving content the sync neither introduced nor may remove.
That invariant is `overleaf-sync-remote-provenance`'s "Bregman shape" — a **move**.

It runs in-process with the lifecycle store to hand, so like the room checkpoint it does not
need an HTTP carrier at all. **But it is the one caller whose correctness is about what it
must NOT touch**, so its repoint is the one where a mechanical swap is most likely to drop a
guarantee quietly.

## Standing check

**Before the deletion commit, re-run this sweep on `main` at that moment**, with the control.
Three callers were invisible to the plan for the first two hours of this work; the cost of
finding a fourth in the diff is Skip's paper.

---

# Added 2026-08-19 by agent-0bai, during the fan-out fix

## 1. A warning comment deleted with the code it guarded

`297baba9a` ("Send the words in the fan-out", `accept-path-daemon-push`, 2026-08-18 20:01)
fixed the source-room fan-out carrying paths without bytes, and wrote a twelve-line comment
above the fix saying exactly why the payload must carry `content`: **two consumers, and only
one of them reads `blobs`.**

The old-sync strip rewrote that block on its own branch. The comment went with the code, so
nothing on the strip said not to do it — and the same defect was written again and found a
second time, independently, hours later.

**The rule:** a comment that exists to stop someone re-introducing a defect is load-bearing.
When you rewrite the block it guards, the comment moves with the rewrite or the guard is
gone. A diffstat that deletes an explanatory block and adds no replacement is the tell.

Same family as `AGENTS.md` §"A revert is not done until the control goes too".

## 2. A verification command must be run against a known-good subject before it is trusted

Handed over as the check for whether the fan-out fix had landed:

```sh
git show <branch>:server/routes/projects.mjs | grep -A6 acceptedSourceMutationHandler | grep -c content
```

It returned **0** on the branch where the fix had just landed — and **0 on
`accept-path-daemon-push`, which carries `297baba9a` and is indisputably fixed.** The fix
builds `changedFiles` about forty lines above the payload and passes the variable, so
`grep -A6` cannot see it. The command could not have returned anything else on any correct
branch.

**The rule:** before trusting a check, run it against a subject you already know satisfies
it. If the known-good subject fails the check, the instrument is broken, not the world.
This is `pm-sync`'s positive-control-on-the-zero rule pointed at the checker rather than at
the code — and it is the same disease as the bug it was checking for: a grep that finds the
field name on both ends and tells you nothing.

The instrument that does answer it:

```sh
git show <branch>:server/routes/projects.mjs | grep -n "changedFiles\|files: changed.map"
```

## 3. `applyAcceptedBundleEffects` — a deferral to a symbol that exists nowhere

`bin/source-manifest-contract-test.mjs`'s header defers its own re-derivation until
*"`applyAcceptedBundleEffects` (accept-path-daemon-push) lands on `main`"*.

**That symbol does not exist.** Not on `main`, not on `accept-path-daemon-push`, not on
`old-sync-deletion-land`. Its only occurrence in 1414 tracked files is the sentence
deferring to it. It was never built, or it was renamed in transit and the header was not.

Anyone who reads that header waits forever, and reads the file's silence as *not yet due*
rather than *not running at all*. **Not guessed at — whoever knows what it became should
write the name in here.**

---

# Standing checks this run added

- **A sweep takes no directory argument.** Whole tree, tests included. Four scope misses on
  2026-08-18 and a fifth on 2026-08-19 were all directory-bounded sweeps. The fifth found two
  dead files in `test/` that four separate `bin/`-bounded sweeps had never looked at.
- **Both controls, every run.** A positive control proving the instrument finds what exists,
  and a negative control proving a zero is reachable. A clean sweep means the negative
  control still returns zero — otherwise the instrument may have broken silently between
  runs and "clean" means "blind".
- **Run the file, do not classify it.** Whether a file dies at import is answered by running
  it. A regex over its imports is a guess that agrees with the truth often enough to be
  trusted wrongly.

# Red on `main` and invisible, found by this sweep

Not strip damage. These were already failing where nobody was looking:

- **`bin/source-room-daemon-test.mjs`** errors at its corrupt-revision block — it edits
  `revisions/<id>/snapshot.json`, and `source-lifecycle.mjs:308` says *"Nothing writes that
  shape any more."* It throws ENOENT rather than failing, so **everything after that block
  has never run on `main`**, including a `duplicate-render` block that turns out to be
  intermittently failing. Repointed on `old-sync-deletion-land`; still open on `main`.
- **`test/project-parts-push-live-render.test.mjs`** — three of six subtests fail
  **identically on `main` and on the branch**, including *"a chat reference makes a file a
  member; sitting beside the paper does not"*. That is Skip's membership rule. The file was
  dead at import on the branch, so the repoint did not cause it; the failures are `main`'s.
- **`test/linked-remote-divergence.test.mjs`** cannot reach its assertions on `main` at all
  (fails in setup), so `main`'s behaviour on those promises is currently unestablished.

## 4. `shared/tex-deps.mjs` — a comment-only husk left by a revert

```
non-comment, non-blank lines:   0
exports:                        0
files importing it:             0   (only itself)

e9c3ba890  Revert "Make LaTeX membership the closure of the document's roots"
22fb6182b  Make LaTeX membership the closure of the document's roots
```

The LaTeX closure was built and reverted, and **the revert left 152 lines of prose behind.**
The file reads exactly like a live module — it opens *"the SHARED LaTeX dependency
detector"* — so it is a natural place to send someone, and on 2026-08-19 it sent the chief
and then me. Positive control on that zero: its own header names
`shared/markdown-deps.mjs` as its counterpart, and that one has 4 exports and 14 importers.

**Not deleted, deliberately.** It is the written argument for why LaTeX membership should be
a closure, and **LaTeX still does not have one** — membership there is a directory walk plus
an extension test, which is the state the husk's header complains about. Skip's rule that a
file belongs to a project because something refers to it is implemented for Markdown and not
for LaTeX, which is most of his papers. That is a live design gap, recorded here rather than
silently tidied away.

Same family as entries 1–3: an instruction pointing at something that is not there. This one
is the inverse of entry 1 — there the code moved and the comment stayed as a *warning*; here
the code went and the comment stayed as a *description*, which is worse, because a
description of a thing that does not exist reads as documentation of a thing that does.
