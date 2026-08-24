# Reliability PM resumption point — 2026-08-24

Force-added under gitignored `scratch/` on purpose. **This is not a report of
finished work; it is what the next person continues from.** `AGENTS.md`
§"Repository workflow".

Author: `reliability-pm` (`fleet:d733e20d`), charter from `bhief-4`: whether the
app works for Skip day to day.

**Relative to, at the moment of writing (~2026-08-24 06:5xZ):** `main` is
`efe34baa2`. **The deployed box is `cd2119ce0` — seven commits behind, and four
of them are tonight's fixes. Nothing below is proven until that deploy happens.**

---

## Skip's priorities, his words, replacing anything earlier

2026-08-24 ~01:00 EDT, direct to me:

> the fucking phenomenon that like, the app does not version or display code and
> periodically, like, locks up — that that is a fucking problem

And the definition of the display half, which is **not** a rendering problem:

> It's a synchronization problem such that the files don't get there, or if they
> do get there, they're old. Or they don't have their version history

**Shapes are off the list permanently:** *"no one cares about fucking shapes …
if anyone says anything about fucking shapes ever again in my fucking life"*.
The orphan A/B is dead; `7cdc0cb90` is unblocked.

**Standing instruction, 01:43 EDT:** *"do not ever ever let something fucking
problematic in the system slip through your fucking finger … The system has to
be fucking simple. It has to be what I fucking specified."*

---

## RESOLVED 2026-08-24 ~21:30Z — VERSION RECORDING WORKS, PROVEN TWICE

**Superseded: the section below described this as live and undeployed. It is
fixed, deployed and proven.** Left in place because its diagnosis is still the
record of what was wrong.

**Proven on a disposable project, by name, after `c3a7c7e62` deployed:**

```
HEAD 22bbee1  2026-08-24T21:14:54Z  Build at 2026-08-24T21:14:54.609Z
revision/main.tex      1
revision/appendix.tex  1
notes.md               0     (tracked, reached by no root — correctly excluded)
```

The subject is `Build at …`, so it is a **build snapshot and not a second
bootstrap** — that distinction was `bhief-4`'s counterfactual and it matters,
because a commit *count* of two would look identical either way.
**Independently confirmed by `bhief-4` on a different project** with its own
edit: `live-watcher-probe`, `9e0ad3dd Build at 2026-08-24T21:21:03.501Z`.

**Two fixes, both needed:** `414933ab2` (read side — the lifecycle store) and
`c3a7c7e62` (write side — the shadow repo). Both were the same root cause:
`projectDir()` returns the build-instance override.

### The 08-17 → 08-20 gap is closed, and it dissolved rather than resolved

I held three days open against his project and they were never its to have:

```
project createdAt      2026-08-23T01:11:24Z
shadow newest commit   2026-08-17T11:03:27Z
```

**The shadow is older than the project.** That history was seeded from a
previous incarnation whose last snapshot was 08-17; the project here was created
**08-23, three days after instances landed.** So it has never been able to
snapshot in its current life, and the instance bug accounts for all of its
silence.

**Fleet-wide `Build at` snapshots per day confirm the boundary independently:**

```
08-14 143   08-17  70   08-20   5
08-15 125   08-18 139   08-21   1
08-16  55   08-19  24   08-22/23 0
```

**Nothing stopped on 08-17** — the fleet snapshotted through 08-18. The collapse
is 08-19→08-20, exactly where `83cd0b0d6` landed.

### Instrument failures from this stretch — both the same shape as the bug

- **I reported the fix as FAILED and had to retract it within a minute.** My
  shadow read ran at ~21:14:5x; the commit was written at **21:14:54.609**. I
  found it by checking `git log --all` and the reflog on a result I had already
  sent. **A read that cannot distinguish "not there" from "not there yet."**
- **`version` phase records in the lifecycle journal: 0 across 282 revisions**,
  which looked like proof finalize never ran. The control killed it — my probe,
  which I had just proven recorded a version, also shows **0**. The journal does
  not persist that phase at all. **A read that cannot distinguish "did not
  happen" from "not recorded here."**

Both are shape 11 with a clock in it. The bug's version of the same error lasted
four days; mine lasted a minute. **Run the control on the negative, always.**

## Superseded — the regression as it was described while live

**`23f5ccf75` (mine) stops version-recording entirely, and it is deployed.**
A build now records **no version at all**.

**Cause, established mechanically rather than guessed:**

- `project-store.mjs:388` — `projectDir()` returns `projectPathOverrides` first
- `bin/build-worker.mjs:165` — the worker sets that override to the **build instance**
- `sourceLifecycleStore` rooted at `projectDir(name)/.source-lifecycle`, so during a
  build it read the instance's copy, which holds none of the revision objects

**Measured on a disposable project on the deployed box:**

