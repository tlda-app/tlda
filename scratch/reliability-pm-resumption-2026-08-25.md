# reliability-pm resumption, 2026-08-25 ~08:00Z

Force-added because it is a **resumption point, not a report** — the next
session works *from* this, and `scratch/` is gitignored. See `AGENTS.md`
§"Repository workflow".

The design is in `docs/the-sync-model.md`, which is tracked and is the thing to
read first. This file is only what is *not* in the code or the commits.

## READ THIS BEFORE RELINKING ANYTHING

**Relinking a project created after the branch rename, on a box without
`369b49260`, is REFUSED — not repaired.** It will look like the fix does not
work. It is the fix being partial, and `369b49260` completes it.

`bhief-4` has a hold on relinking anything, `pic` included, until that sha is
serving. **Check before you lift it:**

```sh
curl -sk https://tlda-fly.cormorant-matrix.ts.net/api/build-info
git merge-base --is-ancestor 369b49260 <that gitSha> && echo SAFE TO RELINK
```

**How to tell the two kinds of project apart**, in any checkout:

```sh
git rev-parse --verify refs/tlda/project/<project>   # the old chain ref
git log -1 --format=%s refs/heads/tlda/<project>     # what the branch holds
```

| chain ref | branch tip subject | which kind | migrates before `369b49260`? |
|---|---|---|---|
| present | `tlda project revision` | linked BEFORE the rename | **yes** |
| absent | `tlda project revision` | linked AFTER the rename | **no — refused** |
| either | `tlda settled edit cluster` | already repaired | nothing to do |

The second row is most recently-created projects. That is why "we'll relink as
necessary" was broken for the majority case.

## THE NEXT THING TO FIX: two ingress chains, and the loser can never push again

**Found 2026-08-25 08:2x, immediately after the browser leg worked for the first
time. This is the most important open item in this file.**

A project has **two independent revision chains**, and they carry the same ref
name in different repositories:

```
the person's checkout          refs/tlda/project/<p>   6c549b1c2
.source-room/working (server)  refs/tlda/project/<p>   98b975e37  <- IS the server head
neither is an ancestor of the other
```

Both measured — the second by reading the refs inside
`/app/server/persist/projects/<p>/.source-room/working` on the box.

The server's pre-receive requires a proposal to descend from the project head.
So once **both** ingresses have submitted, whichever submitted last owns the
head and **the other one's every future push is `WrongHead`, permanently.**
`headChanged` fetches but only reparents an **app-owned** tree — a person's
checkout is deliberately not reparented — and nothing merges the fetched head
into the checkout's chain. **It cannot recover on its own.**

Reproduced: after one browser edit, the disk leg failed three times in a row,
alone, on the work branch with a clean tree, having worked repeatedly
(10.2–12.7s) for hours beforehand.

**Control, and it bounds the claim:** `sync-proof` — same box, same daemon, same
code, but **only ever written from disk** — is on its work branch, clean, and
its chain *descends from* the fetched head. Converged, hours later. So this is
not "the work branch broke syncing" and not a property of the new refs. **It
takes both ingresses submitting.** That is consistent with the two-chain account
and still does not prove it; a single-ingress project simply never creates the
second chain to diverge from.

**This is NOT the ref split.** Both bindings always had separate chains, in
separate repositories. What changed is that the browser leg now actually
submits, so both are live at once for the first time. **The room fix made a
pre-existing gap reachable.**

**IT ALSO DROPS DOCUMENTS. Re-measured 2026-08-25 evening, and this is worse
than the "stuck" framing above.**

On a project with three document roots, ONE edit through the browser source
editor took the head, and the revision it published contained **one of the
three**:

```
/source/paper.tex    200
/source/notes.md     404
/source/scratch.md   404
app lists documents: paper.tex        (was three)
checkout still has:  paper.tex notes.md scratch.md
```

The files are still on disk. They are gone from the server's current revision,
so the app cannot show them. The server's chain only knows the file the editor
had open, and publishing it drops the rest.

