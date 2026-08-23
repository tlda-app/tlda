# What the old push did

`processProjectPushSerialized` — `server/routes/projects.mjs`, 523 lines — is
the path being deleted. This is an enumeration of **everything it does**, each
item checked against the new accept (`acceptSourceSnapshot` →
`bootstrap`/`submit` → `applyAcceptedSourceEffects`).

**It exists because five gaps were found by accident.** The working copy, the
client manifest, the edit event's line regions, the outbound Overleaf push and
`result.building` were each found when somebody happened to read a result back —
five out of an unknown denominator. A grep finds a call that is present; it can
never find one that is missing, so the only way to bound this is to list what
the old path does and check each item.

**This is the deletion commit's gate.** Nothing here marked **GAP** should be
deleted out from under.

Measured on `accept-path-daemon-push` at `6f90f72c2`. Re-run the checks at the
moment the deletion lands — this file is a disposition, and a disposition is
as of now.

---

## Has a counterpart on the new path

| what it does | where it is now |
|---|---|
| decode base64 or utf8 file content | `canonicalSnapshot` — the same function, reached directly |
| carry unchanged files forward by `{path, sha256}` | `lifecycle.carryForward`, then `canonicalSnapshot` |
| require the snapshot to cover the manifest exactly | `canonicalSnapshot`, unchanged |
| normalize the manifest | `acceptSourceSnapshot` — the carrier does it, so no caller has to sort |
| bootstrap vs submit routing on authority state | `acceptSourceSnapshot`, on `readAuthority().state` |
| commit the revision, move the ref | `persistSnapshot` + `advanceSourceHead`, unchanged |
| three-way merge and `evidence.classifications` on refusal | `submit`, unchanged — surfaced in the 409 |
| clean-rebase acceptance | `submit`, unchanged |
| `requestId`/`deliveryId` dedup and crash-safe replay | `acceptUnderOperationJournal`, both carriers |
| serialize per project | `runSerializedProjectSourceOperation`, unchanged |
| write the server's working copy | `applyAcceptedSourceEffects` |
| update the client source manifest | `applyAcceptedSourceEffects` |
| `session`, `sessionAt`, `lastEditedBy` metadata | `acceptSourceSnapshot` |
| replica fan-out to bound checkouts | `applyAcceptedSourceEffects` |
| mirror to the author's checkout | `applyAcceptedSourceEffects` |
| dispatch a build | `applyAcceptedSourceEffects` — **but see the build-decision gap** |
| clear sync conflicts and refusals on an accepted push | `applyAcceptedSourceEffects` |
| the source-edit event with line regions | `applyAcceptedSourceEffects`, regions derived from the trees |
| journal the accepted revision | `applyAcceptedSourceEffects` |
| replace a book's member set | moved to `PATCH /:name/members` `{members: [...]}` |

**`applyAcceptedSourceEffects` no longer exists.** As of `d6009b693` it is absent
from `server/`, `daemon/`, `bin/` and `shared/` entirely, so every row above
naming it points at a function that is gone. **Only the build row has been
re-checked** — see §2, which is where it went and what that changed. The other
rows are unverified as of this sha: the effect may have moved, or it may be a
gap nobody has noticed. Do not read them as current, and do not read them as
broken either. Re-check the one you need.

## Deliberately dropped

| what it does | why it does not come across |
|---|---|
| `beginProjectSourceTransaction` / `commit` / `rollback` | the accept is one ref move; there is no multi-step local mutation to unwind. What replaces it is `retractHead` — see `f0eda05b6` |
| `recoverProjectSourceTransactions` on entry | nothing writes those journals any more |
| `expectedRevision === undefined` → 428 | the base is structural. `null` and absent both reach `bootstrap`; there is no sentinel to disagree about |
| `observedServerFiles` / `observedSourceManifest` | a bootstrap-only reconciliation against files on disk. The git store compares trees |
| `sourceDir` in the request body | already dropped by the old destructure; every server use reads `project.sourceDir` from storage |
| `overleafRemote`, `overleafCommits` in the body | never consumed downstream |

---

## GAPS — on the new path, nothing does this

