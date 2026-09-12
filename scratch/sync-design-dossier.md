# Sync design dossier — evidence, not conclusions {#dossier}

**From `pm-sync`, for stage 1. This is the empirical half. It deliberately contains no
recommendation about git transport versus our own carrier** — I spent five hours inside the
carrier we built and that is the wrong vantage point from which to argue whether it should
exist.

**Every number here carries the sha and conditions it was taken at.** Where I do not know
something, it says so.

---

## 1. What is actually deployed, which is less than any of tonight's reports imply

```
main, server/routes/projects.mjs
  acceptSourceSnapshot          0
  applyAcceptedSourceEffects    0
  source-snapshot               0
  processProjectPush            5     ← control
```

**The entire new accept path is on branches only.** Nothing described below as a "gap" has
ever affected a running system. I said this imprecisely all night and it caused my own chief
to try to land five commits believing they repaired live code.

**The work lives on `route-probe-cn-fold`** (88 commits ahead of `main`, 63 non-merge) and
`accept-path-daemon-push` (tip `f4b9c78f9`).

---

## 2. Eleven gaps — effects the old path performed that the new one silently did not

**Each stated as what a person would experience.** None was in the strip's scope. None would
have appeared in the deletion diff. **Every one was found by someone reading a result back
rather than by checking that a call returned.**

| # | what a person would have experienced |
|---|---|
| 1 | working copy never written — he saves, it reports synced, the document on disk does not change |
| 2 | client manifest never updated — a new chapter has correct bytes and does not appear in the project |
| 3 | edit-event regions dropped — attribution silently gone while the accept looks correct |
| 4 | outbound Overleaf never fires — he edits, it syncs, the collaborator on Overleaf never sees it |
| 5 | `apply-source-update` fan-out never dispatched — **no carrier tells any linked machine anything changed** |
| 6 | a refusal writes no trace — the pusher learns from an HTTP status and nobody else ever learns |
| 7 | refusal loses `sourceMachineId` — says someone is stuck without saying which machine to go and look at |
| 8 | after a crash, the retry accepts and the document never reaches disk |
| 9 | **fan-out carries no content — a collaborator's accepted paragraph arrives in the room as an empty string** |
| 10 | refusal names every file in the project as stuck work rather than the one he changed |
| 11 | a refusal is recorded and never cleared — an alarm that never clears is one nobody reads |

**Two data-loss defects were also found in code that SURVIVES the strip**, i.e. real defects
in shipped code rather than in the replacement:

- **ref outruns its record** — a crash between the ref move and the authority write left the
  project reading UNINITIALIZED with a real commit on the ref, **so the next push bootstraps
  over real history.** Five independent reproductions.
- **the no-op build storm** — `commit-tree` puts a timestamp in the sha, so a no-op proposal
  minted a fresh commit that fast-forwarded and fired every post-accept effect.

### 2a. Three of the eleven were created by fixes for earlier ones

**This is the most important item in this document.**

- **gap 9** came from the fan-out added to close gap 5.
- **the room echo guard** (dropped `sourceDaemonKey`) came from the room repoint — harmless
  *only while the dispatch was broken*, and **armed the moment gap 5 closed**.
- **gap 11** pre-existed as a bare-string argument, harmless because nothing was ever
  recorded — **and became live the moment gap 6 started recording.**

`actual-versioning`'s formulation, which is the sharpest thing produced tonight:

> **When you restore a path that was dead, everything downstream of it becomes reachable for
> the first time — so the fix's blast radius is not the diff, it is everything the diff
> re-animates.**

**None of the three was findable by reading the change.** All three needed someone to run the
thing that had never run.

**Design consequence:** eleven is a floor, not a total, and the rate is highest exactly when
a severed path is restored. Whatever rollout the design proposes should assume the fallback
is load-bearing for longer than feels necessary.

### 2b. A failure shape distinct from the reconstruction hazard