**So the consequence is not only that the loser cannot push. Using the browser
editor on a multi-document project can remove documents from what the app
serves.** Anyone weighing this against reverting the room fix needs that
sentence, not the milder one.

**What a person hits:** edit a project in the browser and on disk, and the
checkout stops syncing and stays stopped. Nothing says so — the settle result is
a returned value, and `git-sync-manager`'s `settleEditCluster` logs it at warn.

**Do not "fix" this by reparenting the person's checkout onto the fetched head**
without understanding why that was deliberately excluded — the comment in
`headChanged` is explicit that a person-owned checkout keeps its own history.
The real question is how two ingresses for one project are meant to share one
lineage, and that is a design question, not a patch.

### DO NOT REVERT `f1335d096` WHEN YOU MEET THIS

You will meet the stuck checkout before you meet anything else here, and the
tempting move is to revert the room fix that "caused" it. **It did not cause
it.** Both bindings have always had their own chains, in their own
repositories. The room fix only made the browser leg *succeed*, so both chains
became live at once for the first time. Reverting it does not remove the
divergence — it removes the browser leg's ability to submit, which is what was
hiding it.

**And what you would be reverting to is worse.** Before that fix the editor
showed old text while reporting `synced`, and the next keystroke saved the whole
stale document over newer content, accepted with no conflict. **A reachable way
to get STUCK beats an active way to LOSE WORK.** That was the judgement call for
shipping it and it is still the right one.

### RECOVERY: none known. Relink does NOT fix it — measured

Tested on `sync-demo`, which is disposable and was genuinely in the stuck state.
**Nothing of Skip's was touched.**

```
before relink   chain 6c549b1c2   fetched 98b975e37   diverged
after  relink   chain 6c549b1c2   fetched 98b975e37   diverged
```

The relink resubmitted the stale chain tip and changed nothing. So the obvious
repair, and the one Skip already sanctioned for everything else tonight, does
not apply here.

**`tlda project repo-doctor` is NOT known to help and was not run against this.**
Read its help: it targets a *content* fork against a git remote — it merges your
working tree onto origin's chain — which is a different failure from the
proposal chain diverging from the project head. It may be adaptable. Nobody has
tried, and guessing costs a day when it is wrong.

**So as of now: a checkout in this state is stopped, and the only known way back
is a fresh checkout.** Say that to whoever hits it rather than letting them
believe a relink worked.

## SYNC LATENCY: RANGE IS REAL, CAUSE IS NOT ESTABLISHED — with browser-perf

**This section previously read "INTERACTIVE SYNC IS STARVED BY LECTURE BUILDS —
measured". That heading was wrong and I retracted it to `sol-dev`, who passed the
retraction to `browser-perf` (message 3332289). Do not re-derive it.** The
starvation story fit the 43-minute window below and then failed its control: a
later run at load **0.22** still took **159s**. Read the whole section before
using any number in it.

**What is measured and stands (2026-08-25, demo paused, one project):**

| leg of the path | time |
|---|---|
| file write → daemon commits locally | **4s, 7s, 7s** — 3/3, consistent |
| local commit → visible at `/source/<file>` | **12s**, then **38s, 57s, 38s**; **159s** earlier |

### FOUND IT: A STOPPED BUILD WORKER HOLDS A SLOT FOREVER. Everything below this heading about `source-proposal-admit` is WRONG — read this first

**Admission takes 8 seconds, reliably, and the daemon log says so.** Edit at
22:21:18 → `sync-watch: proposal admission confirmed id=9731 state=pending
started_once=false` at **22:21:26**. The revision then sat `pending` for ~35
minutes.

**My error was the instrument, not the reasoning.** I polled `/source-head` and
called it "accepted". `/source-head` is the **published** revision, so I was
measuring the build queue and charging it to the step before it. The correct
signal is the daemon log line above, and it was there the whole time.

**The mechanism, in `server/lib/build-queue.mjs`:**

