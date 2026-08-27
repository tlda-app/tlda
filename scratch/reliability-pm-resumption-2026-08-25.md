# reliability-pm resumption, 2026-08-25 ~08:00Z

Force-added because it is a **resumption point, not a report** — the next
session works *from* this, and `scratch/` is gitignored. See `AGENTS.md`
§"Repository workflow".

The design is in `docs/the-sync-model.md`, which is tracked and is the thing to
read first. This file is only what is *not* in the code or the commits.

## DONE 2026-08-26: builds stream their output, and a silent build loses its slot

`fcb4400bd`, on `main`, **not deployed** — the chief owns the release path and
none is awake. Typecheck and lint clean; the build-queue tests pass.

**The fault.** A slot came back only when the worker process *exited*, with no
bound anywhere. A worker suspended in state `T` held one for 34 minutes. An
in-process timeout can never catch this — a suspended worker's timers are
suspended too, which is why `timeout: 120000` on every command in
`build-runner.mjs` never fired. The bound is now held by the parent.

**Silence, not duration, and that is Skip's constraint not a preference.** He
put it directly: a tex build should take *"ten fifteen seconds"* while a large
qmd render legitimately runs minutes, so no wall-clock number separates slow
from stuck. His answer: *"the idea that we're not streaming updates is, like,
it's stupid. I mean, we can watch the tex build ... happening in standard out."*

**Nothing had to be invented, which is the part to keep.** `exec` buffers stdout
and hands it over only when the command ends, so TeX narrates the whole build
into a buffer opened after it is over. And **both ends of the wire to carry it
already existed and were both dead** — `sendReport` in the worker was defined and
never called; `relayMessage` discarded `t: 'report'` outright.

**Deliberately NOT a method on the existing build reporter.** That reporter
*stages* its calls and ships them in one lump at publish, which is correct for
shape writes that must not land early and exactly wrong for output. Putting
output on it would have reproduced the silence it exists to end.

**A stall settles as `failed`, never `killed`** — killed is for something
somebody asked to stop. The revision is proposed again, safe because sync
re-derives.

Threshold: `buildStallTimeoutMs`, default **90s**, `0` disables. It is in the
closed config allow-list, so it is settable.

### TWO TESTS ON `main` THAT CANNOT RUN

Both call methods that do not exist, so they throw before their first assertion
and have been protecting nothing.

- **`bin/a-second-build-slot-that-exists-test.mjs`** — called
  `queue.dispatchBuild`, the *dispatcher's* verb, against the *queue* object.
  **Fixed in `fcb4400bd`; it passes now.** This is the guard on the `k >= 2`
  correctness bound, so that bound has never actually been checked.
- **`server/lib/build-instance.test.mjs`** — calls `lifecycle.bootstrap`, which
  exists nowhere in the lifecycle store. **Still red, not mine, untouched.** It
  imports only `build-instance.mjs` and `project-store.mjs`, neither of which
  this work changed.

**Worth a sweep nobody has done:** these two were found by running build-related
tests one at a time. Nothing runs them together, so a test that throws on line
one is indistinguishable from one that passes.

## `buildMaxConcurrency: 1` IS NOT IN EFFECT AND KEEPS REVERTING

Skip, 2026-08-26 ~01:4xZ: *"I feel like we went to one build process because we
were getting lockups. When we had two, but now we're getting build lockups when
we have one."*

**He is right that it was set and wrong that it is set now.** Checked on the live
box: `buildMaxConcurrency` is absent from **every** deployment's `server.yaml` —
`live`, `stable`, `pic`, `rc`, `talk`, `pic-dev`, `overleaf-test`. It falls back
to the code default in `shared/config.mjs:376`, which is **2**. Two build workers
were observed running concurrently tonight, so this is behaviour, not a config
reading.

**Why it reverts:** `scratch/chief-bhief-4-resumption.md:562` records it applied
*"live, no deploy"* — edited inside the running container. That file ships in the
image, so **every deploy overwrites it**, and it was never committed. My own
2026-08-24 note already recorded it as absent; the two notes look contradictory
and are both true at their own times.

**Do not simply put the 1 back.** The slot is released **only in `onExit`**, so
the count decides the blast radius rather than preventing the wedge:

- **2 slots** — one stuck worker halves throughput; builds go slow; the app stays
  usable. That is what tonight looked like.
- **1 slot** — one stuck worker stops **every build on the server**, permanently,
  until restart.

**Lowering it makes each lockup total instead of partial.** Proposed to Skip
instead: release the slot on lack of progress rather than on exit, mark that
submission failed, and let the revision be re-proposed — which is safe because
sync re-derives. **Not written. Waiting on his ruling and on what the threshold
should be**, since a legitimate build on that box runs for minutes.

## DONE 2026-08-26: documents are computed from the branch, and tex figures are members

Two commits, both on `main`, **neither deployed**.

### `7f975b8e6` — a project's documents are the include graph's roots

Skip specified it in three messages: *"document roots is just a computed
property of the git branch"*, *"create the directed include graph. roots are
roots"*, *"xr = link"*. Also, flatly: **"THERE IS NO FUCKING PRIMARY ANYTHING."**

`server/lib/document-roots.mjs` computes it from `git ls-files` — the branch,
not a directory walk, so build output and editor scratch are not documents.
**One rule for every format**: a node with no incoming include edge. I had
written a `\documentclass` predicate first and deleted it; it was a second rule
for the same thing.

**`\externaldocument` is not an edge, and that is the test that matters.** Two
papers cross-referencing each other would otherwise form a cycle with nothing
pointing in from outside — **zero roots, every document in the project gone at
once.** Verified rather than assumed: `scanTexDeps` collects eight edge kinds
and xr is not among them. Counterfactualled — adding xr as an edge turns that
test red.

**The endpoint is in: `264cc42c9`.** `GET /api/projects/:name/document-roots`,
computed per request. Read-only and additive — the stored field still exists and
is still what everything reads.

**Roots get in two ways, and neither recomputes:** positional arguments to
`tlda project link <name> <root> [root ...]` (**not** `--root`; Skip corrected me
on that), and `adoptClickedFileAsDocumentRoot`, which stages a clicked chat file
with `git add` through the daemon and appends it. `b4522bde2` fixed that path
appending `format: 'markdown'` **literally, for whatever was clicked** — a `.tex`
adopted as a root was recorded as markdown, which then selected the markdown
closure and lost its figures by a second, independent route.

### The graph nearly shipped unable to run on the server — `9da9ef24c`

I wrote it to call `git ls-files`. **`projects/<name>/source` is a materialized
directory, not a git work tree.** Measured on the box: `git rev-parse` says "not
a git repository", `ls-files` lists nothing. It would have answered **"this
project has no documents"** on the one machine that serves them, silently,
because an empty list is an ordinary result.

Split into `documentRootsIn(files, read)` — the graph — plus adapters.
`projectDocumentRoots(name)` walks the materialized tree;
`computeDocumentRoots(sourceDir)` uses `ls-files` where a checkout exists. The
markdown scan no longer takes a mounted path either, so the graph cannot answer
differently depending on where the tree lives.

**`projectDocumentRoots` deliberately does NOT filter through `listSourceFiles`**,
which applies membership. Membership is roots plus closure, so filtering the
input to the thing that determines roots is circular — a document not already a
member could never become one.

### Why `source/` is not git: historic, not designed

Skip, 2026-08-26: *"nothing was git until recently"* / *"so prob just historic
junk"*. `source/` is the original design — files in a directory — and the
per-project repo was added **beside** it rather than under it. Nothing does
`git init` there because nothing ever converted it.

**So making `source/` a real work tree of the repo already next to it is a
cleanup, not a redesign, and it deletes this whole class:** the server would stop
walking a directory and hoping it matches the branch, because it would be the
branch. **Not attempted** — it touches every write path into `source/`, and what
still expects a plain directory has not been established.

**Still to do:** point the call sites at the endpoint, then delete the stored
field.

### `f159432a6` — a tex document's figures are members of its project

Traced at the chief's request, after a reproduced build losing unchanged tex
figures.

**Membership closed over references for markdown only.** Both `withReferencedRoots`
(CLI link) and `sourceMembershipContext` (server) tested the extension and
`continue`d on anything not `.md`, so **a `.tex` root dragged in nothing**. The
push path has always walked `scanTexDependencyClosure`, so the two sides
disagreed about what a tex document is made of — and the disagreeing side is the
one that decides membership.

**Figures specifically**, because a `.png`/`.pdf` is reached by exactly one edge,
`\includegraphics`. So the traversal never running on tex roots loses precisely
the figures while the `.tex` and `.bib` arrive by other means.

**Counterfactual:** with the old guard, `referencedRoots` came back as exactly
`['main.tex']` — the seed and nothing else.

**`referencedSourcePaths` is chat/part metadata and was NEVER the carrier for
figure dependencies.** Empty is correct behaviour there. Do not look for figures
in it; `app-librarian` reached the same conclusion independently.

**Left for the chief to rule on, deliberately:** `collectProjectSourceHashes` in
the same file still gates on `format === 'markdown'`. Same disease, but it
decides what counts as *changed*, so widening it is not a membership fix.

### THE SUITE IS RED AND NOBODY RUNS IT — measured 2026-08-26

**`npm test` on `main`: 323 passed, 62 failed, 18 timed out, 403 total. Exit
code 1.** Not a sample — every file the runner discovers, run once. Complete
list of all 80 by name was written to
`scratchpad/suite-report.md` at the time; regenerate with `npm test` rather than
trusting that file, which is not tracked.

**It is not that the gate cannot fail.** `bin/run-test-suite.mjs` sets
`process.exitCode = 1` and did. I reported the opposite for an hour because I
ended my shell command with an `echo` and read the echo's status — the third
exit-code misread of the night, which makes it a pattern and not an accident.

**15 of the 62 are one class: tests calling an API deleted on 2026-08-20.**
`f6d0f9089` "Delete parallel server source authority" removed `bootstrap`,
`submit`, `readAuthority`, `prepareOperation` and `acceptBundle`; **none is
defined anywhere in non-test code now.** The tests were left behind and throw on
their first line.