```
build.log        No version recorded for this build: revision 13a9b708 carries no files
LIVE lifecycle   ls-tree → revision/appendix.tex, revision/main.tex
relevant-files   ["revision/appendix.tex","revision/main.tex"]
```

**This is a regression I created, NOT a pre-existing fault I exposed.** The old
code read `relevant-files.json` from the instance's *own* output directory,
which the build had just written, so it was never affected. **It does not
explain the seven-day freeze**, which remains unexplained.

**Fix: `414933ab2`** — routes that store through a new `liveProjectDir(name)`
which ignores the override, because the revision git and operations journal are
durable state while the instance is scratch removed in a `finally`.

**Undeployed as of writing.** Box `e7320958d`; `414933ab2` is the **only** commit
on `main` after it. I did not push it myself: the release path is the chief's,
and I asked Skip twice and `bhief-4` once rather than deciding alone. `sol-dev`
did both of today's deploys and has said it is not deploying now, so nothing is
racing — a single push ships it.

**When it ships:** rebuild the probe (`~/worktrees/versioning-probe`, project
`versioning-probe`, two roots in a subdirectory) and check its shadow HEAD holds
**both** roots **by name**. Then delete the probe project.

**Not changed, flagged not swept:** `listProjectSourceRecoveries`
(`project-store.mjs:294`) roots `.source-transactions` at `projectDir(name)` too —
same shape. **Not established as reached during a build**, and not edited on the
strength of an analogy.

## DEPLOYED 2026-08-24 14:42 EDT — two of three fixes now PROVEN LIVE

**The box moved to `6dece0822` and all three fixes are in it.** Not deployed by
me and not by bhief-4 (hibernating since 00:50, never recovered from the API-529
loop) — another push carried them along.

**PROVEN, measured against the live box with a negative control:**

```
appendix historical page   HTTP 200   54,620 bytes   real dvisvgm SVG
manuscript page (control)  HTTP 404
```

`GET /docs/<project>/history/shadow-0b5aa55/<second-root>-page-1.svg`
now renders. It could not before: the old code took the target from
`project.mainFile` ("manuscript"), so asking for the appendix compiled the
manuscript — and `revision/manuscript.tex` is not in that commit. **Every
non-primary root behaved that way.** So `6895a5aef` + `efe34baa2` work end to
end.

**The control is the stronger evidence.** Its 404 detail reads
`main=revision/manuscript.tex` — the **full subdirectory path**, resolved from
the declared roots. The resolver looked in the right place, found the file
genuinely absent from that commit, and failed honestly. The old fallback would
have guessed a bare `<texBase>.tex` at the checkout root. So the path
discriminates between targets AND resolves each correctly.

That 404 is the **permanent** one: all 736 recorded versions lack
`revision/manuscript.tex`, so the manuscript's history stays unopenable
regardless. The appendix's history is back.

**STILL UNPROVEN: `23f5ccf75`, the versioning fix.** Its check needs a build and
**nothing on that box has built since the deploy** — the project's last build
was 05:40Z, and zero projects have a post-deploy shadow commit. **Not a failure;
an absence of evidence.** It proves itself on the next build, and the check is
unchanged: a new shadow commit contains `revision/manuscript.tex` **by name**.

## Superseded: the deploy that was blocking everything

`main` is 7 ahead of the box. **Put to Skip as A (I deploy) or B (bhief-4 does)
and unanswered as of writing.** bhief-4 was woken, is alive (the wake refused
with *"tmux session fleet-bhief-4 already has a live harness runtime"*, so the
hibernating roster row is stale) and has not replied in ~50 minutes.

**The two checks to run the moment it lands**, and they are by name, not count:

1. a new shadow commit on the two-root project **contains the root `.tex`**
2. a historical page of the **non-primary** root returns that root's content

---

## Landed tonight, all undeployed

| commit | what |
|---|---|
| `23f5ccf75` | version the files git has, not the ones pdflatex opened |
| `6895a5aef` | build the history page for the target that was asked for |
| `efe34baa2` | find a target's `.tex` by asking the roots, not guessing at the root |
| `eaa2d8707` | the `mainFile` scope document (below) |

**These three are one defect in three places:** something other than git decided
what a document is, and each place decided differently.

`efe34baa2` is the one with a production counterfactual — over all 21 LaTeX
projects on the box, the old logic resolved 19 targets to a real file and
**2 to a file that is not there**, one of them his second root; the new logic
resolves 21, 0 unresolvable, 0 absent.

---

## STILL OPEN — start here

### 1. The mirror is gone, and it is why history never reaches his machine

**Not a regression to hunt — a documented deletion.** The chain:

| | |
|---|---|
| `c16e8472a` 08-18 | build-era mirror deleted **on purpose**; mirroring moves to the accept |
| `68cd40874` 08-19 | adds `mirrorAcceptedRevision` to the push route **plus a test** |
| `f6d0f9089` 08-20 | *"Delete parallel server source authority"*, 8,421 deletions — **removes it** |