- `drain()` runs `while (activeCount < maxConcurrency)`
- `maxConcurrency` **defaults to 2** (line 16)
- `activeCount` is decremented in **exactly one place — `onExit`** (line 114)
- **there is no timeout on a build worker**

**Observed:** a worker in **state `T` (stopped)** — `ps` STAT `TNsl`, 0.2% CPU,
**34 minutes**, one `bash` child, no LaTeX process anywhere, box load **0.28**.
Not crashed and not busy. Suspended, holding a slot.

So the server ran on one of two slots with nothing to do. **If both go stopped,
nothing on that server ever builds again until it restarts** — every project,
every edit, and the log says `admission confirmed` for all of them.

`onExit` also `await relays` before decrementing, so a relay promise that never
settles is a second route to the same wedge.

**Recovery that worked:** `kill -CONT <pid>` on the box. It resumed, exited,
released the slot, and workers began cycling normally. **That is a poke, not a
fix.** Nothing prevents a recurrence.

**Unproven, do not assert it:** what stopped it. Niced, backgrounded, with a
`bash` child is the shape of SIGTTIN/SIGTTOU, but I did not show it.

**Not designed here on purpose.** Capping, reaping or timing out a build worker
is a policy decision and it is the shape of thing that becomes a subsystem. Say
the sentence to Skip before building it.

**Kept below because the measurements are still true and the labels are not.**
Read "accepted" as "published" throughout and it is a correct description of the
build queue.

**Narrowed further, 4 clean runs, demo paused — MISLABELLED, this is the build
queue and not `source-proposal-admit`:**

| leg | measured |
|---|---|
| file write → local commit | **5s, 5s, 8s** |
| local commit → revision accepted | **153s, >200s, 139s** |
| accepted → visible at `/source/<file>` | **same second** — these do not separate |

**Not transport**, same box same moment: `git ls-remote` **1.45/1.03/1.04s**, a
plain API GET **2.61/2.59/1.15s**.

So the watcher, the debounce and publishing are all fast, and 139–200s sits in
the push plus admission. The handler at `server/unified-server.mjs:9321` (the
`source-proposal-admit` case) is bounded and takes no lock, so the time is below
it — `admitProposal`, `sourceLifecycleStore`, or `gitRepository`. **That floor is
`browser-perf`'s and I did not go into it.**

**This does not only make sync slow, it makes it fail.** One run exceeded 200s
against the daemon's 240s window; that is where `NEVER ARRIVED` comes from. And
the same path measured **12s** earlier the same day, so there is a fast mode and
something moves it to a slow one.

**Load does not explain it.** 159s at load 0.22; 38s at load 3.0. Ruled out on
measurement, not argument: CPU, network (0.089s connect, 0% loss), server event
loop (mean 20–35ms).

**Numbers to throw out: any 90–160s figure from the demo's own output.** Those
were taken with two write legs running against one daemon and they include the
demo's self-contention — the same edit measured solo was 12–57s.

The 43-minute window below was real and is worth keeping as an artifact of what
the bad tail looks like. It is not evidence for a cause.

The live demo caught this on its own, which is the point of it.

```
LATE  disk   -> server arrived,  983s after the 240s window closed
LATE  disk   -> server arrived, 1674s
LATE  remote -> server arrived, 2064s
LATE  disk   -> server arrived, 2328s      (~43 min end to end)
```

Twice in the same window the server was unreachable: `file listing unreadable
(fetch failed)`. **Nothing was lost** — every marker arrived, which is only
knowable because the demo re-checks and distinguishes late from lost.

**Same demo, same project, a few hours earlier: 9.8s and 10.1s.**

What the box looked like in that window — **correlation, and it did not survive
its control; this is not the cause:**

```
up 8 min                       <- restarted by a deploy
load average 7.64, 11.44
R --file=rmd.R                 61.7-83% CPU, two of them
quarto render lectures/Lab1-prose.qmd
```

A deploy had restarted the machine and every batch render it interrupted re-ran
at once. `proposal failed: daemon request timed out: source-proposal-admit`
appears in the daemon log during these windows — **and also appears while plain
HTTPS to the same box answers in 0.26s**, which is the fact that broke the
story.