**They cannot be ported, and this is the part that decides what to do.** The
lifecycle store today is **read-and-record only** — `isAncestor`, `readRevision`,
`readRevisionFile`, `readCurrentFile`, `listRevisionLifecycles`,
`recordRevisionAdmission`, `recordRevisionPhase`. **There is no way to create a
revision through it at all.** That responsibility moved to git: revisions arrive
as pushed proposal refs and are taken by `admitProposal`. So these need
rewriting against a different mechanism, not renaming.

**What is unguarded, in the tests' own words:** a bootstrap does not repeat over
real history · a commit per accepted push · a ref that does not outrun its
record · a refusal that names what differed · a retry that lands once · an
accept the daemon is never told about · one file out of a big book · replica
command not retained · source restart mid-edit.

**Those are the modes that lose an edit or accept one twice**, on the path that
takes Skip's pushes, and nothing checks any of them.

**Put to Skip, not decided here:** delete them — one commit that makes a hidden
gap visible — or rewrite against the git path, which is real work. It is his
data path, so it is his call.

### THREE tests on `main` throw before their first assertion

All call methods that no longer exist, so they protect nothing while looking
green-adjacent. **Nothing runs the suite together**, which is why they survive.

| test | calls | state |
|---|---|---|
| `bin/a-second-build-slot-that-exists-test.mjs` | `queue.dispatchBuild` | **fixed** in `fcb4400bd` |
| `server/lib/build-instance.test.mjs` | `lifecycle.bootstrap` | still red, not mine |
| `server/lib/source-lifecycle.test.mjs` | `store.prepareOperation` — **zero** non-test files define it | still red, not mine |

## A DEPLOY LOOKS EXACTLY LIKE AN OUTAGE FROM OUTSIDE. CHECK THE VERSION FIRST

2026-08-26 01:49–02:15Z: three deploys landed back to back — machine versions
**1316 → 1317 → 1318**. Each replaces the machine, so the `.ts.net` name stops
answering for about a minute and `curl` returns **HTTP 000**, identical to the
tailnet outage an hour earlier.

**How to tell them apart in one command**, before diagnosing anything:

```sh
fly status -a tldraw-sync-skip | grep '^ app'   # VERSION bumped => a deploy
```

A bumped version and a fresh `LAST UPDATED` is a deploy. An unchanged version
with the box up for a while is a real fault.

**And check whether the failure is at YOUR end.** During that window the fleet
log showed the app perfectly healthy — event-loop lag ~25ms, agents connecting,
my own MCP reconnecting — while my `curl` returned 000. The server was fine and
the request was not reaching it. Retrying three times returned 200 each time.

**Nothing was lost across any of the three.** The demo was writing throughout;
two edits missed their windows and both arrived afterwards, at **148s** and
**421s**. The daemon retried and they landed intact — idempotence doing its job.

**The demo reported the deploys honestly** rather than papering over them:
`pages 3/4 BROKEN` with zero-byte responses while the machine was being
replaced, and `nothing admitted since this edit` on the leg that missed.

## THE LOCKOUT CHAIN: what happens when two people edit one document

**Established step by step on a disposable project, 2026-08-26, against the
deployed build. Not inferred.** This is the central sync failure and every link
in it is silent.

1. **Someone edits in the browser.** The revision publishes; the project head
   moves.
2. **The other person's daemon PARKS it and does not move their branch.**
   Deliberate, and written in `git-project-sync.mjs`: *"The accepted revision is
   PARKED, not applied … the person can see it, diff it, and merge it whenever
   they choose."* It exists because it used to force-checkout and merge into
   people's trees and wreck them.
3. **Their branch is now not an ancestor of the head**, so every edit is
   rejected — `proposal not accepted: WrongHead`, on repeat in the daemon log.
   **Local editing has stopped syncing, permanently, with no signal.**
4. **The remedy the design assumes is a manual merge. It CONFLICTS** —
   `CONFLICT (content): Merge conflict in paper.tex` — because both sides edited
   the same file, which is the whole point of the feature.
5. **A conflicted checkout silently halts ALL settling** (see the section on
   that). So the documented way out of 3 lands somewhere worse.

**No single link is a bug.** Parking is right in isolation, the WrongHead
refusal is right in isolation, the conflict is honest. What is missing is that
**nothing ever says "your edits are no longer syncing"**, and the way out is a
manual merge of a conflict nobody knows exists.

**`de356e277` should remove step 1's cause** — once the editor is a normal
checkout on the project branch it publishes on the same lineage, so the head
moves in a way the other branch can descend from. **NOT PROVEN END TO END.** It
is not deployed, and the honest statement is that the mechanism above is
measured while the fix is not.

**How it was found:** the demo could not reach this state until it wrote all
three routes **concurrently into one document**. Serial-and-same-file still
never overlapped in time. Skip: *"not that you can AVOID TESTING THE STUFF
THAT'S ACTUALLY HARD"*.

### THE REPAIR UNIT IS THE DIRECTORY, NOT THE BINDING

Read-only audit, all 129 testing bindings grouped by canonical realpath → **113
distinct directories**, each classified by its **worst** binding:

| | directories |
|---|---|
| **DIVERGED** | **11** |
| never-synced (no server head) | 10 |
| no-project (server 404) | 21 |
| missing directory | 34 |
| safe | 37 |

**9 directories carry more than one binding, and 3 of those contain a DIVERGED
one.** So a "safe" binding can share a working tree with a diverged binding, and
repairing it is not isolated: relink moves the branch and the tree the other
binding also sits on. A per-binding loop touches such a directory more than once
and can act on a tree it has already invalidated.

**So: a directory is repairable only if EVERY binding in it is safe.** That also
removes the ordering problem rather than managing it.

**And 55 of 113 directories are debris** — 34 gone, 21 naming projects the server
404s. Nearly half the bindings file. Any two people counting "repairable" will
disagree until they say how much debris they are counting; that was the whole of
the 40-vs-35 argument.

### THE REPAIRABLE SET IS 1, NOT 35 — and two reasons nobody had looked at

Re-evaluating the 35 "safe" candidates at action time:

| | count |
|---|---|
| project returns **HTTP 404** — it does not exist on the server | **16** |
| project exists but declares **no documentRoots** | **18** |
| project exists with roots that can be passed back unchanged | **1** |

**My classification error, recorded so nobody inherits it.** I called those 16
*safe* on the reasoning "the server has no head, so there is nothing to diverge
from". **A 404 is not "no head", it is "no project".** Those are stale bindings
pointing at projects that are gone — cleanup, not repair. Distinguish *asked and
got no head* from *asked and got no project*; they are one HTTP status apart and
mean opposite things.

**And the hazard that stops the other 18.** `tlda project link` takes document
roots **POSITIONALLY**. There is no relink-in-place that preserves them. So
relinking a project that declares none means **choosing** roots and writing them
into its record — inventing exactly the stored declaration that caused every
document-loss bug in this file. **Do not do that per-project to get a repair
through.** It reads as a gap in the verb, not something to work around.

### WHAT RELINK ACTUALLY DOES, measured on disposable projects

**Safe class — it repairs, and the repair is verifiable.** Throwaway put in the
exact precondition (off its work branch, no edits, tip an ancestor):

```
before   branch=main            tip IS an ancestor
after    branch=tlda/sync-safe  clean   tip IS an ancestor   → repaired
```

**Diverged class — it reports success and leaves the checkout broken:**

```
Submitted ab7fba3 through the daemon Git remote      <- reported success
after: on its branch, clean, tip is NOT an ancestor  <- still cannot sync
```

**So the post-check is the only thing that separates them** — the command prints
`Submitted` either way. Repairing without re-testing ancestry afterwards
produces a report of a fixed checkout that still cannot push.

**A trap that nearly produced a false conclusion:** run from the wrong
directory, `tlda project link` fails with *"already has version history on this
server; adopting another copy is a different operation"*. That is the guard
working correctly — refusing to adopt a **different copy** — not evidence that
relink is broken for projects with history. **Run it from inside the bound
checkout**, and check `Source:` in its output before believing any result.

### SIX OF SKIP'S CHECKOUTS ARE ALREADY IN THIS STATE — swept 2026-08-26

Read-only sweep of the 49 bindings under `~/work` in `testing`:

| class | count |
|---|---|
| **safe** — off their work branch but the tip can still fast-forward | **35** |
| **DIVERGED — cannot sync, relink will not fix** | **6** |
| binding points at a directory that no longer exists | 6 |
| already on their work branch | 2 |

**The discriminator is exact and cheap: is the checkout's tip an ANCESTOR of the
project head?** Yes → it can catch up, relink is safe. No → the lineages have
split and there is no automatic way back. Where the daemon had never fetched a
head locally, ask the server for `source-head` and test against that; where the
server has no head at all there is nothing to diverge from.

**Two of the six are Skip's own working documents and one is the shared `tlda`
checkout itself.** Names are deliberately not in this file — the rule is that
his projects are not named in a message or a file to anyone but him. The
classification travels as shas.

**Nothing was relinked and nothing should be.** Relink is unsafe on a diverged
checkout and can report `Submitted` while doing nothing. Recovery for a diverged
checkout is unsolved; work it out on a copy first.

### It takes ONE browser edit on a brand-new project — reproduced in 4 minutes

Not accumulated damage. On `sync-trio`, created minutes earlier, disk and
browser writing the same document concurrently:

```
cycle 1   disk 9.2s      browser 8.0s     both landed
cycle 2   disk NEVER     browser 0.4s

daemon:   sync-trio: announced a1f9f51, fetched 0820202
          sync-trio: proposal not accepted: WrongHead
server head 08202028364c   local tip e277177bd5a8   NOT an ancestor
```

**Cycle one works, cycle two the disk collaborator is finished.** That is the
whole lifetime of a collaboration: one edit each.

**Standing reproduction:** `sync-trio` with the demo running all three routes
concurrently. `sync-watch` is left in the diverged state as evidence and cannot
recover — relink does not fix a diverged checkout, only a fresh project does.