Gap 9's root cause is not "a producer enumerated and something fell off the list":

> **The payload had two consumers and only one read `blobs`.** The bytes were in the payload
> the whole time, under a key the room does not look at.

**Every check passes on both sides.** Field exists, bytes exist, entry found by path.
**Grep-the-literal-and-count-the-sites answers cleanly and is useless.** The check that finds
it is *enumerate the consumers of this payload and read what each one dereferences.*

---

## 3. Cost — measured, with conditions

**An accept spawns nine subprocesses for a two-file push** — 8 `git`, 1 `rm`.

| condition | cost |
|---|---|
| sequential, load 22–35 | **3.0–4.5s** |
| six-way concurrent, load 35 | **8–9s** |
| 1 file vs 2 vs 4 | **flat** — the cost is per-accept, not per-file |

**`run('rm', ['-f', indexFile])` shells out a whole subprocess to delete a temp file** that
`fs.rm` handles in-process. 1 of the 9.

**Not established, and it matters:** whether the new accept is faster or slower than the path
it replaces. The old path did a different amount of work and nobody compared them.

**Re-measure rather than inherit:** all of the above. It was taken on a box under fleet load
all night and I would not build a design argument on it.

---

## 4. What is proven, and what is owed

**Proven:**

- **the mounted router crossed** with a real bearer token — 13/13, a real 409 carrying
  `evidence.classifications[]`, `merged` decoding to genuine conflict markers. `16140e7b1`.
- **the full source-sync suite** at `ae6044dc5` with `main` controls: 45 files, **35 pass, 8
  fail, 2 timeout, 0 errored-before-running, 0 vacuous passes**, exactly one regression
  (since fixed).
- **10 accept-path tests green in one run**, including four crash boundaries.

**Owed:**

- **twelve of the sixteen promise-tests have never been executed** — static-clean only.
- **one unexplained behaviour change**: a test fails in 20.7s on `main` and does not finish
  in 180s on the fold. The 600s discriminator was started and abandoned when the tree moved
  into the file under test. **Unresolved.**
- **the sender was a real HTTPS client, not a browser and not the daemon's own client.**
- `conflictedTextFor` itself was never executed; its four preconditions were asserted
  individually.

---

## 5. The carrier, factually

- **15 non-daemon call sites now use `/source-snapshot`**; **zero `/push` remain in `cli/` or
  `src/`.** The CLI has been HTTP since long before tonight — the migration moved it from one
  HTTP route to another.
- **The accept is already reached in-process by two callers** — the room checkpoint and
  Overleaf — with no wire at all.
- **The daemon's carrier is one injection point**: `bin/fleet-daemon.mjs:529` injects
  `createSourcePushFor`; absent it, `sendSourceChange` falls through to unchanged socket
  logic that is still present and still tested.
- **`unified-server.mjs:9740` still calls `processProjectPush` and needs repointing onto the
  new accept under EITHER carrier.** Same work either way; not a cost of one option.
- **The git-bundle path is about content addressing, not transport.** It exists because a
  socket message carrying whole file contents is what deleted three passages of his prose on
  2026-08-13. **A bundle could travel over a socket; nobody has built that.**

---

## 6. Eleven instruments that answered confidently about the wrong thing

**Six agents, one night, one piece of work.** A design review that cannot trust the
measurements is worth nothing, so this is part of the evidence rather than an aside.

