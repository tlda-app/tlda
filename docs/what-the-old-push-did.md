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

**What probably covers it, and why "probably" is not good enough.** The carrier
normalizes the manifest, and `normalizeSourceManifest` filters through
`isManagedSourcePath` — so a traversal path is dropped from the manifest rather
than accepted, and `carryForward` maps over the normalized manifest, so it never
reaches `acceptRevision`. The working-copy write iterates paths that came back
out of the git tree.

**But filtering and rejecting are not the same thing**, and nobody has checked
that the filter's coverage equals the validator's. A path that is silently
dropped is also a path whose absence the caller is never told about. **Do not
delete the validator on the strength of this paragraph** — establish the
equivalence, or call the validator from the accept.

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