**`bin/mirror-failure-visible-test.mjs` is RED on `main` and names the defect in
its own assertion**: *"mirrorAcceptedRevision is gone from
server/routes/projects.mjs — the accept no longer mirrors"*. Verified by running
it: exit 1. It has been red since 08-20 and nothing runs it — `npm run lint`/test
has one automated caller, on a `v*` tag, `continue-on-error: true`.

`f6d0f9089` also removed the only writer of `lastEditedBy`, which is why
per-file attribution died. **One commit, two of his seeing-mechanisms.**

**Do NOT rebuild a mirror from scratch.** The 08-18 commit is explicit about why
the *build-era* one was killed: it committed the shadow's content, which lags
the accepted source and does not converge, and on 2026-08-17 four mirror commits
took the same two changes out of a paper's HEAD. Skip remembered this
unprompted — *"it was playing shit back over files"*. **The accept mirror does
not have that property by construction** (it commits the accepted revision,
which IS the head). So the move is to restore `68cd40874`, not to invent one.
**Put to Skip; awaiting his word.**

`mirrorShadow()` in `build-runner.mjs` still exists with **no caller** — it is
the corpse of the build-era mirror. `readShadowSourceScope`'s use of the old
scope-picker is inside it, so that is **not** a live defect. I flagged it as one
earlier and was wrong.

### 2. Chat still hands him a frozen copy — but only for untracked files

**Mostly already fixed and deployed**, which I nearly missed: `4b8345288`
(*"Open the live document instead of copying it"*) and `acb661260` (a click on a
tracked markdown file makes it a root) are both in `cd2119ce0`.

**The remaining case is a markdown file git does not track**, and it cannot
simply be adopted: a declared root absent from the settled tree makes
`filteredProjectCommit` throw *"configured document root is absent"*, caught at
warn — which stops the project syncing **entirely**, silently. So the click
currently makes a snapshot instead, nothing says it is one, and nothing ever
refreshes it.

**Three options are with Skip, unanswered:** (A) refuse and offer to add,
(B) `git add` it then open live, (C) render live without rooting it. I
recommended **B** as the only one where the file ends up both current and
versioned.

**Do not read the six stale files in that project's `parts/` as six clicks.**
They all carry the same 15:54 stamp, which reads as one bulk operation plus the
chief's hand-restore of `a1b81267`. I reported them as per-click evidence and
withdrew it.

### 3. The lockup config is not what the record says

`buildMaxConcurrency: 1` is **absent** from the box's `server.yaml`, which is
byte-identical to `server.yaml.bak-20260823`. `server/lib/build-queue.mjs:16`
resolves absent to **2**, and `nproc` is **2**.

**This is a decision, not a re-apply.** `shared/config.mjs` ships `2` with the
comment *"k >= 2 is a correctness bound rather than a throughput preference"*,
and `bin/a-second-build-slot-that-exists-test.mjs` asserts absent must mean two
concurrent builds. On a 2-core box those conflict.

**Ruled out while looking at this, so nobody re-derives them:**

- **Builds are already deprioritised** — `bin/build-worker.mjs:25` calls
  `setPriority`. Do not propose nice-ing them.
- **The queue already thins superseded pending builds** (`build-queue.mjs:50–63`).
- **Build suppression buys nothing on his project.** `outside-tree` was gated on
  what fraction of accepts render nothing relevant: measured over the last 60
  revisions, **60 of 60** changed a file the render reads (controls: 0 empty
  diffs, 0 unmatched). `shouldBuildOnPush` would suppress zero.
- **The stall rate is currently low and that is not evidence of health** — ~32/hr
  through the evening, 3–9/hr after 01:00Z, but he stopped working at ~01:48Z.
  That is an idle box.

Fix 1 from the previous chief **did** survive: `idx_agents_lower_id` is present.

### 3b. THE SYNC TEST CLUSTER CANNOT RUN, AND THAT IS WHY THE REST OF THIS IS INVISIBLE

**This is the finding under all the others.** The tests that guard sync and
versioning do not fail on assertions — **they fail before they test anything,**
because the API they were written against no longer exists.

Measured by running them on `main`, one at a time:

```
a-commit-per-accepted-push             TypeError: lifecycle.readAuthority is not a function
a-ref-that-does-not-outrun-its-record  TypeError: lifecycle.bootstrap is not a function
a-refusal-that-names-what-differed     TypeError: lifecycle.bootstrap is not a function
a-retry-that-lands-once                TypeError: lifecycle.prepareOperation is not a function
one-file-out-of-a-big-book             TypeError: lifecycle.acceptBundle is not a function
a-bootstrap-does-not-repeat-...        TypeError: restarted.readAuthority is not a function
an-accept-the-daemon-is-never-told...  TypeError: store.bootstrap is not a function
source-lifecycle-authority             SyntaxError: no export named ... (cannot even load)
mirror-failure-visible                 mirrorAcceptedRevision is gone — the accept no longer mirrors
```