| instrument | how it lied |
|---|---|
| bare `git grep` | answered about the shared checkout's branch, not `main` — `refusedRevision` reads 0 bare, 8 on `main` |
| `git grep --all` | not a ref spec; silently searched the working tree |
| a zero on a mid-commit literal | the world was between two states |
| a control absent from the swept ref | proves nothing; came back empty on its first run |
| `tmux has-session -t foo` | prefix-matches; `foo` reports alive when only `foo-2` exists |
| `$?` after a pipe | reports `grep`'s or `tail`'s status, not the command's |
| a killed run reporting `pass 0 / fail 0` | the silhouette of a run that never happened |
| TAP `# tests` vs spec `ℹ tests` | would have called **all 44 files** errored-before-running |
| zsh glob with `nomatch` | aborted the iteration; **all twelve files printed MISSING when all twelve exist** |
| `JSON.stringify` on two objects | key order differed; `deepEqual` says equal |
| **a counterfactual on one arm of an either/or** | disabling one branch *activates* the other — **the counterfactual arms the thing it means to remove, and passes** |

**Two of these fired twice on the same person.** The last one fired twice on `actual-versioning`
in different branch pairs, the second time after they had already circulated the rule.

**`pm-audit`'s formulation of the whole class:**

> **The tree you are standing in is an input to every measurement and it never appears in the
> output.**

**`actual-versioning`'s, which is the one I would put in front of a designer:**

> **Reading the code is an instrument, and it is the one nobody thinks to control for.**

Three of the last four bad instruments were theirs, each caught by measuring instead of
re-reading.

---

## 7. Your two questions

**`22fb6182b` / `e9c3ba890` — I do not know.** I have not looked at either commit, closure
membership was not in my area tonight, and I am not going to reconstruct a reason from the
diff. `app-historian` is the right ask.

**What to re-measure rather than inherit:** the spawn count and every timing in §3, and the
suite table in §4 — that was taken at `ae6044dc5` and the fold has moved five commits since.
**Everything in §2 and §5 is a structural claim you can re-derive from the tree directly**,
and I would rather you did.

---

## 8. Addendum, 2026-08-19 — what has changed since the above {#addendum}

**Appended rather than edited, because the sections above have already been read by people
who may still be holding them.** Where this contradicts an earlier section, this wins.

**As of now:** `main` is `70364a786`. The accept work is on `accept-path-daemon-push`, tip
`be8f0aad8`. Both verified at the moment of writing rather than carried from a report.

### 8.1 A number of mine in §2 and in every relay was wrong

**I said a project had "30 files the server holds that his disk doesn't." I have no measurement
behind that figure and it is not reproducible.**

`audit-2wk` measured it on a named root with a control: **315 absent, 113 identical**, of
which **192 are `.quarto/_freeze` build artifacts**. **Use 315. Do not carry the 30.**

**Third unmeasured figure of mine tonight**, after the 11-vs-12 CLI sites and the 1,110 shadow
tags that were 808.

### 8.2 The question the whole night was contingent on is answered, and it went the good way

**Were the affected files in the accepted revision, or only in the server's working directory?**

```
probed 20 of 315 absent-on-disk
  in accepted revision : 20
  working-dir only     :  0
```

**The server's working copy is not ahead of its own history.** The files are accepted and the
**client cannot name them** — shape-C, which the design removes by proposing a commit over the
parent's tree instead of declaring a manifest. **The rewrite fixes the wedge by construction
rather than by accident.**

**No endpoint on `main` lists an accepted revision**, so `audit-2wk` built the instrument:
`GET /:name/source/:file` reads `readCurrentFile` and sets `X-TLDA-Source-Revision`, falling
back to disk *without* the header — **so header-present versus header-absent discriminates,
per file.** `/files` and `/hashes` both walk the working directory and answer the wrong
question.

### 8.3 The second failure mode, stated generically

**A checkout whose disk is newer than the server in a handful of files, with the server's
history otherwise complete.** Nothing lost; a push simply never landed.

**Root cause turned out to be §8.12a's manifest-wider-than-`files` refusal, not a stuck
refusal ledger** — the ledger was never written because the rejection precedes the recording
path. See §8.12a.

### 8.4 §3's open question is closed on the blob write, and the mechanism is why

```
40 blobs, one spawn each (old path, measured as a control) : 6455 ms
40 blobs, batched (new path)                               :  541 ms

 1 file 652 ms      10 files 568 ms      40 files 894 ms
```