**Do not read the remote leg's `remote pull` failures as part of this.** Measured:
that is the demo's own remote leg racing its own disk leg — a pull refuses while
a local edit is uncommitted, which is ordinary git. The checkout is clean between
cycles. It is a real thing two people can hit; it is not the lockout.

## THE DEMO NEEDS `--watch` OR IT RUNS THREE CYCLES AND EXITS

`const CYCLES = Number(valueOf('--cycles', has('--watch') ? Infinity : 3))`.

**Without `--watch` it stops after about six minutes.** I restarted it six times
across one night without the flag, found it stopped each time, and each time
read that as a crash or an outage. It is the documented default and my own timer
brief carries the correct command; I dropped the flag from it every time.

The command, in full, which is the one to paste:

```sh
node bin/sync-demo.mjs --project sync-watch --legs disk,remote \
  --file paper.tex --remote-file notes.md \
  --checkout ~/worktrees/sync-watch --fixtures ~/worktrees/sync-watch-fixtures \
  --watch --every 120000 --timeout 240000
```

**`--fixtures` is not optional either** — omit it and the bare remote is created
*inside* the synced checkout, where it becomes project content. That now refuses
rather than running (`01b5656b6`).

**Healthy baseline, 2026-08-26 00:5x–01:3xZ, 13 cycles:** disk **8.5–12s**,
remote **8.5–11.2s**, 4/4 pages every cycle, checkout clean throughout. One late
arrival in thirteen cycles and **nothing lost**.

**That one late arrival is explained and is NOT a product fault** — worth writing
down because it looks like the worst case in the file. `SYNCDEMO-45677` was given
up on at 240s and arrived **421s later**, an 11-minute edit. The daemon log for
that window shows `git push ... 502` at **00:45:15Z**, inside the tailnet
recovery, with the next admission at **00:57:08Z**. The server was briefly
unreachable, the daemon retried, and the edit landed intact. **A retry that
recovers with no loss is the idempotence property working**, not a defect —
resist reading the 11 minutes as a latency finding.

**24 `source-proposal-admit` timeouts across the night** for this project. That
one is still a real open fault; it is just not what produced the 11 minutes.

## LIVE, 2026-08-25 23:40Z: THE BOX IS OFF THE TAILNET. The app is fine

**Symptom:** `tlda-fly.cormorant-matrix.ts.net` resolves to nothing, the fleet
transport fails (`fleet WS request was not accepted before deadline`), and no
agent can chat. It looks like a total outage.

**It is not the app.** Asked directly on the machine over Fly's private network:
`{"ok":true,"fleet":"embedded","store":"up"}`. Event-loop lag mean 22ms. The
funnel config is intact and still proxies `/` to `127.0.0.1:5176`.

**It is the tailnet node.** `tailscale status` reports `tlda-fly ... offline` and
*"You are logged out. The last login error was: invalid key: API key does not
exist"*, first logged **23:40:18Z**, retrying every ~35s forever.

**Not an expiry — a revoked key.** Corrected by `sol-dev`, who checked the
tailnet: **device expiry is disabled** on that node. The Fly secret `TS_AUTHKEY`
holds an auth key that has been **deleted or revoked**, which is what `API key
does not exist` means. I originally wrote "expired" here and it was wrong.

**And the entrypoint re-applies the dead key on every boot, fail-soft.**
`scripts/fly-entrypoint-live.sh:81`:

```sh
tailscale ... up --authkey="$TS_AUTHKEY" --hostname="${TS_HOSTNAME:-tlda-fly}" ... \
  || echo "[entrypoint] tailscale up failed — continuing (public stays up)"
```

So a dead key does not stop the machine — **the app comes up perfectly with no
tailnet name, and the only signal is one echo line in the entrypoint log.** That
is why this presents as a total outage of a completely healthy server.

**CORRECTION, measured 2026-08-26 01:49Z: it does NOT break on every restart, and
I told Skip it would.** The box was redeployed (version 1316 → 1317, up 1 min)
and came back **authenticated** — `tailscale status` shows `tlda-fly ...
davidahirshberg@`, no logged-out error. The reason: `tailscaled --state` persists
to `$PERSIST/tailscale/tailscaled.state`, Skip's manual login wrote a valid node
key there, and `tailscale up --authkey=<dead>` fail-softs **without clobbering
the good state**.

**What would still lose it:** a fresh machine, or anything that wipes that
volume — the persisted state is the only thing holding the login, and the stored
secret is still dead. So replacing `TS_AUTHKEY` is still worth doing, but it is
not the standing per-restart hazard I described.

**Recovery needs Skip and only Skip:** a Tailscale login click, or a fresh
`TS_AUTHKEY`. Neither is mintable from here. Generate a fresh URL with
`fly ssh console -a tldraw-sync-skip -C "sh -c 'tailscale login --timeout=30s'"`
— the printed URL is short-lived, so make a new one rather than reusing an old.
**Skip cleared it that way at ~00:5xZ on 08-26 and the fleet came straight back.**

**The instrument trap in this, and I nearly restarted his machine on it:**
probing the app from inside the box with `wget` returned nothing, on every port,
which read as a wedged server that was listening but not answering. **`wget` is
not installed on that image.** Every one of those checks was reporting a missing
binary as "no answer". `curl` is present, and `node -e "fetch(...)"` works.
**Test the tool before believing the negative.**

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

### AND THERE IS A SECOND, SEPARATE FAULT — the admit timeout is real

I over-corrected above. Both of these exist and they are not the same thing.

`sync-watch: proposal failed: daemon request timed out: source-proposal-admit`
at **22:39:34Z**, inside a leg that took **139.4s**; the next admission confirms
at **22:40:24Z**. The request times out, the retry succeeds, the edit costs about
**90 extra seconds**. That is in the log independently of anything I measured
wrongly.

**The disk-vs-remote table I built from this is NOT evidence of a fault — but
the 60s-poll explanation I replaced it with was ALSO wrong. Both are dead.**

**There is no systematic disk-vs-remote gap.** Nine cycles with both build slots
free: disk **8.5–12s**, remote **8.5–10.2s**. The gap existed only while the
stopped worker held a slot, and closed when it was freed. I explained a
difference that had already stopped being there.

**And the poll does not apply here at all**, on two counts:

- `writeOnRemote` calls `tlda project remote pull` itself. The remote leg is
  **triggered, not polled**.
- The daemon builds a remote bridge only when the **binding** carries a
  `remote`, written at link time. `tlda project remote add` runs a plain
  `git remote add` in the checkout and never touches the binding.
  `sync-watch`'s record says `remote: none`. **No timer runs in this path.**

**The useful constraint that survives: outliers are not leg-specific.** The worst
of the night was **184.2s on the *disk* leg** in an otherwise clean run of nines.
Whatever causes them hits both ingresses, which rules out anything specific to
remote handling.

I sampled the daemon during a slow remote leg expecting it to be blocked:
**every thread parked in `kevent` for 12 seconds, nothing running.** That
observation is real; the timer I attributed it to is not. **What it actually
shows is the daemon idle while the delay happens somewhere else.**

**Disproved already, do not re-derive it:** that admit walks a growing
`refs/tlda/proposals` set. Measured on the box — **76 proposal refs, 78 total,
`for-each-ref` in 6ms, 366 loose objects.** Nothing there costs seconds.

**Still unexplained. `browser-perf` owns it.**

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

## 2026-08-26 — CLI gate accepted; one canary relink done

**`3ab696cd8` — the relink CLI gate now requires evidence it got somewhere.**
The chief rejected the previous version four times and was right each time: the
existing-project case asserted only that `Usage:` never appeared, under an
eight-second cap, so **silence passed it** — a crash satisfied it. It now waits
for `Usage:` | `local fleet daemon is unavailable` | `exists, pushing files` |
`Submitting` | `Submitted`, and asserts BOTH that a marker was reached AND that
the marker was not `Usage`. The daemon-unavailable line is in the set on
purpose: it is what a daemon-less checkout prints, so both environments reach a
marker and the test stops being a fact about this machine.

Two counterfactuals, both red:
- pre-fix CLI → fails on *"the stage it reached was not the usage gate"*
- marker made unreachable (the crash/silence path) → fails on *"reached a known
  stage rather than dying quietly"*

Also deleted a comment claiming `Source:` prints *before* `bindLocalSource()`.
It prints after, and the file carried both claims at once.

```
node --import tsx --test cli/relink-preserves-an-empty-declaration.test.mjs shared/document-roots-to-declare.test.mjs
```
6/6, 28s here; the chief independently got 6/6, 30.4s.

**The canary relink — ONE directory, `sync-rootless`, mine and disposable.**
Preconditions all checked before acting: exists; single-binding; clean; HEAD
`f8b850f` an ancestor of server head `3f7acc3`; one branch, no MERGE_HEAD. The
project really is the case under test — `documentRoots: []` on the server.

`tlda-dev project link sync-rootless` from inside the directory, **no source
argument**, exit 0, 13s. After: `documentRoots: []` **preserved** (the fix,
live — this is where a root used to be invented from the main file and written
into the record), branch and HEAD unchanged, checkout clean.

Edit-to-browser on a disposable change: marker appended to `doc.md`, server-side
in **14s**, then read back **across the source-room websocket**
(`/source-sync/sync-rootless/doc.md`, real Yjs frames) rather than the `/source/`
endpoint — the published endpoint is not the browser surface, and reporting it
as one is the wire failure this repo keeps repeating. Fully restored afterwards:
`doc.md` byte-identical (11 bytes), server source byte-identical, zero markers
left, checkout clean.

**Stopped there.** No second directory. Real relinks still held.

**Still open, and NOT to be touched unasked — it is a semantics decision.**
`onWrongHead` in `daemon/git-project-sync.mjs` is a no-op default parameter with
**zero callers** (`git grep onWrongHead main -- daemon server cli` returns only
the definition and its own call site). A rejected proposal logs a warning in
`git-sync-manager.mjs` and then never converges: park, retry, same `WrongHead`,
forever. That is the lockout chain still open. The tempting fix — reparent the
proposal onto the fetched head, same tree — is last-writer-wins at file
granularity against a concurrent browser edit, which is Skip's call and not
mine.