**The batch-vs-interactive contention proposal is withdrawn.** It was a good fit
for one window and it predicted fast sync on an idle box, which is false. Do not
propose bounding or moving batch renders on the strength of this section.

**What is actually open:** why the same path takes 12s and 159s on the same box
under the same load. `browser-perf` owns it, via `sol-dev`. The narrowing above —
everything downstream of the local commit — is the useful part to hand over.

**Forty minutes is not "slow", it is the app not working**, and it is exactly the
half of Skip's complaint that is not about files going missing.

## What is live and what is not

**Re-checked at 08:2xZ: box is `5bf51ea9c`, built 07:54:17Z, and EVERYTHING
BELOW IS LIVE.** Verify before trusting this — a table like it was already
stale once inside an hour:

```sh
curl -sk https://tlda-fly.cormorant-matrix.ts.net/api/build-info
git merge-base --is-ancestor <commit> <that gitSha>
```

| commit | what | verified how |
|---|---|---|
| `84c48f6e4` `e1687136c` | work branch + index reset | on the box, project built from scratch |
| `3d01bfb8f` | editor says it was refused | string present in the **served bundle** |
| `f3df688c1` `8d119dcc4` | build cards, shadow-repo paths | code inspection only |
| `f1335d096` | room staleness | **browser leg now works — 6.5s** |
| `369b49260` | migration | **`sync-demo` migrated live** |
| `7e4c06167` | demo asserts the branch invariant | ran against the migrated checkout |

**Verified live, project created from scratch** (`sync-proof`, disposable, still
on the testing box):

```
after link   branch = tlda/sync-proof, status clean, tree = doc.md notes.txt
one edit     server 9s | tip 1f4b1e1 -> 947a042 | subject "tlda settled edit
             cluster" | status clean | notes.txt tracked AND absent from the
             published revision
```

That last pair is what one ref doing two jobs could never do.

**Verified live, migrating a project that was IN the broken state**
(`sync-demo`):

```
before   branch main, dirty, branch tip subject "tlda project revision"
after    branch tlda/sync-demo, CLEAN, tip subject "tlda settled edit cluster"
kept     the old chain tip is still reachable and is an ancestor of the
         chain ref -- nothing deleted
```

**Verified live, the browser leg, for the first time ever:** editor mounted in
**356ms** (it used to time out at 30s), and text typed into CodeMirror reached
the server in **6.5s**.

**And then the disk leg stopped forever** — see the two-chain section above.
That is the state `sync-demo` is in right now.

## The room bug, and why it mattered more than "you saw old code"

`headChanged` stamped `room.heldRevision = revision`, persisted it, and
broadcast `status: 'synced'` **without touching the room's text**.

1. **You saw old code**, including on a *freshly mounted* editor — measured at
   twenty minutes stale. The persisted snapshot won over the file, and a
   reopened room compared held against current, found them equal, and correctly
   concluded it had nothing to do. **The stamp is what made it undetectable.**
2. **Your writing could be overwritten by it.** On that broadcast the client
   adopts the new revision as its base *and* records the stale text as saved
   (`FleetSourceEditorShape.tsx:1256–1259`). The next keystroke saves the
   **whole** stale document — `view.state.doc.toString()`, not a delta — against
   a base the server agrees is current. Accepted, no conflict, no merge.
   Everything that landed in between is replaced. It needs the person to type;
   an editor left open and untouched overwrote nothing.

Guarded by `server/lib/source-room-staleness.test.mjs` — three properties, and
**the counterfactual was run**: all three go red at `f1335d096^`.

## Migrating a real project: it worked, and three things came out of it

A pre-rename project of Skip's was migrated on the live box. **Second
independent confirmation of the migration**, on a project that had been
refusing to sync all morning:

```
08:02  not-on-work-branch
09:57  not-on-work-branch
15:20  proposal admission confirmed     <- after one relink
```