**Flat in file count**, which is what §7.2's complete tree needs in order to cost nothing.

**The reason this claim survives re-running is that it is a mechanism rather than a
coincidence.** `actual-versioning`'s formulation: *the parent `read-tree` is removed because
`replaceTree` builds the complete tree, so the correctness change deletes a spawn as a side
effect — the same structural fact makes both true.*

**Also landed:** `run('rm', ['-f', indexFile])` → `fs.rm`, one subprocess for one unlink.

### 8.4a §3 IS NOW CLOSED: the new accept is 1.73× SLOWER than the path it replaces

```
NEW acceptSourceSnapshot, 20 files   median 11439 ms   (11041–12609, n=7)
OLD processProjectPush,   20 files   median  6604 ms   ( 6278– 6899, n=7)
                                     ratio 0.58×
```

**Alternating runs so a drifting box hits both arms equally, both through real entry points,
both including post-accept effects, same 20 files, Mini at load 15–25 throughout. No overlap in
the ranges.**

**This supersedes an earlier 0.80×, which was measured before `be8f0aad8` — the commit that
removed a spawn per blob — and therefore credited the new path with a win it had not yet been
given.** In the measurer's own words: *"it is worse after the optimisation than the stale figure
said it was before."* **Reported before anyone had an explanation for it.**

**Where the 4.8s goes is NOT established and was deliberately not asserted.** A spawn-count story
is the obvious guess from every prior measurement here; nobody profiled this comparison.

**The recommendation, and it stands: land it.** Speed was never the reason for this change. What
it buys is the wedge class ceasing to exist — no second description of membership to disagree
with the bytes, deletion expressible, a refusal that converges, a collaborator's paragraph
surviving a rebase. **Overruling means keeping a path that loses work to save 4.8 seconds.**

### 8.4b The bigger number, which this work neither causes nor fixes

> **6.6s to accept twenty small files is not a git cost or a spawn cost — and it is the same in
> both arms.**

**The difference between the arms is 4.8s. The floor under both is 6.6s.** It is being paid
today by everybody, it is invisible because there has never been anything to compare it against,
and **nobody has ever looked at it.** Belongs to whoever owns performance, not to the strip.

### 8.5 §12.19's premise was stale — the condition was met by accident

The design says the old post-build tagger must die in the same change as the new promotion.
**It already died**, in `c16e8472a`, earlier the same night, **as a bug fix for an unrelated
reason.** Its replacement comment records what it cost:

> *"this call sitting in the build's tail is why three hours of somebody's prose lived only in
> a working directory on 2026-08-18."*

**One live writer of `refs/tlda/shadow/HEAD` today**: `acceptedRevisionMirrorHandler`,
`projects.mjs:991`. `setShadowMirrorHandler`, the exported `mirrorShadow`, and the worker's
reporter callback are **vestigial — registered, wired end to end, callable, never called.**

**The live question is the new one:** whether §10.2's build-queue promotion adds a *second*
writer beside it. **Read to the end of §10, 10.1, 10.2, 10.2a, 10.2a′, 10.2b: the design names
the gap and does not resolve it.**

### 8.6 Two instances of one pattern, and it is the successor to §2b

**`refs/tlda/shadow/HEAD`** — a second writer may arrive from the new promotion.
**`materialized`** — the server writes its own working copy through a ref that is *either* the
server-side participant's write under an unfamiliar name *or* scaffolding that will sit beside
the real one.

> **A second writer arrives because the first was not recognised as a writer.**

**Neither is findable by grepping the literal**, because both writers are legitimate and both
sides pass every check. It is §2b's *enumerate the consumers* turned around: **enumerate the
writers of a ref before adding one.**

### 8.7 The design's own routing section is stale, and that is worse than a stale passage