## 2026-08-26 — one REAL relink, and two findings that change the picture

Selection funnel: 39 real single-binding candidates -> 28 whose directory
exists and whose record is reachable -> 18 carrying no document roots -> 11
meeting every git precondition -> excluding paper-named projects, Skip's
current viewer document, and anything over 2 pages -> **8 eligible, 1 taken**.
Preconditions were re-run at action time rather than inherited from the audit.
Relink: no source argument, exit 0, 12s. Roots not invented. HEAD unchanged,
clean, still an ancestor of the server head. Marker to `README.md` reached the
server in 15s and was read back across the source-room websocket; local and
server both restored byte-identically.

**Finding 1: `project link` moves the checkout onto the daemon work branch.**
This one went from `master` to the work branch -- same HEAD sha, clean tree,
nothing lost. It was NOT moved back, deliberately: Skip's rule is that a
checkout commits and pushes only while a daemon-managed branch is checked out,
so restoring `master` would switch sync off for that checkout and undo the
repair. It is still an unrequested visible change to a real directory and it
will happen to all 8. Flagged to the chief; not proceeding until answered.

**Finding 2: the "18 rootless projects" number came from an instrument that
could not tell an absent field from an empty one.** The audit tested
`(documentRoots || []).length === 0`, which reports a MISSING key as rootless.
Re-measured across all 18: **the key is absent in 18 and explicitly `[]` in
none.** The disposable fixture had an explicit `[]`, so the two are genuinely
different record shapes and had been conflated. `documentRootsToDeclare`
preserves both, so the fix is unaffected -- but the count means "18 records
carry no documentRoots key", not what was previously reported.

## 2026-08-26 — HARD STOP: an open source room publishes conflict markers

Relinking the second real directory deviated at the restore check and the run
halted there. The cause is a defect, not the instrument.

**What happened.** The server's published source became **239 bytes of
conflicted text against 72 on disk**, carrying git conflict markers rendered
into the document, including a `>>>>>>> accepted server source for
<project>:<file>` line.

**Mechanism.** `server/lib/source-room-daemon.mjs` three-way merges the live
room text against the incoming accepted server source with `git merge-file`.
On conflict it accepts `status === 1`, keeps stdout **with the markers in it**,
and that becomes the published source. `hasConflictMarkers()` exists in the
same file and does not gate publication.

**A READ is enough to trigger it.** The room was opened only to read. The room
is server-side and outlives the client, holding the text it had; the disk
restore then arrived as incoming and conflicted against it. So a person with
the browser editor merely OPEN on a file, while anyone edits that file on disk,
can get conflict markers published into the document. That is the
two-people-editing-the-same-file case, and it fails.

**NOT established.** The two earlier runs did the same sequence and restored
cleanly. The visible difference is a 25-30s gap between room read and restore
where the failing run had sub-second, which points at a race on whether the
room flushes before the incoming revision lands (fresh vs stale merge base).
Two observations, no isolating test. Do not repeat this as a cause.

**State: everything restored.** All three touched projects (1 disposable
fixture, 2 real) verified across disk, server AND room: local == server
byte-identical, room == local, zero conflict markers, zero canary markers,
checkouts clean.

**Queue: 7 eligible directories untouched, 1 attempted and fully rolled back.**
No further relinks pending the chief's word.

Runner used: `scratch/relink-one.mjs` (gitignored, regenerable, a tool not a
resumption point). It rechecks every precondition at action time, crosses the
source room rather than reading `/source/` and calling that the browser, and
restores before asserting so a failed arrival cannot leave an edit behind.

## 2026-08-26 — isolated: the conflict-marker publication, and a second defect

**The markers did not predate the run.** The conflict hunk carried the canary
written by the runner in that same run.

**First failing node.** `server/lib/source-room-daemon.mjs`,
`applyAcceptedSourceMutation`. On conflict `mergeText` returns
`conflicted: true` AND the marker-laden stdout, and the caller runs
`replaceYText(room.ytext, merged.text)` **unconditionally**. The markers are in
the shared Yjs document -- what viewers see, what the room flushes -- before
`room.blocked = merged.conflicted` is assigned. `blocked` is set after the fact
and gates nothing; `hasConflictMarkers()` sits in the same file and is never
consulted here. `reconcileRoomToRevision` has the same shape.

**Red test: branch `room-conflict-proof`, `54cb7f2c1`.**
`node --import tsx --test server/lib/source-room-never-publishes-conflict-markers.test.mjs`
Deterministic and offline. Red on main, green with a one-line guard (verified,
then reverted), so it is satisfiable rather than impossible. Held on a branch so
main's suite is not red while the repair is chosen. It asserts ONLY that
conflicted output never reaches the document -- not which side wins.

**A SECOND defect, found by the timing sweep and not yet diagnosed.** With a
room open, a disk edit at a 0s gap is **silently lost** -- the server keeps the
room's text, no conflict, no error. At 15s and 30s it is clean. And with two
sides editing the SAME line deterministically, the published document carries
the browser edit and **not** the disk edit. The disk author's work vanishes with
no warning. **The node that drops it is NOT established** -- do not repeat a
cause for this one.

**Repair options reported to the chief, none implemented, none choosing a
winner:** (1) don't write conflicted output into the room; set `blocked` and
record through the existing `recordHeldEdit` hook; (2) gate the flush path on
`hasConflictMarkers()`; (3) the deletion option -- drop the three-way merge and
treat divergence as a held edit, which changes semantics. Leaning (1).

Harnesses `scratch/room-conflict-repro.mjs` and
`scratch/room-divergent-repro.mjs` are force-added on that branch.
Disposable project verified consistent across disk, server and room.

## 2026-08-26 — the conflict-marker fix, on branch `room-conflict-proof`

**`baf8eb86f`.** On a conflicted merge both `applyAcceptedSourceMutation` and
`reconcileRoomToRevision` now keep the room's own text and report through the
existing `noteRoomIsHolding` hook. No winner chosen; non-conflicting merges
untouched. The gate covers both paths and asserts recoverability directly --
the person's text is still in the room, `blocked` is set, the held edit is
recorded.

```
node --import tsx --test server/lib/source-room-never-publishes-conflict-markers.test.mjs
```
2/2 green with the fix, 2/2 red without. Neighbouring room test green. eslint,
tsc -b, lint:guards clean.

**The counterfactual is what made the gate real.** The reconcile test first
PASSED against unfixed code: `headChanged` takes POSITIONAL arguments and was
being handed an options object, so `revision` was undefined and
`reconcileRoomToRevision` returned at its first guard. Written down because the
same mistake is available to anyone extending these tests.

**`lint:guards` follows git tracking, not the filesystem.** It flagged the two
repro harnesses for WebSocket construction outside the transport library;
untracking them cleared it and they remain on disk. They are regenerable tools,
so they belong on the "logs, not resumption points" side of the repo rule. They
were deliberately NOT added to the guard's ALLOWED list, which is for product
sites.

**The live disposable proof cannot be produced yet, for a specific reason.** The
disposable project never produced markers even BEFORE the fix
(`publishedConflicted: false`), so a clean run after the fix cannot distinguish
the fixed state from the state it was already in. Markers were only observed on
a real project and real projects are frozen. The deterministic gate is the check
that does distinguish. Live confirmation needs a deploy, which is the chief's
lane; the branch is not on `main`.

**Still open:** the zero-gap silent disk-edit loss. Pre-fix disposable run:
`publishedHasDiskEdit: false` -- the disk author's edit gone, no markers, no
error. Cause NOT established.

## 2026-08-26 — the zero-gap disk-loss IS the WrongHead lockout

Traced on a disposable project, sampling published source AND revision identity
every 2s rather than looking once at the end:

```
 29s  === BROWSER EDIT (socket held open) ===
 36s  rev=79d2db9  seq=11031      <- the browser edit becomes a revision
 37s  === DISK EDIT ===
 39s..81s  rev=79d2db9 seq=11031 published=BROWSER   (45s, unchanged)
```

**The disk edit never became a revision at all** -- two revisions in the whole
run. So the loss is upstream of the room, and the conflict-marker fix does not
touch it.

**Causal evidence, daemon log, timestamps matching the run:**
```
09:25:33Z  proposal not accepted: WrongHead
09:26:19Z  announced 79d2db9, fetched 82b077a
09:26:19Z  proposal not accepted: WrongHead
```

**First failing node.** `pushRevision` in `daemon/git-project-sync.mjs`. On
`WrongHead` it calls `onWrongHead` -- a no-op default with ZERO callers -- then
`headChanged`, which parks the new head at `refs/tlda/fetched/<project>` and
deliberately does not apply it. The checkout's branch never advances, so every
later proposal is rejected identically. `git-sync-manager` logs one warning and
stops.

**Consequence: once anyone edits in the browser, the disk collaborator is locked
out permanently** -- not for that edit, for all of them -- and the only trace is
a daemon log line nobody sees.

**This is deliberate design and was NOT changed.** The comment above
`headChanged` states it: the accepted revision is parked, local is
authoritative, divergence is theirs to resolve. That replaced an earlier
behaviour that committed dirty trees unasked. The design is coherent; what is
missing is a path back, and choosing one is merge semantics -- Skip's call.

**Options reported, none implemented:** (1) wire `onWrongHead` to surface the
lockout -- decides nothing, and a lockout nobody can see is the worst property
of the current state; (2) re-parent the proposal onto the fetched head, which is
last-writer-wins; (3) drop the parking rule and fast-forward a clean checkout,
which re-opens what parking was added to stop.

**Note for whoever unfreezes relinks: relinking does not fix this.** Any project
whose browser edits are ahead of its checkout is already locked out, relinked or
not.

Harness: `scratch/disk-loss-trace.mjs` (untracked -- the websocket-boundary
guard follows git tracking, and this is a regenerable tool).

## 2026-08-26 - lockout proof on branch `lockout-proof`, and the repair path

**`48bce44d4`.** Three tests, and the third is why the first two mean anything:

