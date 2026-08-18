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

### 2. The build fires unconditionally

The old path asks `shouldBuildOnPush` and suppresses the build for
`unchanged`, `outside-tree`, `already-building` and
`relevant-files-parse-failed`. **The new path dispatches on every accept.**

*What a person sees:* builds on pushes that changed nothing relevant, and —
because `already-building` no longer suppresses — a queue that can stack builds
on a project being edited continuously. That is a load problem on a machine
this fleet has already taken down once.

It also drops `recordRevisionPhase(..., 'build', 'not_required' | 'superseded')`
and the paired `'version', 'not_reached'`, so a revision that correctly did not
build now has no phase record saying so.

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

### 8. Outbound Overleaf push — and it is NOT a seventh effect

`prepareSourcePushToOverleaf` has one production caller and it is inside the old
function.

**Do not bolt it onto the effects list.** It prepares a remote push and the
transaction decides whether to publish or unwind it —
`previousRemoteHead`, `proposedRemoteHead`, `remoteBranch`,
`originalLocalHead`, and `restoreRemote()` on failure. Run from the effects list
it would fire **after the accept is already irreversible, with nothing left that
can unwind a remote head**, so a failed publish becomes unrecoverable rather
than rolled back. This is Overleaf-repoint work.

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