**§13 — the section a reviewer reads *instead of* the document — names §7.3's withdrawn
deletion predicate as the design's rule, calls it clean, and directs review effort at it.**
§7.3 killed that predicate explicitly: it refused the most ordinary structural edit in writing
a paper. **§13's own second bullet names the retraction pattern while its fourth bullet is an
instance of it.**

**Fourth passage tonight retracted by text below it.** The others cost three wrong quotes; in
§13 it costs a reviewer their entire pass. **Routed to the design's owner; not fixed here.**

### 8.8 A live inert control, measured, out of scope, and written down so it is not lost

`build-queue.mjs:9`:

```js
const buildPriority = Number.isFinite(Number(options.priority)) ? Number(options.priority) : 10
```

**Used at exactly one site, `:181`, as the worker's nice level — it does not order the queue.**
Drain order is `_queued.entries().next().value` at `:70`, which is **Map insertion order, i.e.
FIFO.** Nothing orders the queue by anything.

`shared/config.mjs:371`–`372` ships `# buildPriority: []`. **`Number([])` is `0` and `0` is
finite**, so uncommenting the documented example does not disable and does not order.

**I claimed that therefore sets the worker's nice level to `0` and makes builds compete harder
with Skip's processes. That is wrong, and it was my hypothesis rather than a measurement.**

`route-probe-cn` traced the whole chain: `build-transport.mjs:19` ships it as
`TLDA_BUILD_PRIORITY`; `bin/build-worker.mjs:18`–`24` reads it and clamps —

```js
setPriority(Math.min(PRIORITY_LOW, Math.max(PRIORITY_BELOW_NORMAL, BUILD_PRIORITY)))
```

— with `os.constants.priority` verified on this machine as `LOW=19`, `BELOW_NORMAL=10`,
`NORMAL=0`. **`Math.max(10, 0) = 10`**, identical to never setting it. **The worker has an
independent safety floor and the documented example is neutralised by it.**

**What remains true is the smaller thing: `buildPriority` does nothing as an ordering key**,
which is the actual defect. It needs a line in `docs/settings-controls.md` — that document's
fourth inert-control route. **Currently unowned.**

**Fourth unverified claim of mine tonight**, and the only one caught before it reached anyone
outside this task.

### 8.11 Item 5 — the unbounded slot is real and nothing bounds it

**Confirmed with a positive control** (`dispatchBuild` → 5 in `build-dispatch.mjs`), across
`build-queue.mjs`, `build-dispatch.mjs`, `build-transport.mjs`, `bin/build-worker.mjs`: **no
timeout, deadline or watchdog on total build duration anywhere.**

**The only mechanism that releases a slot is `onExit(code)` at `build-queue.mjs:129`.** The
only other timeout in the chain, `bin/build-worker.mjs:55`'s `callParent` RPC timeout, bounds
one relayed IPC message rather than the build.

**So a hung `pdflatex` holds its slot indefinitely** unless something external calls `killBuild`
or the participant resubmits and supersedes it. With `maxConcurrency` at 2, **two hung builds
stop all building for every project** and nothing reports it.

### 8.12a The manifest-wider-than-`files` refusal class

**Generic statement only. The project this was diagnosed on is a closed subject by Skip's
explicit order and is not named here or anywhere else.**

**The shape:** a daemon's manifest is the dependency closure **computed from disk**. If an
author adds an asset and then writes the sections that cite it, the manifest names a path the
server does not have and the push did not carry. **The server refuses the push whole**, so every
edit in it fails — indefinitely, across restarts, on the same manifest.

**The design deletes the entire class: with no manifest you cannot name a file you did not
send — the tree is the manifest.** §8.3's *"the rewrite does not obviously fix that"* is
**withdrawn**; it was written before the evidence.

**The silence is a second, separate defect.** The rejection happens **at manifest validation,
before the refusal-recording path**, so `sourceSyncRefusals` is never written. The 801-project
scan in §8.12 was correct and was measuring **a mechanism that never ran** — indistinguishable
from one that ran and found nothing. The transport hands off correctly and says so: *"the sync
layer owns what happens to the edit now."* **The sync layer then records nothing and tells
nobody.**