**Nine red. Six green** — `an-accept-that-preserves-the-work`,
`shadow-mirror-preserve`, `outside-tree-publishes-source-only`,
`shadow-mirror-rpc-adapter`, `mirror-timeout-budget`,
`source-project-store-contract` — so this is not "the runner is broken", and the
green ones are the positive control.

**`readAuthority`, `bootstrap`, `prepareOperation` and `acceptBundle` are in NO
production file on `main`.** Only tests call them. Same commit as the mirror:
**`f6d0f9089`**, *"Delete parallel server source authority"*, 8,421 deletions,
08-20. **12 files** still reference `readAuthority`, including
`bin/lib/lifecycle-push-test-helper.mjs` — the shared helper, which is why the
cluster went down together.

**One of the 12 is not a test.** `bin/repair-source-replica-target.mjs` is a
**repair tool**, and it calls a function that no longer exists. It throws the
moment anyone reaches for it — which is when sync is already broken.

**Nothing runs any of this.** `npm run lint`/test has one automated caller,
`.github/workflows/release.yml`, on a `v*` tag, `continue-on-error: true`.

**They cannot be "rewritten against the current API", because there isn't one.**
I diffed the store's methods today against what the tests call. **Ten of twelve
are gone**; only `readRevision` and `readRevisionFile` survive.

Where each actually is in production now:

```
acceptBundle      0 files        readAuthority   0 files
lastMirrored      0 files        lastRefused     0 files
mirrorPayload     0 files
prepareOperation  only inside another dead test file
finishOperation   only inside another dead test file
markMirrored      SURVIVED — moved down into source-git-store.mjs:541
```

**`prepareOperation` / `finishOperation` is operation idempotency** — prepare an
operation, finish it exactly once, replay safely after a restart. `AGENTS.md`
§"Idempotence is what makes a messy environment survivable" is Skip asking for
exactly this. It is gone from production and survives only in tests that cannot
run.

**A tenth red, in a different directory:** `server/lib/source-lifecycle.test.mjs`
— **0 pass, 3 fail**, `first.prepareOperation is not a function`. It lives under
`server/lib/`, so `npm test` would surface it if anything ran `npm test`.

**So there are two honest options and both are Skip's:**

- **A — the deletion was right.** Then delete these tests, in a commit naming
  which behaviours were dropped. As they stand they read as coverage of things
  nothing implements.
- **B — the deletion took things that should not have gone.** The accept mirror
  is already proven to be one. Operation idempotency looks like another. Then
  the layer comes back.

**Do not quietly do either.** `f6d0f9089` is one commit, 8,421 deletions, titled
*"Delete parallel server source authority"* — and nothing in that title says the
mirror, per-file attribution and operation idempotency would all stop.

### 3d. It is not one commit. Seven commits, ~24,000 deletions, no explanation

`f6d0f9089` is not an outlier. Scanning `main` since 2026-08-10 for commits over
1,000 deletions and measuring the **body** of each message (whitespace stripped):

| commit | date | deletions | body chars | subject |
|---|---|---|---|---|
| `672ba4d90` | 08-20 | **7,217** | **0** | Cut daemon source sync over to Git proposals |
| `f6d0f9089` | 08-20 | **8,421** | **0** | Delete parallel server source authority |
| `e3ba10559` | 08-20 | **2,929** | **0** | Make Git remotes ordinary daemon sources |
| `fa3f3874c` | 08-20 | **1,392** | **0** | Implement durable daemon build queue |
| `7a8364e62` | 08-21 | **1,881** | **0** | Remove legacy diff documents and repair initial loading |
| `5cb978fce` | 08-21 | **1,040** | **0** | Unify fleet status authority |
| `5ab19281f` | 08-15 | **1,647** | **0** | Compose accepted classroom lecture delta |

**Four of them are the same day — 08-20 — and they are all in the sync path.**
That is roughly twenty thousand deletions through sync, in one day, with no
recorded reasoning anywhere.

**The control matters:** other large commits in the same window DO carry bodies
— `5a0f2ca4f` 2,119 chars, `4fc9005f0` 1,509, `b37f809d7` 1,105. So this is not
a house style and not a measurement artifact. Some authors explain and some do
not.

#### And a missing body does NOT mean the commit was destructive — three of the seven are fine

Counting files deleted outright against files added, per commit. **Do not carry
this list forward as "seven bad commits"; it is three bad, three fine, one
unexamined.**