**Each one is stated as what a person would experience**, because that is the
only form in which "an effect is missing" is checkable.

### 1. Path validation is not called, and the coverage that replaces it is incidental

`validateSourcePushRequest` calls `validateSourceFilePath(name, filePath)` on
every pushed and deleted path. **The new path calls neither.**

`AGENTS.md` lists path containment as a real authority boundary that survives
this cut, so this is the most important row in this file.

**Measured, so the "probably" is now settled in both directions.** Four
adversarial paths pushed through `acceptSourceSnapshot` — `../escaped.tex`,
`sub/../../escaped.tex`, an absolute path, and `link/escaped.tex` where `link`
is a symlink out of the project:

| | result |
|---|---|
| anything written outside the project | **no, on all four** |
| the push's reported status | **200 on all four, no error** |

**So the gap is not an escape. It is silence.**

**Containment holds because the boundary is the WRITE, not the validator.**
`writeSourceFileAsync`, `deleteSourceFileAsync` and `readSourceFileAsync` each
resolve through `sourceFilePath()` → `resolveContainedPath()`, which realpaths
the nearest existing ancestor and throws. `validateSourceFilePath` **is that
same call with its result discarded** — an early, friendlier rejection of what
the writer refuses anyway. The two cannot drift apart because they are one
function.

**And normalization is NOT equivalent to validation** — that assumption was
wrong. `isManagedSourcePath` reasons about the *string*, so `link/paper.tex`
survives it looking like an ordinary relative path; only resolving the real path
catches it. A textual `../` is filtered, which is exactly why this looked like
coverage.

**What the missing validator actually costs:** a traversal path is filtered out
of the manifest and the push returns 200, or it reaches the working copy and the
write throws into a caught branch — and either way **the caller is told their
file landed.** The legitimate files in the same push do land, so nothing looks
wrong. A file that did not land, reported as landed, is the family this whole
cut exists to remove.

**The fix is to call `validateSourceFilePath` on every manifest and file path in
the accept and reject with the offending path named.** It is not built: Skip
ruled that the protocol is written up and put to him before anything else is
changed. **Do not delete the validator, and do not build this without that
ruling.**

### 2. The build fires unconditionally — and the old remedy is no longer available

**Re-measured 2026-08-23 against `d6009b693`.** The gap is still open. The fix
this section used to imply is no longer available, and reading it as *"so call
`shouldBuildOnPush` at the admit sites"* ships dropped pushes. It was briefed
that way once already.

**The new path dispatches on every accept** — `shouldBuildOnPush` still has no
production caller at all, only tests and this file.

#### The list of suppression cases this section used to give was wrong

It is corrected rather than deleted, because implementing the old list inverts
the function's own stated direction. What the code actually returns:

| verdict | fires when | build? |
|---|---|---|
| `already-building` | SVG **and `pages === 0`** and a build is in flight | no |
| `unchanged` | nothing changed on disk **and** the lifecycle projection is `ready` | no |
| `outside-tree` | SVG, files changed, none matches `relevant-files.json` | no |
| `relevant-files-parse-failed` | `relevant-files.json` is unreadable | **yes** |
| `no-relevant-files-yet` | no `relevant-files.json` on disk | yes |
| `initial-svg-build`, `format-eager`, `svg-eager` | otherwise | yes |

Two of those were listed as suppressions and are not.
`relevant-files-parse-failed` **builds** — it is the catch branch, and skipping
on it would skip the render in exactly the case where we could not tell whether
the render's inputs changed. And `already-building` is not a general in-flight
suppressor: it is gated on `pages === 0`, a brand-new SVG project that has never
built, so **on a mature project it can never fire.** Adopting it as a general one
would be new behaviour, not a restoration.

**So on a mature SVG project the only suppression that can ever fire is
`outside-tree`.**

#### Why you cannot simply call it

**On this path the build is not a downstream effect of the accept. It is the
accept.** `publishBuildInstance`, the publish step at the end of a build, is the
only place in the tree that does either of these:

- renames the build instance's `source/` over the project's live `source/` —
  `PUBLISH_REPLACED_ITEMS` is `['source', 'output', 'build-cache', 'build.log',
  'latex.log']`
- calls `git.advanceHead`, moving the project's source head to the built
  revision

`advanceHead` has **exactly one production caller** and that is it; its
definition is in `source-git-store.mjs` and every other hit in the tree is a
test. `publishBuildInstance` in turn has exactly one caller — the build worker,
over the worker RPC relay — so it runs only inside a build that actually ran.

So a suppressed build is a suppressed *accept*: the revision stays a proposal
ref that never becomes head, its files never reach the server's source tree, and
the pusher gets a 200. **That is the same "told their file landed when it did
not" family as §1**, reached from the other side. This holds for `outside-tree`
too — narrowing the change to the one verdict that can fire does not make
suppressing it at the admit site safe.

This fusion is the durable-queue design rather than an accident. `advanceHead`
entered the dispatcher in `fa3f3874c` "Implement durable daemon build queue", and
`4a3f6b139` "Publish source and revision status atomically" is what made the
source publish atomic with the head move.

**Getting the benefit therefore requires a way to publish source and advance the
head without a render**, which does not exist today — the revision must still
stage `source/` and move the head, with only the render skipped.

#### What a person sees, corrected

*Still real:* on a continuously edited project, renders run back to back —
every completion starts the next queued revision, including revisions whose
changes the render never reads.

*No longer real:* the "queue that can stack builds" claim, which fails twice
over. `already-building` never suppressed on a mature project in the first
place, per the table above, so its absence explains nothing. And the durable
queue coalesces on its own — `thinPending` kills any pending revision that is an
ancestor of another pending one, as `superseded`, and `killNeedingRebase` kills
pending or running work that is not a descendant of the new head. In a linear
edit sequence that leaves at most one running plus one pending per project, and
it keeps the *newest* revision where the filter would have refused it.

#### A filter that always says yes is indistinguishable from a filter nobody wired in

**This gap was open for as long as it was because there is no difference, from
outside, between the two.** `shouldBuildOnPush` existed, was tested, was correct,
and was never called — and what a person saw was a render on every push, which
is exactly what they would have seen from a filter that was called and always
returned yes.

It came up twice more while closing it, both times as a live failure mode rather
than a historical one:

- The decision reads `relevant-files.json` from `outputDir(name)`. Run it after
  `setProjectPathOverride` and that resolves to the build instance's own empty
  `output/`, so the verdict is `no-relevant-files-yet` — **rendering every time,
  forever, with the filter fully wired in.**
- The decision errs toward rendering when it cannot be computed, which is right.
  But erring toward rendering on *every* build, silently, is the same
  indistinguishable state. That path now logs.

**So when a filter's safe direction is also its do-nothing direction, it must say
when it takes it.** Otherwise the thing you built and the thing you forgot to
build produce identical evidence, and no amount of testing the function
distinguishes them — the function was never the part that was broken.

This is §"A negative result is only evidence once the instrument can produce a
positive" in `AGENTS.md`, pointed at a decision rather than a measurement. The
same check applies: make it take the other branch on purpose and confirm you can
see that it did.

#### The phase records are still missing

`recordRevisionPhase(..., 'build', 'not_required' | 'superseded')` and the paired
`'version', 'not_reached'` are still unwritten, and the mechanism is worth
naming because a grep for the strings does not show it: the queue settles killed
work through `recordDisposition`, and `createDispatcherWithOptions` never passes
one, so it is the `async () => {}` default. A build killed as `superseded` or
`needs-rebase` therefore records no phase at all. `not_required` survives only as
a value `source-lifecycle.mjs` knows how to interpret — nothing produces it.

### 3. Book parts are never refreshed

`refreshMaterializedPartsFromChangedSources`, `rebuildProjectPartsView` and
`broadcastProjectPartsChanged` have no counterpart.

*What a person sees:* on a book project, editing a chapter leaves the parts
view showing the previous content, with no error.

### 4. A refusal records nothing, so a stuck person leaves no trace

On failure the old path calls `recordSourceSyncConflicts` and
`recordSourceSyncRefusal`. The new 409 returns evidence to **the caller** and
records nothing.