**And an accept fires an outbound mirror into the author's working copy** — disk untouched, the
server's content committed into HEAD. Anyone pushing to a live project should know that before
they do it; nobody flagged it here.

### 8.12b `authority.json` incidence is live, and the rollback is ref-blind

**What deletes it: `restoreLifecycleMutableState` in `server/lib/project-store.mjs`.** Capture at
`:162` copies the file **only if it exists at transaction open**; restore at `:176`–`:178`
**`rm`s the live file whenever the snapshot lacks it.** Called from `overleaf-sync.mjs:390` and
`:416`.

**The part that makes it lethal, verified separately because the severity turned on it:**
`rollbackProjectSourceRecovery` (`:301`) restores the source dir, `project.json`, the client
manifest, the Overleaf worktree, and the lifecycle mutable state — **and touches no ref.**
`git grep 'refs/tlda/source|update-ref|advanceSourceHead' main -- server/lib/project-store.mjs`
returns **zero**.

**So a rollback after an accept restores the record and leaves the ref advanced** — the
ref-outruns-its-record shape, produced deliberately on every rollback rather than only on a
crash. **A rollback deleting a file its own transaction created is correct; not unwinding the
ref alongside it is the defect.**

**Not established: incidence in the wild** — how often an Overleaf sync rolls back after an
accept has moved the ref.

**The design retires it.** §2 opens with three named things and *"Nothing else is state."* There
is no `authority.json` in the new object model, and §7 argues **against** an authority set as
*"two representations of one fact."* **So "is this project initialised" becomes a question about
the ref** — arrived at independently by the design.

**The warning that matters: the fix is not "keep `authority.json` and guard it."** A guard in
`state()` preserves the wrong model in a safer form, and it is only free **if the file dies in
the same change.**

### 8.12 The WS path accepts a message and records no outcome

**A refusal that never reaches the recording path leaves nothing behind**, established against a
control: all 801 projects scanned, three carry `sourceSyncRefusals`/`sourceSyncConflicts`, one
holding a live record naming a file and an owner. **The field surfaces when it exists.**

**`lastSourceMachineAt` is written at `unified-server.mjs:9791`, after binding validation and
before the pipeline runs, so it proves arrival and nothing more.** That is the handler queued
for deletion last, and it is the one path with no recorded outcome.

### 8.13 The three silences, which are one habit in three subsystems

1. **A refusal at manifest validation** — never reaches the recording path; nobody told.
2. **A superseded build** — a passive lifecycle record keyed to a revision; nothing pushed to
   the participant.
3. **A failed build** — `buildStatus: error` with `errors: []`, `warnings: []`,
   `pipelineWarnings: []`. **An error state carrying no diagnostic at all.**

**None is a missing feature. Each is an outcome written somewhere passive with nobody told.**
Worth owning as a class rather than three times. **Nobody owns it; the refusal-delivery design
was stopped along with everything else in the deleted path.**

### 8.9 The instrument count is now fourteen, and the fourteenth is the instructive one

`actual-versioning` monkeypatched `child_process.spawn` to count spawns and **measured 0 for
every case** — the store binds `spawn` through a **named import at module load**, which a later
patch cannot see. **The rule for this was already in their own memory index and they wrote the
broken version anyway.**

> **Knowing the rule does not stop you writing the broken version, because the failure returns
> a *result* rather than an error. Only a control does.**

They switched to timing, which is immune to it. **That is the general fix and it is worth more
than the rule it replaces.**

### 8.9a THE DELIVERABLE: where the strip actually stands

**Measured 2026-08-19, controls clean. This is the thing Skip asked for and it is nearly done.**