| commit | files deleted | files added | test files deleted | verdict |
|---|---|---|---|---|
| `672ba4d90` | 34 | 4 | **28** | **stripped coverage** — §3e |
| `f6d0f9089` | many | few | several | **removed live behaviour** — §3b, §3c |
| `5cb978fce` | 8 | **0** | **4** | **stripped, added nothing** — below |
| `7a8364e62` | 12 | 4 | 0 | **not examined.** No coverage lost; the 12 are non-test files |
| `e3ba10559` | — | +2 | 2 | **fine** — a real generalisation, settled above |
| `fa3f3874c` | 1 | **11** | 0 | **fine** — a build-out; its 1,392 deletions are edits, not removals |
| `5ab19281f` | 2 | **51** | 0 | **fine** — a build-out |

**`5cb978fce` "Unify fleet status authority" is the third one, and it lands on
Skip's priority 4, agent status.** It deleted 8 files and added none:

```
daemon/agent-liveness.mjs                       144 lines   the liveness module
bin/agent-liveness-trace-test.mjs               151
bin/status-liveness-authority-test.mjs           86
tests/daemon-status-liveness-contract.test.mjs   16
mcp-server/fleet-tools.mjs (-25), server/routes/fleet.mjs (-11), bin/qa-watcher.py, +1
```

A liveness module and its **three** tests removed, nothing put in their place,
no message. Worth holding next to the standing knowledge that the roster
misreports — `AGENTS.md` and memory both already record that hibernating/awake
rows go stale. **Not chased; recorded.**

**This is the answer to "why does it keep breaking invisibly."** Every defect
found tonight traces into that window, and the record cannot say what any of it
was meant to preserve. One of the seven turned out to be a clean generalisation
(`e3ba10559`, above) — which is only knowable by reading its diff.

### 3e. `672ba4d90` traded 4,767 lines of sync tests for 98

The largest single piece of the 08-20 window, and the one that best explains why
nothing surfaced afterwards. *"Cut daemon source sync over to Git proposals"*,
7,217 deletions, **no message body**. It deleted **34 files and added 4**:

```
test files deleted  28      test lines deleted  4,767
test files added     2      test lines added       98
```

**What went is named after guarantees, not after code:**

- `an-edit-that-reaches-another-machine-test.mjs`
- `an-edit-made-before-a-restart-is-still-pushed-test.mjs`
- `collaborators-on-one-project-test.mjs`
- `a-removal-the-paper-still-references-test.mjs`
- `a-document-he-clicked-is-not-a-deletion-test.mjs`
- `server-held-phantom-deletes-test.mjs`
- `an-unanswered-source-push-releases-the-project-test.mjs`
- `source-conflict-delivery-test.mjs`, `source-daemon-and-caller-contract-test.mjs`

**Be fair to it:** this was a genuine rewrite — the old mechanism was replaced by
git proposals, so tests of the old mechanism going is not automatically wrong,
and `daemon/git-project-sync.test.mjs` (50 lines) passes today, exit 0.

**But the other replacement test is RED, and it is the one that matters.**
`daemon/git-sync-manager.test.mjs` (48 lines) is not hanging — I first recorded
it that way and that was wrong. It is merely very slow, 6–30 seconds per case,
and it **fails**:

**Complete run, exit 1 — 8 cases, 4 fail:**

```
✖ bound working-copy event settles through the one Git proposal path
✖ one broken binding does not prevent a later project binding from starting
✖ initial project link submits the existing checkout through the ordinary proposal ref
✖ same-daemon relink installs corrected roots and later metadata updates preserve them
✔ existing tlda remote is reconciled without attempting to add it again
✔ two projects sharing one checkout submit to their owning project remotes
✔ an up-to-date immutable proposal still requests confirmed admission
✔ explicit submit confirms admission even when the shared tree is already equal
```

**DO NOT read those four names as four sync failures. I did, and it was wrong.**
The names describe what each case *would* test; the reasons are four different
things and only two of them are about the app:

| case | actual reason |
|---|---|
| bound working-copy event settles… | **`ReferenceError: warnings is not defined`** at `:54:80` — never could pass |
| initial project link submits… | **stale test** — asserts an untracked file is a member; see below |
| one broken binding does not prevent… | `Missing expected rejection` at `:81` |
| same-daemon relink installs corrected roots… | `Missing expected rejection`, expected `/broken\.tex has missing dependencies/` |

**The first one is a broken test, not a broken app.** `warnings` is used in that
test and declared only in the *next* one. It is the third argument to
`assert.match`, so it is evaluated on every run — the case has been
dead-on-arrival since it was written, and it says nothing about sync.

**And `eslint` finds it instantly:**

```
$ npx eslint daemon/git-sync-manager.test.mjs
41:37  error  'warnings' is not defined  no-undef
41:84  error  'warnings' is not defined  no-undef
54:80  error  'warnings' is not defined  no-undef
```