Working tree stayed clean, the person's own branch was untouched, and the old
chain history stayed reachable. **The relink is the whole procedure** for a
project in that state.

**One checkout can be bound to SEVERAL projects, and inference used to pick.**
That directory had **three**. `inferProjectName` returned whichever came first,
so `tlda project status` there answered *"Project not found"* about a project
that exists and is actively syncing. Fixed: it lists the candidates and stops.

**Say this part out loud, because it is the same lesson inverted:** removing the
basename fallback is what exposed it. The old guess had been right for that
directory **by luck** — the folder is named after one of the three. A guess does
not just risk being wrong; it *hides an ambiguity that should have been
reported.*

**`tlda project push` on an unchanged tree does NOT trigger a rebuild.** The
settle returns `equal-tree` and submits nothing, so there is nothing to build.
That matters when a project is sitting on a **stale** build error: pushing looks
like the obvious way to re-run it and does nothing, with no indication why. The
error clears on the next real edit. Do not read a push that changes nothing as
evidence the build is genuinely broken.

**Half of that is measured and half is not, so treat them differently.**
Measured: a real edit on a daemon-bound checkout produced a build in **~20
seconds**, ending `success`, on the current deployed code — so "an edit triggers
a build" is tested, not assumed. NOT measured: whether the specific stale error
clears. That needs the edit to land on the project actually holding it, and
editing someone's files to find out is not on.

## Instrument failures found tonight

Put beside the others in `docs/the-instrument-or-the-code.md` if anyone is
maintaining that list.

- **`summarizeDiff` answers "no meaningful changes" when it fails.** It reads
  its section tree with `readFileSync` inside `try { } catch { return null }`,
  and it was reading from the wrong base — `projectDir()` is overridden to the
  build instance during a build, and a build instance has no `shadow-repo`. So
  it returned null for **every build**. This is the most quietly expensive shape
  in the family: *a function whose whole job is telling him what changed, and
  whose failure mode is reporting that nothing did.* Fixed in `8d119dcc4`; the
  shape is the lesson.
- **`fly logs --no-tail` returns ~100 lines.** Counting occurrences in it and
  reporting zero is a fact about the window. My control (`Version recorded`)
  also came back 0 while I had watched it scroll past minutes earlier.
- **`${pipestatus[1]}` in zsh, `$?` after a pipeline.** Both reported `tail`'s
  exit as the command's. Every "REAL exit" in tonight's transcript is written
  that way for this reason.
- **A `git grep` with a pathspec I guessed wrong** returned 0 twice for symbols
  that were present. Both times the positive control caught it. Run one.

## The 3-second status scan — DIAGNOSED, NOT FIXED, AND MY PROPOSED FIX IS WRONG

This is Skip's *"literally every agent status is hibernating all the time"*.

`scanStatus` (`daemon/agent-status.mjs:187`) resolves an identity for every
listed pane and **throws if any one is incomplete**; the catch `return`s, so
**no agent's status is computed at all.** 221 of the last 400 daemon log lines
are this failure. It has never succeeded.

Measured across all 55 panes:

```
FLEET_ID present but no FLEET_DAEMON_KEY    0
no FLEET_ID at all                          1   <- kills the whole scan
```

That one is a **codex agent in a `fleet-` prefixed session** whose process
carries no `FLEET_ID`.

**I proposed skipping panes that are "not a fleet process at all" and `bhief-4`
correctly refused it.** The offending pane *is* a fleet process that looks like
a non-fleet one, so that rule either still throws, or classifies it as non-fleet
and **silently skips a broken agent** — the death-inference shape arriving
through the side door. **The process alone cannot tell them apart.** Do not
write that classifier.

**What was asked for instead, and the part that is not done:** make the scan
compute status for every pane it *can* resolve and **report the ones it cannot,
by name, once, loudly** — rather than discarding the roster. That requires
knowing what consumes `liveAgents` and whether it treats absence as death.
**Nobody has traced that. Trace it before writing anything.**

**And chase the instance separately — it is the smaller, safer fix and it fixes
today's outage without touching the guard at all:** a codex agent whose process
has no `FLEET_ID` is a launch path not setting the environment.