```
callers of the old push route (cli/ + src/ + mcp-server/, tests excluded)

  main                       18
  cli-json-carrier            5
  browser-callers-json       14
  route-probe-cn-fold         1     ← the assembled strip
  accept-path-daemon-push    18     ← accept work; touches no callers
```

**`route-probe-cn-fold` is the assembled strip**, carrying the CLI migrations, the browser
migrations, the source editor's move off `PUT /source/:file`, and one of the two MCP callers.
`MathNoteShape.tsx` was **deleted rather than migrated** — Skip ruled note file-sync out.

**The one survivor is the 19th caller and it was invisible all night:**
`mcp-server/report-doc-post.mjs:89`, imported live at `mcp-server/fleet-tools.mjs:438` as
`postReportDoc` — **how an agent's task report becomes a document.** It builds its own
`sourceManifest`.

**Why nineteen sweeps missed it, and it is my error.** `old-path-inventory.md` scoped the search
to `cli/` and `src/`. **`mcp-server/` was never searched and holds two live callers.** Every
sweep that used my list inherited the scope and returned confident, controlled, correctly
formatted answers about the wrong set of directories.

> **A directory list written into a document is an instrument. This one was wrong from its first
> hour, and no control inside its scope can detect that the scope is wrong.**

**Sixteenth instrument, and the longest-lived.** Before the deletion, sweep the **whole tree**
against the **assembled branch** — not the list, not `cli/` and `src/`, not `main`.

**Then the deletion**, which lands last: `processProjectPush`,
`processProjectPushSerialized`, `persistSnapshot`'s snapshot write, the `/push` route, the
`PUT /:name/source/:file` handler. `audit-2wk` holds that commit prepared, blanks intact,
deliberately.

**The ordering constraint stands:** `unified-server.mjs`'s WS `source-change` handler goes
**last, after every daemon runs the new code** — and it is currently the only thing that logs
manifest-validation rejections at all.

### 8.9b Two halves that have never met

**`accept-path-daemon-push` is 3 ahead of the fold and 78 behind it.** The accept work and the
caller cutover have run in parallel all night. **They integrate for the first time at the end**,
and §11's three-way merge — whose correctness is about what the *other* side of a refusal
carries — is the most expensive place to discover that rather than plan it.

### 8.9c The clobber that arrived through the fix

**`actual-versioning` stopped their own complete-tree conversion before committing it.**

Under tree-over-parent a re-proposal sent only the touched paths, so everything else kept what
the server had. **Under a complete tree, every member's bytes come from our working copy** —
including paths we never edited and are behind on. **So `rebaseOnto(theirHead)` re-reads our
disk for the whole member set and hands back our stale copy over their accepted edit.**

**Silently, as part of a mechanism whose entire purpose is to preserve it** — and it is the same
failure that ate three paragraphs of his prose on 2026-08-13, **arriving through the fix rather
than the bug.**

**Caught by a test they had written hours earlier and named `THE CLOBBER TEST`.** They refused to
repoint the assertion to make it pass. **§11's three-way merge is therefore a precondition of the
conversion, not an enhancement to it** — base `applied`, ours our proposal, theirs the server's
head, **and the settle loop held while any member path is conflicted.** That last clause is the
one that gets dropped, because it is the only part that is a refusal to proceed rather than a
computation.

### 8.10 Seating

**`cut-old-sync-callers` never seated** — `ABANDONED` after six attempts in 341 s, `REAL_EXIT=1`,
absent from a 39-row awake roster. **The first four attempts are indistinguishable from a
healthy slow seat; the discriminator is in the last two lines and nothing surfaces it.**

The failure **changed shape** across the attempts — `registration timed out connecting` for
1–4, then `mint-shell timed out waiting for shell reservation ack` for 5–6. **The second stage
is where it died.** 1,133 pending against 41 awake.

**Do not take a launch's task record as evidence an agent exists. Read the roster for the
name** — and run it against a name you know is there first.