```
node --import tsx --test daemon/a-locked-out-checkout-still-lands-its-edit.test.mjs
```
- RED: a disk edit lands after the browser published, keeping BOTH sides.
  Fails on the production failure verbatim -- `{"ok":false,"status":"WrongHead"}`
  -- reproduced offline with a real pre-receive hook carrying the server's own
  ancestry rule.
- RED: a same-line conflict is HELD and named, not silently dropped. Separate on
  purpose: loss and held-divergence look identical from outside, so a fix that
  discarded the conflicting side would pass a test that could not tell them
  apart.
- GREEN CONTROL: the identical harness with the published head still an ancestor
  lands the edit on today's code. Without it a broken fixture and a real defect
  are the same colour.

Both tests also assert the person's checkout and index are untouched.

**THE REPAIR PATH, verified mechanically, not proposed from reading.**
`git merge-tree --write-tree <acceptedHead> <localFilteredCommit>` merges the
two entirely in the object database -- no working tree, no index, no checkout
mutation, so none of the five things `d60d18573` removed comes back. Then
`git commit-tree <mergedTree> -p <acceptedHead> -p <local>` yields a commit the
ancestry rule accepts, because the accepted head is a parent.

| case | exit | result |
|---|---|---|
| different files changed | 0 | both edits present; accepted head an ancestor; 0/0 tree/index |
| same line changed | 1 | conflicted paths at stages 1/2/3; 0/0 tree/index |

**The zero-exit case is the positive control and it matters here.** The LEGACY
`git merge-tree` prints `changed in both` for any file both sides touched, which
is not a conflict report -- see the memory `merge-tree-changed-in-both-is-not-a-conflict`.
The `--write-tree` form does not share that failure: exit 0 on genuinely clean,
1 only on a real conflict. Checked, not assumed.

**The deletion that comes with it:** `onWrongHead`, a parameter with zero
callers, goes -- replaced by the merge path rather than kept as a second way to
signal the same thing.

Not implemented; awaiting the chief. Real projects and relinks frozen.

**Process note:** a shell heredoc hung a turn for six minutes. Commit messages
now go through a file and `git commit -F`. Not the tests -- the heredoc.

## 2026-08-26 - lockout FIXED on branch `lockout-proof` (`8333b3c53`)

**The gate boundary was stated wrong first time and the chief caught it.**
`commitSettledTree()` DOES commit the tracked disk edit and advance the work
branch -- existing, wanted behaviour -- so "the checkout is untouched" was
false, and asserting a clean worktree/index proved nothing because a clean tree
is exactly what committing produces. The real line: **the app-owned merge commit
must never become checkout HEAD.** The gate asserts that directly, plus that
HEAD did not quietly absorb the other side, plus that the accepted head stays
parked and reachable so "held" means recoverable.

**The missing case was the ordinary one:** same file, non-overlapping lines. A
fix handling only different-file edits would leave the everyday collaboration
path locked out and the earlier tests could not tell the difference.

**Implementation.** On WrongHead the accepted head is parked as before; then
`merge-tree --write-tree accepted local` merges entirely in the object database
and `commit-tree` builds a two-parent commit. No working tree, no index, no
branch -- none of the five mutations `d60d18573` removed comes back. ONE retry,
never a loop. Conflict returns `conflict-held` naming the paths, both sides
recoverable, no winner chosen. `onWrongHead` (zero callers) deleted.

An exit code other than 0 or 1 from `merge-tree` is RETHROWN, not reported as a
conflict: a bug in the invocation must not become a story about two authors.

**Results.** Gate 4/4 green with the fix, 3 red + 1 green control without.

| file | parent | with implementation |
|---|---|---|
| `git-project-sync` | 8 pass / 2 fail | 8 pass / 2 fail, same two |
| `git-project-mirror-unrelated` | 3 pass / 4 fail | 3 pass / 4 fail, same four |

**All six are PRE-EXISTING failures on main; none is a regression.** The QMD one
is baseline too -- byte-identical both sides, `lecture.html` unexpectedly
included. The `d60d18573` boundary guard "a would-be conflict is parked instead
of being left unresolved in the checkout" passes on BOTH sides, which is the one
this change could plausibly have breached.

eslint, tsc -b, lint:guards clean.

**Two things for someone else.** `main`'s daemon suite is red: six failing tests
across those two files, unrelated to this work. And both files LEAK AN OPEN
HANDLE -- they need `--test-force-exit` to terminate, which is why an aggregate
run sits with idle workers instead of finishing. Reproduces at the parent, so
not from this work.

## 2026-08-26 - correction, and the manager-test classification

**`26bf217b3`: a malformed `merge-tree` success now THROWS.** Exit 0 means git
merged cleanly, so output that is not a tree id means this code is wrong.
Returning `{ok:false}` let `pushRevision` label it `conflict-held` -- telling a
person their collaborator's edit conflicted when nothing of the kind happened,
indistinguishable from a real conflict in every surface. **Only exit 1 may
produce `conflict-held`.** The same rule was already written one paragraph
lower for the exit-code check; it had been applied on the throw path only.

Counterfactual drives it through `runGit`, not a repository, because the thing
under test is git answering WRONGLY, which a real git will not do on demand. It
asserts the error fails as itself, is not dressed as a conflict, and that
nothing was committed from the malformed output. Red pre-correction, green
after. Gate now **5/5**.

**The two manager tests, each in its own process, `--test-force-exit`, 60s
inner / ~90s outer, both sides:**

| test | parent | implementation |
|---|---|---|
| `two projects sharing one checkout...` | timed out 60000ms | timed out 60000ms |
| `initial project link...` | timed out 60000ms | timed out 60000ms |

Identical failure mode and duration. **Not regressions** -- which was a live
risk, since the implementation adds a merge and a second push on the WrongHead
path and could plausibly have stalled here.

**NOT established: what they actually are.** These are timeouts, not assertion
failures. "Not mine" is proved; "known baseline failure" is not. This is also
the file that needs `--test-force-exit` to terminate at all, so a 60s hang is a
statement about the run, not the behaviour. Do not inherit these as classified.

**A measurement error of my own, recorded because it nearly shipped:** the first
run of these printed `pass 0 / fail 0` and I almost reported it. The outer loop
was killing the process before the summary line -- the tests HAD run and timed
out. A zero from a runner you cut off is not a measurement. Read the per-test
lines, not the counts.

**Standing hole, not mine and unowned:** `main`'s daemon suite carries six
assertion failures and at least two hanging tests across three files, plus an
open-handle leak in two of them. An aggregate run over that directory can
neither come back clean nor terminate.

## 2026-08-26 - channel-silent restart task: two findings, one open question

Picked up `fleet:d733-mt9lerth` after the sync work integrated on main
(`3aeaf31f0` + `0753bb8a2` + `6482a9187` + `ad422e67a`, verified independently:
merge path present, `onWrongHead` gone, malformed-throw present, all 5 gate
tests on main).

**Finding 1: the code the brief asks to replace was deleted 24 minutes AFTER
the task was delegated.** `596c08fad` "Suggest restart instead of killing on
channel silence" landed 00:51; the delegation was 00:27. It removed the
`rpcRestart` call from the `channel-silent` remedy and replaced it with
`suggestRestart: () => terminalRpc.notifyConnectionDisconnected({ agent_id })`
-- a message into the live session, no lifecycle action.

**That commit has NO BODY.** Subject line only, on a behaviour change to the
notification remedy. Same shape as `37bf5ad3b` (wake marks an agent dead), which
AGENTS.md records. Nothing in the record says whether it was asked for.

Net: criterion 1 ("never calls kill-session/rpcRestart") is ALREADY satisfied on
main; criterion 2 ("existing restart-mcp hibernate/wake path is used") is NOT.
Half the task was done by someone else while it sat assigned here.

**Finding 2: criteria 1 and 2 cannot both hold, and it is not a wording
quibble.** There is NO separate `hibernate` verb -- hibernate IS `kill-session`,
killing the tmux session while the agent row stays alive. So
`tlda-dev restart-mcp` -> lifecycle `restart` -> `rpcRestart` -> `kill-session`
+ `wakeMint`. **The restart-mcp hibernate/wake path and `rpcRestart` are the
same code.** Do not "resolve" this by picking one; it needs a decision.

**Open question put to the chief, not decided here:**
(a) wire `channel-silent` to a real restart -- resolve the mint as `restart-mcp`
does, call lifecycle `restart` with `mint_id` and `wait_until_complete`. Reads
criterion 3's "live tmux session survives" as *the agent is running afterwards*.
Also fixes the bug the deleted comment documented: the old remedy passed
`{agent_id}` alone, which `wakeMint` cannot resolve, so it killed the session and
threw, leaving agents DOWN -- observed twice on the live daemon in four minutes.
(b) leave main as it is and close the task as done by `596c08fad`, which is what
the current code's own comment argues: "Silence authorizes a message to the
existing session, not a lifecycle action."

Nothing written pending the answer.

**Also still true and unowned:** main's daemon suite carries six assertion
failures and at least two hanging tests across three files, plus an open-handle
leak in two of them. An aggregate run over that directory can neither come back
clean nor terminate, which means a regression there lands invisibly.

**And the sync fix is NOT live:** it is on main, but the running daemon does not
have this code. Until the daemon restarts, the lockout is still happening.

## 2026-08-26 - the lockout fix VERIFIED LIVE, and two false alarms of my own

Testing serves `ad422e67a`; daemon-testing restarted from that SHA.

**The result, on a disposable project, real path, browser socket held open:**
```
63s..81s  rev=4b8dd17  seq=11208  published=BOTH
VERDICT: the disk edit was PUBLISHED -- the ordinary two-person case now lands
```
Both edits in the published source, no WrongHead, no conflict-held, clean
admission. That case was a permanent lockout this morning.

**The conflict path is live and correct too**, from the daemon's own log:
```
10:45:17  holding -- the accepted source and this checkout both changed doc.md
10:45:17  proposal not accepted: conflict-held
```

**TWO FALSE ALARMS, BOTH MINE, recorded because they nearly went out as
findings.**