This is `AGENTS.md` §"Verify the relevant surface" verbatim — *"`tsc -b` does not
catch an undefined variable in a `.mjs` file. `eslint` does, and nothing runs
it."* It shipped that way in the file that replaced 4,767 lines of coverage.

**Case 4 is now settled too, and it is ALSO a stale test — but it found the best
answer to "the files don't get there".**

It expects `manager.submit()` to reject with `/broken\.tex has missing
dependencies/`. The code deliberately stopped doing that, and
`daemon/git-project-sync.mjs:175–199` writes the reasoning out: throwing would
abort the whole checkpoint, *"so every OTHER file in the build loses its
preservation commit too, permanently and on every build"*, and under
tracked-only staging an unstaged file is missing by definition — so it would
stop the project submitting anything, forever, because nothing ever stages it.
**That reasoning is sound. The tolerance is right.**

**What is wrong is the silence, and it is an asymmetry:**

| case | what happens |
|---|---|
| a file **tracked** in git that no document root reaches | `onDocumentsDropped` → `daemon-warning` → **the server turns it into a chat message** (`bin/fleet-daemon.mjs:556`) |
| a file **referenced but never `git add`ed** | `log.info` in `git-project-sync.mjs:199` and **nothing else** |

The second message already exists and already says the right thing — *"references
X, which is present but untracked — it joins the revision once it is staged"* —
and it goes to a daemon log. **Case A gets a chat message; case B, which is the
one that happens while he is writing, gets nothing.**

**The fix is not a mechanism**, which is why it is worth stating: send the same
`daemon-warning` case A already sends, with the sentence the code already writes.
**Not built — it changes what he sees, and it is the same decision as the
untracked-click A/B/C.** Folded into that question rather than opened as a
fourth.

**FINAL TALLY — and it retracts the alarm. NONE of the four is evidence that
sync is broken.**

| case | what it is |
|---|---|
| bound working-copy event settles… | **broken test file** — `warnings` undefined, could never pass |
| initial project link submits… | **stale test** — asserts an untracked file is a member |
| same-daemon relink… | **stale test** — expects a throw the code deliberately stopped |
| one broken binding does not prevent… | **almost certainly stale, NOT confirmed** — `sync()` does throw an `AggregateError` on a failed binding (`git-sync-manager.mjs:204`), so the mechanism is intact; the fixture's unreachable remote no longer fails *at bind time*, which is plausible now that remotes are polled rather than contacted on bind |

**One bug in a test file and three tests describing a design that changed.**
I reported these as alarming and they are not. *"The sync tests are red, so sync
is broken"* was my inference and it was wrong — whoever picks this up should not
inherit the scare.

**What survives is unaffected by that:** the versioning defect (fixed,
undeployed), the deleted accept mirror, the untracked-file silence, and the
08-20 deletions. The 48-to-1 test reduction is still true and is still why the
mirror and the silence went unnoticed.

**I ran that sweep. `bin/` and `daemon/` are otherwise CLEAN** — 3 `no-undef` total, all three in that one file, 1 file affected. So it is isolated rather than systemic; do not spend a morning expecting more. (A `server/ shared/ cli/ mcp-server/` sweep was started separately.) Original note, kept because the check is still the right first move: `npx eslint bin/ daemon/` before reading
anything. If one replacement test shipped with three `no-undef` errors, others
will have them.

**The four passes are the control**: the file runs and the rig is sound, so
these are real failures rather than a broken harness.

**Reporting history on this file, because I got it wrong twice:** I first called
it hanging (it is not — cases take 6–30s), then reported 2-of-4 from a run I had
killed at two minutes. **4-of-8 is from a run that finished.** If you re-run it,
give it several minutes and read `/tmp`-redirected output rather than a `tail`.

**One of the four is settled, and it is a STALE TEST — do not make it pass.**

`initial project link submits the existing checkout through the ordinary
proposal ref` writes a **new, untracked** `child.tex`, edits `main.tex` to
`\input{child}`, and waits 30s asserting `child.tex` becomes a project member.
The code is right to refuse:

- `daemon/git-project-sync.mjs:305` stages with **`git add -u`** for an
  author-owned checkout, `-A` only when app-owned. `-u` stages tracked only.
- `appOwnedWorkingTree` defaults to `false` (`:39`) and the test never sets it.
- the closure is computed from `git archive <workingCommit>` (`:146`) — the
  **committed** tree — so an untracked file cannot enter it by either route.

