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

**This is NOT the ref split.** Both bindings always had separate chains, in
separate repositories. What changed is that the browser leg now actually
submits, so both are live at once for the first time. **The room fix made a
pre-existing gap reachable.**

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