**1.** The original reproduction returned "disk edit NEVER PUBLISHED" and I was
one step from reporting the fix broken. It edits the SAME LINE from both sides,
so it is the conflict case and not publishing is correct. **The harness verdict
text predates the fix and reads a correct hold as a failure.** The daemon log
caught it.

**2.** The "ordinary case" I then built also came back not-published. Two
defects in my own harness: the edits landed on ADJACENT LINES, which genuinely
conflict in any three-way merge, and the browser edit was DOUBLE-APPLIED -- the
accepted head read `bravo-FROM-BROWSER-FROM-BROWSER`. Separating the edits by
eight lines and applying the browser side to the BASE text rather than to
whatever the room held is what produced the real answer.

**Both times the instrument was wrong and the code was right, and both times
the false reading looked exactly like the defect I had spent the morning
chasing.** If you inherit these harnesses: `scratch/disk-loss-trace.mjs` tests
the CONFLICT case and its verdict wording is stale;
`scratch/disk-ordinary-trace.mjs` is the one that tests the ordinary case.

**Harness improvement:** `scratch/relink-one.mjs` now checks the published
source for conflict markers BY NAME. On the run that halted the sweep it noticed
that damage only as `restore-server` failing to converge -- the symptom furthest
from the cause.

**Sweep resumed** under the chief lifting the freeze. Index 0 --- the directory
that halted it before --- passed clean: roots absent and unchanged, HEAD
unchanged, ancestry holds, edit reached server in 13s and the source room,
restored local and server, checkout clean.

## 2026-08-26 - SWEEP HALTED at index 6: the relink fix is incomplete for LaTeX

**6 of 7 attempted. Indices 0-5 clean** (roots absent and unchanged, HEAD
unchanged, ancestry holds, edit reached server 10-13s and crossed the source
room, restored byte-identically both sides, checkouts clean; branches moved to
the daemon work branch as ruled intended).

**Index 6: `DEVIATION at roots-unchanged: absent -> set:1`.** The relink wrote
`[{"path":"main.tex","format":"svg"}]` onto a project that declared nothing --
the exact invention this task existed to stop.

**CAUSE, upstream of the guard.** `cli/tlda.mjs:737` builds
`projectDocumentRoots` with `normalizeDocumentRoots(documentRoots, {mainFile,
format})`. Measured:

```
normalizeDocumentRoots([], { mainFile: 'main.tex', format: 'svg' })
  -> [{"path":"main.tex","format":"svg"}]
```

It SYNTHESISES a root from the main file when the list is empty -- before
`documentRootsToDeclare` is called. The guard then receives the invented root as
`supplied` and correctly passes it through. **Right function, wrong input.** The
unit gate tests the function in isolation and is still green; it could never
have caught this.

**The six passes before it proved nothing about this path.** The MARKDOWN branch
never PATCHes document-roots at all -- on already-exists it logs and pushes.
Only the LaTeX/svg branch PATCHes. Index 6 was the first LaTeX project in the
queue and therefore the first real exercise of the changed code. The queue was
six markdown and one LaTeX, and that should have been read before treating the
run as reassurance.

**This exact path was flagged earlier in this same file and not closed:** "my
live check missed it because markdown returns before that fallback."

**NOT REVERTIBLE THROUGH THE API, and this is the part that matters:**

```
PATCH /api/projects/<p>/document-roots  {documentRoots: []}
  -> 400 {"error":"documentRoots must be a non-empty array"}
```

A project can EXIST with no roots -- 18 do -- but the API cannot set it back to
that. **The state is reachable and not settable.** One real project now declares
`main.tex` where it declared nothing before, with no documented route to undo
it. Content, HEAD, branch and revision untouched; only the declaration changed.
No edit was made -- the deviation halted before the disposable-edit step.

**Smallest repair, NOT implemented, pending the chief:** do not PATCH when the
effective declaration is empty. Keeping an empty declaration means not writing
one, which is also what the server's own 400 says from the other side. It leaves
`normalizeDocumentRoots` alone for the creation path.

## 2026-08-26 - LaTeX relink gate + repair (`4ed102ad1`, branch `latex-relink-gate`)

```
node --import tsx --test cli/relinking-a-latex-project-declares-nothing.test.mjs
```
2/2 green with the repair, 1 red + 1 green control without. Neighbouring relink
tests 6/6. eslint, tsc -b, lint:guards clean.

**Repair:** the PATCH is skipped unless roots were named on the command line or
the project already declares some. Normalization and creation untouched --
`normalizeDocumentRoots` still invents for creation, which is right there.

**API facts the gate had to be corrected against, and they are findings:**
- creating with a `mainFile` declares it immediately
- an explicit `documentRoots: []` alongside a mainFile is OVERRIDDEN, not honoured
- a declaration must include the project mainFile
- a LaTeX project reaches the rootless state ONLY by being created without a mainFile

The first two runs of the gate were red on MY FIXTURES, not on the bug.

**RESTORATION: THERE IS NO SUPPORTED PATH.** Checked, not assumed. Two writers:
- `PATCH /:name/document-roots` -- the only setter, rejects empty at the top of
  the handler (`!Array.isArray || length === 0` -> 400); 400 for `null` too
- `server/routes/projects.mjs:482` -- APPEND-ONLY adoption, `[...existing, root]`

No DELETE, no reset, no clear. The only route producing "declares nothing" is
creation without a mainFile, and re-creating an existing project means deleting
it, which takes its history. Not a restoration.

**What the change cost, MEASURED:** with nothing declared the roots come from
the include graph. Run over the real checkout:

```
files:   figures/bounds.png, figures/compliance.png, intro.tex, main.tex, method.tex, refs.bib
derived: [{"path":"main.tex","format":"svg"}]
now:     ["main.tex"]        same set: true
```

The declaration names exactly what the graph would derive; `intro.tex` and
`method.tex` are `\input`s and are not roots either way. Content, history, HEAD,
branch, revision untouched; no edit was made. **The record is now PINNED where
it was previously COMPUTED** -- a real difference if the document structure
changes later, and the honest residue of the mistake. One project.

**Another instrument error caught before reporting:** the first derivation
printed `{}` and nearly went out as "derives nothing". `documentRootsIn` is
ASYNC and was not awaited -- that was a Promise.

## 2026-08-26 - canary against the deployed repair, and a correction to my own claim

**Index 6 passes** against `b4097808f`: roots `set:1` unchanged, HEAD unchanged,
branch unchanged, ancestry holds, edit reached server 17s and the source room,
restored both sides, clean.

**But index 6 can no longer test the case that failed** -- the earlier run wrote
`main.tex` into it and that is not revertible. Audited every other rootless
LaTeX project: **four exist, none eligible.** One is a paper (excluded
absolutely); the other three have DIRTY checkouts holding someone else's
uncommitted work.

**Disposable LaTeX canary instead** (`scratch/latex-rootless-canary.mjs`):
created rootless, relinked with no source and no roots, roots `empty` before AND
after, bound to the work branch, edit reached server in 16s and the source room,
restored, clean. **Counterfactual with the pre-repair CLI: red** -- dies in 3s on
`documentRoots must be a non-empty array`, no push.

**THE CORRECTION. The gate does NOT cover the invention that damaged the real
project, and the first commit body implied it did.** Its pre-repair red is:

```
AssertionError: the CLI reached a known stage rather than dying quietly
  actual: 'exited'   expected: 'reached-stage'
  Error: documentRoots must be a non-empty array
```

Red because the CLI ABORTS, not because it declared `main.tex`.

**Reproducing the invention needs a record with a mainFile AND no declared
roots, and no supported route creates one.** Creating with a mainFile declares
it immediately; the relink does not set a mainFile (checked both canary projects
afterwards -- `mainFile` still absent). The 18 rootless projects are legacy
state from older code.

So the invention is prevented BY CONSTRUCTION -- with no declared roots
`alreadyDeclares` is false and no PATCH is issued -- which is an argument about
the code, not a test result. Commit body amended to say so: **`00ef09842`**
(was `2ee8fa102`).

**If that path should be tested rather than argued:** extract the
skip-the-PATCH decision into a named function and test it with a record shaped
`{ mainFile: "main.tex", documentRoots: undefined }`. Small refactor, NOT done.

Worktrees in play: `latex-relink-gate` (gate + repair), `pre-repair-cli`
(detached at the parent, for counterfactuals), `lockout-proof`,
`room-conflict-proof`.

## 2026-08-26 - Skip's two decisions, and a regression I shipped this morning

**His words, read from his own thread after the relayed IDs did not resolve:**
- 10:58:16 EDT **"4 mark"** -> mark the affected file in the editor
- 10:58:19 EDT **"5 fine"** -> the relink branch switch stays

**Citation note:** the two IDs relayed (3379495, 3379496) both resolve to
`classroom-pm`'s own Bash ACTIVITY, not to Skip. The substance was right; only
the IDs were wrong. Recorded because a wrong ID is how an approval gets
laundered -- the next reader checks it, finds someone else's shell command, and
either believes it anyway or discards a real decision.

**`9ef2fd6e5` on branch `held-edit-mark`.**

**THE MARK USED TO HAPPEN BY ACCIDENT, and my own fix removed it.** The
conflicted merge wrote git's markers into the document; the client saw
`<<<<<<<` in its buffer and set `heldConflictFile` itself. Keeping markers out
of the document -- the point of the earlier change -- deleted the only signal
the person had, so **a held edit became indistinguishable from a successful sync
from inside the editor.** That is a regression shipped this morning and not
noticed at the time; his answer closes it.

- **Server:** both conflict-shaped paths broadcast `status: 'conflict'` naming
  the file.
- **Client:** that branch existed and was DEAD for the room path -- no server
  code ever sent it -- and its text said "resolve the markers", which are no
  longer there. It now marks the file and says the edit is held and safe.

**Asserted AT THE SOCKET, not at `room.blocked`:** a flag the server sets and
never sends is the same as no signal. Counterfactual: remove only the broadcast,
keep the hold -> red with `frames seen: ["update:"]`.