## A CONFLICTED CHECKOUT SILENTLY HALTS ALL SETTLING — found 2026-08-25, unfixed

**Leave a merge conflict in a bound checkout and the daemon stops settling
anything.** Not only the file that conflicted, and not only the leg that caused
it — every ingress into that project goes quiet, disk writes included. The only
signal anywhere is one `warn` line: `proposal not accepted: conflicted`.

Reproduced by accident, twice. The state is plainly visible in the checkout —
`UU notes.md`, `MERGE_HEAD` present — but nothing in the app says so, so from
outside it is indistinguishable from a dead watcher, a dead daemon, or a network
fault. **I spent twenty minutes looking for a network fault that was not there.**

**This is the third failure today whose presentation was "nothing is happening",**
after the dead watcher on an `rm -rf`'d checkout and the page-filename mismatch.
That is the class worth fixing, not the individual causes: a stopped pipeline
reports the same as an idle one.

**Not fixed, and I did not design a fix** — where the conflict gets surfaced is a
product decision. The mechanism is `settle()` in `daemon/git-project-sync.mjs`
returning without progress, and the demo now works around it on its own side by
keeping its fixture from diverging (`7877a4843`).

## Open, and whose

**Skip's call, not ours:**

- Build-card change summaries are filtered to `*.tex`. That is **not** an
  oversight: `summarizeDiff` builds a section tree from tex, looks for theorems
  and proofs, and keys off `basename(mainFile, '.tex')`. Markdown cards need a
  markdown summarizer, which is a decision about what a build card should say.
- A remote added *after* linking is never polled. The daemon builds its polling
  bridge from `binding.remote`, which only `link` writes; `tlda project remote
  add` runs a plain `git remote add` and does not touch the binding.

**Ours, low priority, deliberately not built:**

- The client source manifest is written by **nothing** —
  `updateClientSourceManifest` has zero callers — so `GET /:name/files` returns
  `[]` for every project. **It is not a deletion risk**: `submitFiles` never
  reads `payload.sourceManifest`, which I re-checked and recorded in
  `docs/what-the-old-push-did.md` (`6f36c9e55`) **because I nearly reported it
  as one**. The only client consumer is the editor's basename disambiguation,
  which degrades to using the path as given. Building a wire for one consumer
  that barely notices is the second-ingester trap in reverse.

**Not finished:**

- `sync-demo` (the demo project) is still un-migrated — on `main`, and the
  deployed gate now correctly refuses to sync it. Once `369b49260` serves:
  relink it, then `node bin/sync-demo.mjs --legs disk,browser,remote`. The
  **browser leg has never been proven end to end** and needs `f1335d096`.
- **KEEP `sync-demo`. It is the only reproduction of the two-chain divergence.**
  An earlier draft of this file said to delete both disposable projects when
  done, which was written before that bug existed. Deleting it destroys the one
  checkout anybody can inspect in the stuck state, and the divergence is not
  something you can conjure on demand — it took a browser write landing between
  two disk writes. `sync-proof` is a plain healthy project and can go.

## Things that will waste your time if you do not know them

- **Three `git-sync-manager` tests are RED ON UNTOUCHED `main`** — `one broken
  binding`, `initial project link submits`, `same-daemon relink`. Verified in a
  worktree at `main`, not assumed. They are not yours. Baseline before blaming
  yourself.
- **`bin/a-conflicted-checkout-reports-synced-test.mjs` is also red on `main`.**
- **`source-room-git-boundary.test.mjs` asserts `room.heldRevision` and passes
  on the broken code.** Asserting the stamp is exactly the assertion that held
  while the app was broken. Assert the *text*.
- The daemon runs from `~/worktrees/daemon-testing`. A `testing` deploy updates
  that checkout and restarts it — there is no separate restart step.
- `tlda` (the CLI) runs from the shared checkout, so CLI fixes are live on
  commit with no deploy. Server, daemon and client changes all need one.