The old code says why this matters, from a real incident on 2026-08-13: *"a
person stuck outside the paper left no trace: the pusher learned from their HTTP
status and nobody else learned ever."*

### 5. A refused revision is not mirrored, so its author cannot see it

The old path mirrors on refusal specifically so a stuck author can look at the
work that did not land — and its comment explains why riding the next accepted
push fails: *"a stalemate is a run of refusals with no accept between them, so a
refused revision waiting for an accept to carry it would wait forever."*

The new path marks `refs/tlda/refused/<project>` and mirrors only on accept.

### 6. `doc-arrived` is not emitted after a push-driven build

The old path emits it inline after a successful eager dispatch
(`projects.mjs:1931`). The new path does not.

**Stated narrowly on purpose.** There is a second emitter —
`emitDocArrived` in `build-runner.mjs` — so the event is not gone from the
system. But its only caller is `ensure.mjs`, which is the ensure/rebuild path,
**not** the push path. So a build triggered by somebody saving does not announce
itself, while one triggered by `ensure` still does.

*What a person sees:* a document that finishes building after their own edit
does not announce itself, and one that arrives by another route does — which is
harder to notice than a feature being uniformly absent.

### 7. Deletes are not checked for client ownership

The old path skips a deletion unless `isClientOwnedSourcePath`. The new path
deletes any path absent from the manifest.

This interacts with deletion-by-omission: on the new path an absent path is an
**instruction** to delete, where the old path's omission was passive. Any
manifest crossing onto the new accept must be complete for that reason.

### 8. Outbound Git-remote push

Carried by the Git-backed daemon rather than by a server accept effect. The
daemon fetches first and pushes only when the remote head is an ancestor of the
exact accepted revision it just mirrored. Divergence is reconciled and proposed
through the ordinary source path; unresolved or stale state is withheld. The
server therefore never prepares, publishes, rolls back, or force-pushes a remote
head.

---

---

## What an accept costs, measured

**Nobody chose this and nobody has said it is acceptable.** Recorded here
because a measurement is a timestamp rather than a state — these are the
conditions, not a property of the code forever.

**Nine subprocess spawns per two-file accept: 8 `git`, 1 `rm`.**

| condition | time per accept |
|---|---|
| sequential, load average ~22–35 | **3.0–4.5s** |
| six concurrent accepts, same box | **8–9s** |

**Flat in file count** — 1, 2 and 4 files all measured the same, so the cost is
per-accept rather than per-file.

**This is what produced the "intermittent hang" that stopped the line.** A repro
with a 10-second deadline timed out on ~half of its runs; the identical build
with a 60-second deadline completed 6 of 6 in 8–9 seconds. A deadlock does not
complete when you wait longer. Instrumenting the spawn helper to log `exit` and
`close` separately showed the stuck child had emitted **neither** — it was still
running when the clock fired, not exited with a pipe held open.

**Why it matters past a test deadline:** the source editor writes on a debounce,
the daemon flushes on a watcher, and `tlda push` is a command someone waits on.
A save that takes four seconds idle and nine under load is user-visible, on the
surface Skip writes his paper on.

**One obvious piece, not the whole of it:** `run('rm', ['-f', indexFile])` in
`buildTree`'s cleanup spawns a whole subprocess to delete a temp file that
`fs.rm` handles in-process — 1 of the 9.

**And the comparison nobody can make yet:** whether this is faster or slower
than the path it replaces is **not established**. The old path did a different
amount of work, so "it was always slow" is not a defence and is not asserted
here.

## The check that found the last one, and the one to keep using

`result.building` was missing from the CLI's own reads and **invisible at every
call site**, because it lives inside a helper the sites hand their result to. A
search for field names people thought could matter found nothing; enumerating
every read of the response body against the actual response body found three.

> **List every read against the actual body. Do not reason about which ones
> matter.**

The same shape produced this file: `applyAcceptedSourceEffects` reports what it
**ran**, not what was requested, so a caller reading a field that used to
describe an intention now reads one that describes an outcome — and the two
agree until they do not.