Room tests 4/4; tsc -b and lint:guards clean; eslint on the touched files
identical to main (49 problems, 43 errors, 6 warnings, all pre-existing in
`FleetSourceEditorShape.tsx`).

**NOT DONE, deliberately visible:** nobody has seen this rendered. The mark
reuses the existing conflict bar, whose ours/theirs buttons stay disabled
without markers while `resolved` stays enabled. Whether that bar is the right
control for a held-without-markers file is a look-at-it judgement.

Worktrees: `held-edit-mark`, `latex-relink-gate`, `lockout-proof`,
`room-conflict-proof`, `pre-repair-cli`.

## 2026-08-26 - symlink closure push (`52ad7ea4f`, branch `symlink-closure`)

**Mechanism, measured before touching anything:**
```
ls-tree HEAD -- scratch/book/figs/plot.png   ->  (nothing)
ls-tree HEAD -- scratch/book/figs            ->  120000 blob ...
ls-tree HEAD -- lectures/figs/plot.png       ->  100644 blob ...
```
Git does not traverse a symlink in a tree. The closure records the
through-the-link path; the immutable check finds nothing and kills the push,
naming a file that is committed and present.

**Fix:** a member with no tree entry has its prefixes walked nearest-first;
where one is a `120000` blob, read the target and rebuild the remainder onto it,
repeating for nested links. A real directory in that position means the
remainder genuinely is not there. Escaping or cyclic links resolve to nothing
and fall through to the check unchanged. **The symlink itself joins the
members** -- committed blob, and the built document needs it. The target is
carried ONCE at its canonical path, same blob (asserted: materialising bytes at
the virtual path would pass the main test and put a drifting second copy of
every figure in every revision).

Pre-fix 1 pass / 2 fail; post-fix 3/3. Neighbouring `git-project-sync` 8/2 --
the same two pre-existing failures established this morning. eslint, tsc -b,
lint:guards clean. Nothing of Skip's touched.

**THE UNVERIFIABLE CRITERION, recorded so nobody inherits it as covered.** The
immutable check is untouched, but no fixture reaches it after this repair.

- My first version of that test asserted it still refuses a genuinely absent
  file. **It did not hold the line** -- a file that does not exist never becomes
  a closure member, because the closure is scanned against a materialisation of
  the SETTLED TREE. Proved by replacing the check with `continue`: **all three
  tests still passed.**
- An escaping symlink does not reach it either: the link materialises pointing
  outside the temporary tree, so the file is missing rather than a member.

**The in-repo symlink was the one route to that check, and resolving it is what
this change does.** Enforcement is therefore unverified and possibly
unreachable. NOT deleted and not proposed for deletion -- a backstop nobody can
trigger is a decision, not a cleanup.

The third test now pins the real containment behaviour: nothing from outside the
repository is carried in, and its absence does not stop the document publishing.

### Amended to `8b3b719ef` — criterion 3 proven, not caveated

The chief rejected the caveat and was right. `runGit` reaches the check
directly.

| | result |
|---|---|
| with the fix, check intact | **4 pass / 0 fail** |
| check replaced with `continue` | **3 pass / 1 fail** — only the immutable-check test |
| pre-fix code | 1 pass / 2 fail — `immutable closure member is absent` |

**How it reaches the check:** `runGit` passes through to real git, and
`read-tree --empty` flips a flag. That command runs immediately before the
verification loop, so it marks the end of closure construction SEMANTICALLY
rather than by counting calls — a count would shift the moment anyone adds a git
call. After the flag, `ls-tree` for the document returns empty and the unchanged
check refuses it by name. It also asserts NO PROPOSAL reached the remote: a
check that threw after pushing would satisfy the rejection and still ship the
incomplete document.

Production comment shortened to the invariant (seven lines, no route claims).
The test-file header was corrected too — it said no fixture reaches the check,
true when written and false after this amend.

All five criteria met. Neighbouring `git-project-sync` unchanged at 8/2.

## 2026-08-26 - the room that is a project's FIRST writer (`2acf732ca`, branch `room-first-writer`)

Diagnosis only; no repair. Preserved failure on
`~/worktrees/app-tester-overlay-proof`, preview :5191.

```
project record   sourceRevision (NONE), acceptSeq null, mainFile main.md
project source   git repo with NO COMMITS
room working     main.md UNTRACKED, zero commits,
                 HEAD -> refs/heads/tlda/<project>, and NO REFS AT ALL
server.log       proposal not accepted: not-on-work-branch
                 proposal not accepted: empty-checkout
```

**THE PROJECT NEVER HAD A HEAD -- not a missing fetch.** The unborn branch is
the tell: `standOnWorkBranch` starts the branch at the project head and there
was none.

- **Did the room write before `standOnWorkBranch`?** No. `not-on-work-branch`
  precedes `empty-checkout`, so the stand ran first. The order held.
- **Does the branch/head exist?** Branch exists as a symbolic HEAD and is
  UNBORN; `for-each-ref` returns nothing.
- **The exact call that never ran: `git add`.** `settledCommit()` stages tracked
  paths only, so an untracked file in a zero-commit tree gives an empty tree with
  no HEAD -> `empty-checkout`, repeating on every later settle.