**Skip ruled membership is `git add`** (2026-08-23 08:06 EDT, *"supposed to bea.
fucking git add"*, *"to the fucking lda branch"*). The test also asserts
`unrelated.txt` is not picked up, which shows its model was *membership is
filesystem reachability* — the model that was replaced.

**THE TRAP:** the obvious way to green it is `-u` → `-A`. His paper repo has
**398** tracked `.md`/`.tex`/`.qmd` files, **225 under `scratch/`**. That change
sweeps his scratch directory into the project.

**The other three are NOT established.** Do not reason by analogy from this one —
the point is that each needs reading. **"Make the sync tests pass" is the wrong
instruction; "decide per test whether it still describes the app" is the right
one.**

**And nobody would notice.** 6–30 second cases mean it is never run casually,
and the one automated caller is on a `v*` tag with `continue-on-error: true`.

**But 98 lines do not cover those sentences.** *An edit reaches another machine*
and *an edit made before a restart is still pushed* are not implementation
details of the old mechanism — they are equally true or false of the new one,
and now nothing asks.

**Read this together with 3b:** `672ba4d90` deleted the sync tests, `f6d0f9089`
deleted the layer the *surviving* sync tests were written against, and between
them the accept mirror and per-file attribution stopped. **One day.**

### 3c. `f6d0f9089` is 8,421 deletions with a five-word commit message

**The message is the subject line and nothing else.** No body. 40 files. It is
the single commit behind three separate confirmed casualties — the accept
mirror, per-file attribution (`lastEditedBy`), and the lifecycle operation /
authority layer — and **its record cannot tell anyone why any of it went.**

Same class as the wake-marks-dead commit `AGENTS.md` §"DEATH IS A FLAG" records
as shipping with no message. Worth stating plainly to whoever reviews this area.

**A fourth deletion, and it is SETTLED and fine — do not re-chase it.**
`server/lib/overleaf-sync.mjs`, 760 lines, plus its two tests. I first recorded
this as unassessable. It is not: the commit that removed it is
**`e3ba10559`, "Make Git remotes ordinary daemon sources"** (2026-08-20), which
in the same change **added `daemon/git-source.mjs` (188 lines) and its test**.
`createGitRemotes` is live in six files today including
`daemon/git-sync-manager.mjs` and `daemon/remote-git-bridge.mjs`.

**So Overleaf stopped being a special subsystem and became an ordinary git
remote. That is a generalisation, not a loss** — and it is exactly the shape
`AGENTS.md` asks for. The subject line answered it; I had to read the diff to
believe the subject, which is the cost of the missing body.

**And it is why the onboarding line below is stale:** the flow should now go
through `tlda project remote add <remote> <url>`, not `project link <url>
--token`.

**What IS settled: the Overleaf onboarding line the CLI prints is wrong now.**
`cli/lib/fly/router.mjs` `docLinkDisplayLine` shows a human:

```
TLDA_TOKEN=<rw-token> tlda project link <project> <overleafUrl> \
  --main <file> --server <renderUrl> --token <overleafToken> --title <...> --poll <...>
```

- **`--token` is the tlda server RW token** — `cli/tlda.mjs:311`,
  `getFlag('token') || getRwToken()`. An Overleaf token there replaces the
  server auth token.
- **the URL lands in `documentRoots`** — `project link`'s usage says
  *"Positional paths are document roots"*; remotes go through
  `tlda project remote add <remote> <url>`.
- **`--poll` does not exist** — zero references, silently ignored.
- `--main` (`cli/tlda.mjs:633`) and `--title` are fine.

Small, reversible, and **not** what Skip asked for on 08-24 — it is recorded
here rather than fixed.

### 4. `mainFile` — Skip: "There is not supposed to be a main file"

Complete list committed at `scratch/mainfile-scope-2026-08-24.md`: **72 property
reads across 23 files**; ~170 further hits are locals that follow from them.

He also ruled on bucket 2: **"The second bucket also shouldn't exist"** — the 22
sites where a missing `mainFile` silently becomes `main.tex` or `index.md`.

**Three sites are done** (the commits above). What is left is not uniform, and
this is the part worth carrying:

- Some are **pure deletions** — an unreachable fallback whose caller always
  supplies the value.
- Some need a **parameter threaded from the client**: `history.mjs:295` is
  `/shadow/:hash7/lookup`, and there is no target in that URL at all. Removing
  `mainFile` there is an API change, not an edit.
- Some need a **design answer that is his**: `shadow-changelog.mjs:29` uses a
  single `primaryTexBase` to find one lookup file. Whether a changelog spans all
  roots is a product question. **I left it rather than half-change it.**
- `unified-server.mjs:4828`'s targets fallback is reachable only for projects
  with `pages=0` (never built) — 4 on the box, all probe fixtures. Deleting it
  turns a first-view build attempt into a 404. **Not obviously right; left.**

**The category table in the scope file is a grep heuristic and is not
authoritative** — `build-runner.mjs:2322` and `:2344` are false positives
(`targets: targetMeta.map(...)`, per-target and correct). Read each site.

#### The removal is four steps, not 72 edits — and step 3 is a six-line deletion

**`shared/document-roots.mjs` already is the single place that turns a project
into its roots, and it already contains the whole `mainFile` concept:**
`normalizeDocumentRoots` synthesizes one root from `mainFile` when the list is
empty. That is the entire compatibility bridge, in one function.

**Six files already go through it** — `cli/tlda.mjs`, `build-runner.mjs`,
`project-store.mjs`, `routes/projects.mjs`, `project-artifact-materializer.mjs`
(whose comment at `:318` explicitly says to use it *rather than*
`project.documentRoots`). **So the 72 sites are not 72 decisions; they are 72
places that bypassed the function that already exists.**

1. route the stragglers through `normalizeDocumentRoots` /
   `latexDocumentRootPaths` — behaviour-preserving, because the bridge still
   falls back to `mainFile`
2. **backfill `documentRoots`** for projects without it — measured, **8 of 21**
   LaTeX projects on the box have an empty list and **all 8 carry a complete
   `targets[]` with `{texBase, mainFile}`**, so the backfill is derivable rather
   than guesswork
3. delete the `mainFile` branch inside `normalizeDocumentRoots` — after step 2
   nothing reaches it
4. delete the field

Step 3 is the point; steps 1–2 exist to make it safe. This ends with `mainFile`
genuinely gone rather than 72 patched call sites, which is what he asked for:
*"The system has to be fucking simple. It has to be what I fucking specified."*

---

## Instrument notes, paid for tonight

- **`$?` after a pipeline is the pipe's exit.** I did it once. `${PIPESTATUS[0]}`
  is bash — **this shell is zsh**, where it is `$pipestatus` and the bash form
  expands to nothing, which prints an empty exit code that reads as success.
- **A confident `0` from a JSON query means check the shape first.** A count of
  lifecycle build states returned `0` because the records are under
  `j.revisionLifecycle`, not at the top level. The positive control found it.
- **`tsc -b --incremental false` in the shared checkout is the `--force`
  antipattern** — I started one and killed it.
- **Three eslint errors on `main` in `server/unified-server.mjs`** (657, 8773,
  8774, `tlda/await-fleet-store`) are **pre-existing, not anyone's current work**
  — verified by linting `git show main:server/unified-server.mjs` from a temp
  path inside the repo so the same config applies. Commit with `-o`.

  **And all three are FALSE POSITIVES — the rule fires on correct code.**
  `:657` assigns the promise to `durableWrite`, attaches `.catch`, and its own
  comment says lifecycle callers await it; `:8773`/`:8774` are inside a
  `queryPage:` arrow that **returns** the promise to a `.then`. So none of the
  three is a dropped promise.

  **That is why they have sat on `main` and why nobody runs lint.** `AGENTS.md`
  §"An instrument that answers…" states the consequence: *"a rule that fires on
  correct code gets disabled and then catches nothing."* This is that rule, in
  that state. **Do not "fix" the three call sites** — the rule needs to
  understand assignment-then-await and `return`, or it needs narrowing.

- **`no-undef` sweep, run and mostly negative — do not spend a morning on it.**
  `bin/` + `daemon/`: **3 errors, all in `daemon/git-sync-manager.test.mjs`**, 1
  file. `server/ shared/ cli/ mcp-server/`: **no real hits.** The 4 that appeared
  there were `'process' is not defined` and were **my own instrument artifact** —
  passing `--rule '{"no-undef":"error"}'` overrode the config that supplies node
  globals. Linting the same file without the override shows no `no-undef` at all.
  Positive control for the artifact: the override-free run still reports the
  three `await-fleet-store` errors, so the linter was working.
- **The `sourceLifecycleStore(name)` accessor needs the project store
  initialised**, so an ad-hoc `node -e` against it throws. Go through
  `createSourceLifecycleStore({ root, project })` to test that layer by hand.
- **Skip's Chrome had no tab on his paper project** — he was on the iPad
  (`machine: ipad165`). A CDP `Runtime.evaluate` against his one open tlda tab
  (`?project=ops`) timed out, most likely a backgrounded/frozen tab. Tunnel and
  target-list worked, so that is not an `air-agent` problem.

## Things I got wrong tonight, so they are not repeated

- **Led the first report with the 169 orphan shapes.** He does not care about
  shapes, said so in those words, and it cost a round trip.
- **Told him the frozen-part problem was live** before checking whether a fix
  had shipped. It had, two commits, both already deployed. Corrected in a new
  message rather than an amend.
- **Read six files with one timestamp as six user clicks.** They are one bulk
  operation.
- **Said "history never leaves the server" from a dead function.** The live path
  was `mirrorAcceptedRevision` and it was deleted two days later by a different
  commit. Right conclusion, wrong mechanism, and the mechanism is what the next
  person would have acted on.
- **Asked him to run nothing and told him nothing was waiting on him** — the one
  open question is the deploy A/B, and it is stated as an actual question with
  options.
