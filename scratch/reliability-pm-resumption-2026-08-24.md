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

## The one thing blocking everything: the deploy

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
and `daemon/git-project-sync.test.mjs` passes today (exit 0).
`daemon/git-sync-manager.test.mjs` did not finish inside a 2-minute bound when
run alone; **that is unresolved, not a claim that it hangs.**

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
- **Three eslint errors on `main` in `server/unified-server.mjs`** (657, 8772,
  8773, `tlda/await-fleet-store`) are **pre-existing, not anyone's current work**
  — verified by linting `git show main:server/unified-server.mjs` from a temp
  path inside the repo so the same config applies. Commit with `-o`.
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