**A gap between two decisions that are each right alone:** `d60d18573` (stage
tracked only; stated cost is that a new file waits for the author's `git add`)
and `de356e277` (stand on the project branch, correct when a head exists). My own
comment in the latter names this case as a reassurance about linking a new
directory -- it is also the description of this failure.

**A person's checkout never hits it because they run `git add`. A source room has
no author at a keyboard.**

**The repro is two tests, and the second is why the first means something:** an
unstaged new file in a PERSON'S checkout stays theirs, and it passes on today's
code -- so "just stage everything" cannot satisfy both.

Out of bounds per the chief: restoring the deleted app-owned `add -A` exception,
and materialising missing files.

### Fixed: `7fe597586` on `room-first-writer`

The room stages what it owns through `track-path` (the verb the adopt-a-root
path already uses) before `queuePaths`. Both first-writer paths: `submitFiles`
and the room flush. Deletions still ride the settle's `add -u`; nothing touches
a person's checkout.

**Signature correction:** the real call is `remoteOperation(project, operation,
params)` -- THREE POSITIONAL ARGS, not `(project, { operation, path })`. The
object form would have hit `unsupported Git remote operation`.

**ANSWERED IS NOT STAGED, and it cost a diagnosis.** `trackPath` returns
`{ inRepo: false }` WITHOUT THROWING when the path does not textually match
git's `--show-toplevel` -- a realpath difference is enough. Wrapped in
try/catch it reported success while the file stayed `?? main.md`. The result is
now checked rather than the absence of an exception. The fixture must
`realpathSync` its temp root or it measures the macOS `/var` vs `/private/var`
prefix instead of the behaviour.

**Three tests at three layers, and the first draft had the wrong one carrying
the requirement:**
- MECHANISM: untracked file in a zero-commit tree -> `empty-checkout`. That
  layer is RIGHT to refuse and must keep refusing.
- BOUNDARY: an unstaged new file in a PERSON'S checkout stays theirs. Passes on
  both sides, so "stage everything" cannot satisfy the file.
- REQUIREMENT: through the real `createSourceRoomDaemon` over the real
  `createGitSyncManager` -- only watcher and remote replaced -- a first document
  becomes a proposal.

Pre-fix 2 pass / 1 fail; post-fix 3/3. Before the fix the requirement test logs
`not-on-work-branch` then `empty-checkout` -- the same pair in the same order as
the preserved `server.log`.

**NOT DONE: the :5191 mount gate.** That preview serves `f87cafdbf` from
`~/worktrees/app-tester-overlay-proof`, which is APP-TESTER'S worktree.
Re-running it against this fix means putting this branch into their preview and
restarting it -- moving another contributor's environment. Asked the chief to
either authorise it or hand it to app-tester with the branch name.

### Amended to `bef19e701` — staging failure THROWS

The chief held integration and was right: `trackRoomFile` warned and carried on,
so both callers could report success for a file that can never become a
revision. **That is the exact shape described three lines above it in the same
function** -- answered is not staged -- and then done anyway.

- `trackRoomFile` now throws on a `remoteOperation` error AND on
  `answer.tracked` false. The bytes are already persisted to the room tree and
  its Yjs document, so failing costs nothing, and `flushRoom`'s catch schedules
  the retry.
- `submitFiles` answers **409 naming the file** instead of `202 queued`.

**Negative control, and it bites:** `track-path` answers
`{ inRepo: false, tracked: false, path: null }` -- the literal shape `trackPath`
returns -- and the test asserts the answer is not 202, says `ok: false`, names
*was not staged*, and that NOTHING was queued. Restoring warn-and-continue turns
that test and only that test red (3 pass / 1 fail).

4/4 with the fix. eslint, tsc -b, lint:guards clean.

**Handed to app-tester** (`chat` 3386910) for the preserved :5191 mount gate:
branch, commit, what to expect, and that a staging failure now surfaces as a
loud 409 rather than a silent stall -- so they send the message rather than work
around it. Their worktree and preview untouched.

**Branches awaiting the chief:** `symlink-closure` at `d0b98a013`,
`room-first-writer` at `bef19e701`, `held-edit-mark` at `9ef2fd6e5`,
`latex-relink-gate` at `00ef09842`.

### `bef19e701` GATE-PASSED by app-tester, and one expectation of mine was wrong

Their evidence: `pages 1 · build success · sourceRevision 5467a69b6658` on the
FIRST sample at t+8s, `/docs/.../index.html -> 200`, and in the room
`git log f36f635 "tlda settled edit cluster"` with **0 dirty paths** where it was
previously `?? main.md`, zero commits, unborn HEAD. **`empty-checkout` appears
nowhere in the run.**

**MY EXPECTATION WAS WRONG.** I told them BOTH `proposal not accepted` lines
should stop. Only `empty-checkout` was ever mine to remove.
`not-on-work-branch` still appears once, early, and it is ORDERING not fault:

```
source-room-daemon   bindSource(...)
                     await gitSync.sync([projectRecord])   <- settles ONCE here
                     standRoomOnProjectBranch(...)
git-sync-manager:198 await settleEditCluster()             <- inside sync()'s start()
```

`sync()` settles once through `start()` BEFORE the caller stands the tree on the
work branch. On a fresh room tree HEAD is still `main`, so that settle is
correctly refused; the stand then happens and the next settle publishes. On an
established room it never appears. Transient by construction: one refused
attempt, one log line.

**NOT FIXED, deliberately.** A one-line reorder in a path that has just started
working, nobody has reported it, and it costs nothing. Belongs in the record, not
in a commit, unless the chief asks.

**No 409 fired** -- `trackPath` genuinely staged in their environment.
app-tester's point that it stayed quiet FOR A REASON rather than being
unreachable is the right distinction and I would have skipped it.

**The six behaviour checks are NOT run:** they need `bef19e701` merged into the
classroom head by its owner. app-tester declined to run them on a locally-merged
variant because a mount pass on a variant is not a gate pass. Correct call.

## 2026-08-27 - disposition, measured (not recalled)

`main` = `67e62b396` · testing serves `b5b6eb4e5` (ref `main`).

**Different shas, SAME CODE.** Main is 8 commits ahead and all 8 are four slide
changes plus their four reverts; `main^{tree}` and `b5b6eb4e5^{tree}` are
IDENTICAL. Checked the DEPLOYED TREE by grepping `b5b6eb4e5` directly rather
than assuming main implies running.

**Live in the deployed tree:** symlink closure push (`merge-tree --write-tree`,
3 sites); room stages its first file (`trackRoomFile`, 3 sites, and app-tester's
:5191 gate passed -- `pages 1 · build success`, room shows
`tlda settled edit cluster` with 0 dirty paths, `empty-checkout` absent); relink
declares nothing; conflict markers never published; the lockout fix.

**STALE AND IT IS THE ONE SKIP ASKED FOR:** `held-edit-mark` `9ef2fd6e5` is not
on main and not deployed -- grep of the deployed tree for its broadcast returns
**0 sites**. That is his "4 mark" (10:58:16 EDT). 3/3 green re-run. Base
`5c269b44f` vs main `67e62b396`, but the trees are identical so it applies
cleanly.

**While it is unlanded a person whose edit is held sees NOTHING, and that is a
regression I introduced** -- keeping markers out of the document removed the only
signal the editor had. The deployed build has the first half without the second.

**Open operational defects:**
1. `main`'s daemon suite cannot come back clean. Re-measured on current main:
   `git-project-sync` 8 pass / 2 fail (QMD execution inputs; configured document
   roots exclude unrelated broken TeX). `git-project-mirror-unrelated` 3/4 fail
   yesterday. Both need `--test-force-exit` to terminate. Unowned, not mine.
   **A regression in `daemon/` lands invisibly.**
2. One project's document-roots pinned where it was computed -- my error, no
   supported route back, measured cost nil. No action exists.
3. `not-on-work-branch` once per first-writer room bind: ordering, not fault.
   Not fixing unless asked.

## 2026-08-27 - the two sync demos, and two live defects neither of them expected

Skip, 3407093: *"i want to see stuff exercised in a demo; perhaps one stylized
and one playing back a previously-problematic editing session like my last one
with jose"*. Read his message directly and went to the record.

### DEMO 2 - the replay. `scratch/jose-replay.mjs`. Disposable, never his.

```
his project's checkout    HEAD = tlda/<a DIFFERENT project of his>
his project's work branch = tlda/<his project>      ON WORK BRANCH: false
daemon log 2026-08-25     proposal not accepted: not-on-work-branch  (x3)
```

**Two projects share one checkout; it stands on the other one's branch; his
never syncs.** Fleet-wide: **10 checkouts carry 27 projects**, so at most 10 of
those 27 can be on their own work branch -- **at least 17 cannot sync now.** Nine
projects logged the line in one burst today; nine of ten sampled are genuinely
off-branch, on `main`, `master`, and real feature branches.

**Two supported things that cannot both hold.** Sharing a checkout is supported;
syncing requires standing on that project's branch; a checkout stands on one
branch. The losing project FAILS SILENTLY -- edit commits, tree clean, nothing
errors, only a daemon log line.

**CORRECTION to the 08-27 disposition above:** I called `not-on-work-branch`
"transient by construction, not fixing." True of the SOURCE-ROOM BIND case I had
looked at; I generalised from one case to a message I had only seen in one
place. Not true here.

### DEMO 1 - the stylized one never ran, and why is the second defect

`tlda project link` on a BRAND-NEW disposable project never completes. Looped
**7 attempts** on `daemon request timed out: adopt-shadow-history-ref`, the
daemon re-running the seed each time with the work GROWING:

```
gaps between successive "prepared ... project history" lines
20.8s -> 20.6s -> 22.3s -> 24.3s -> 28.3s -> 36.2s -> 57.2s
```

After ~3 minutes: `sourceRevision: NONE`, `pages: 0`, `acceptSeq: null`, and the
checkout LEFT ON `main` rather than its work branch -- i.e. the failure lands in
exactly the state demo 2 is about. Stopped it; looping, not progressing.

Path is `prepareHistorySeed` -> `pushHistorySeed` ->
`sendMsgWithReply('adopt-shadow-history-ref')`. The server handler EXISTS
(`unified-server.mjs:9998`), so not a severed wire. **NOT established which side
is slow** -- the daemon log records the prepare and nothing about the reply.

**Neither fixed.** The shared-checkout one is a product decision (may a checkout
bind more than one project; must the daemon surface the silence). The link
timeout is a defect and offered to the chief.

Disposable `sync-demo-0827` project and checkout left in place as evidence.

## 2026-08-27 - one checkout, one project (`f49bfcb97`, branch `one-checkout-one-project`)

Skip settled it: *"maybe let's just disallow that"* / *"is there a reason not
to?"* / *"like, just clone right?"* (3407544, 3407547, 3407551, read directly).

**A NUMBER I REPORTED WAS WRONG, and the truth is worse.** I said "at most 10 of
27 can sync." The inventory measures the actual state: **2 of 27 are syncing.**
Most shared checkouts stand on `main` or `master`, so EVERY project in those
groups is silent -- not just the loser of a two-way race.

**Answering his question:** no reason not to. The case for sharing is two papers
in one repository, and a clone gets that -- history is shared through the remote
and each project stands on its own branch. Sharing buys one directory and costs
all-but-one project silently not syncing.

**Rejection lives in `bindSource`**, which already refused the mirror image (one
project, two checkouts). Bind is the one point every route reaches: CLI, source
room, server-side room manager.

**An existing test asserted the disallowed behaviour and was REWORKED, not
deleted.** `two projects sharing one checkout submit to their owning project
remotes` -- the shared directory was never its subject; it checks that each
project submits to ITS OWN remote via `remoteUrlFor`. It still does, with two
checkouts, each accepted head built/pushed/fetched from its owner.

**The silent failure is DEMONSTRATED, not asserted:** a third test shows one
project syncing and the other answering `not-on-work-branch` with a clean
working tree, so the guard cannot later be read as fussiness.

**`bin/shared-checkout-inventory.mjs`** lists each shared checkout, what it
stands on, and SYNCING vs SILENT per project (`--json` available). READS ONLY --
relinks nothing, clones nothing. Whose clone goes where is not a script's call.

Gate: new tests 3/3; removing the guard reddens the rejection test and only that
one; `git-sync-manager` 6 pass / 3 fail, the same three as baseline. eslint,
tsc -b, lint:guards clean.

**Memory corrected:** `two-projects-can-share-one-checkout` recorded sharing as a
supported fact. It now leads with his decision and keeps the existing-state
detail as the migration list.

**Still open, unowned:** `project link` on a NEW project loops on
`adopt-shadow-history-ref` timing out -- what stopped the stylized demo.

## 2026-08-27 - which side is slow, and the stylized demo reproduces the open loss

### `adopt-shadow-history-ref`: THE SERVER

`daemon/machine-rpc.mjs:180` -- `requestWithReply({ timeoutMs = 15000 })`, whose
error text is the literal string the CLI printed. The adopt passes no override,
so **the daemon waits 15s for the server** and gives up.

That places it AFTER the daemon's own work: `prepareHistorySeed` and
`pushHistorySeed` both finish before the send, so the 20.8s -> 57.2s growth is
each CLI retry re-running the prepare -- a consequence, not the cause.

The handler (`unified-server.mjs:9998`) answers on BOTH paths, success and
`catch`, with a comment saying it does so precisely to stop the daemon timing
out. So **no reply arrived within 15s at all**.

**Not a global stall:** live HTTP measured 530ms / 935ms / 306ms on
`/api/projects/...` and 335ms on `/api/build-info`.

**NOT isolated:** handler-slow vs message-waited. Next step is a local harness
timing the handler on a fresh project. Not done.

### The stylized demo ran (on already-linked disposable `sync-trio`)

Running it against an already-linked project sidesteps the broken link path
entirely -- the demo did NOT need that defect fixed first.

```
cycle 1   disk 25.8s OK     browser NEVER ARRIVED    remote COULD NOT WRITE
cycle 2   disk 17.3s OK     browser NEVER ARRIVED    remote COULD NOT WRITE
```

**Browser leg checked directly rather than trusting the demo's verdict.** Its
edits ARE admitted (`id=11306`) and the build succeeds, but in the published
source:

```
SYNCDEMO-32002 (disk)    PRESENT
SYNCDEMO-32005 (disk)    PRESENT
SYNCDEMO-32003 (browser) absent
SYNCDEMO-32006 (browser) absent
```

**No hold recorded either time** -- no `holding` line, `sourceSyncRefusals` and
`sourceSyncConflicts` both empty. So NOT the conflict-hold working as designed.
All three legs write the same file, so the instrument looks in the right place.

**This is the silent concurrent-edit loss recorded above as separate and open.**
Yesterday: two observations, no isolating test, and I said so. **It now
reproduces on demand, twice per run, on a disposable project.**

The remote leg fails on a `git merge` in the linked-remote pull -- NOT diagnosed,
not claimed related.
