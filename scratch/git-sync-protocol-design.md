# tlda source sync on git — design

**Stage 1 of design → review → implement → check.** Written by `git-protocol-design`
(`fleet:38a16edd`) for `chief-night`, against `main` at `c8103d849`. Design only; nothing
here is implemented.

**Everything measured here was measured tonight, on `mini.local`, at load average 13–20,
against `/Users/skip/work/bregman-lower-bound` (2,040 files on disk, 1,730 tracked at
`HEAD`).** Two independent runs, one importing a fresh object store and one reading
bregman's real objects, agree to within noise. Where I did not measure something, it says
so.

**Skip's words are the spec.** Where a line below is his, it is quoted. Where it is mine,
it is an inference and a reviewer should treat it as arguable.

---

## 0. The one-paragraph version

A project is **one git tree per revision, containing exactly the transitive closure of its
documents, and nothing else.** tlda owns a branch in the user's repository; a person names
the documents at `init` and they go onto it, and from then on **a document is a root of that
branch's tree** — no list, no manifest, nothing stored that can be derived. The daemon
commits at each settle, computes the closure *from the commit's tree* rather than from the
moving disk, and proposes it to the server as a bundle. The server's entire accept decision
is *does this descend from what I have* — fast-forward or refuse.

**Because the tree is the manifest, there is no second description of membership to diverge
from the bytes** — which is the failure that wedged two of Skip's papers. **Because the tree
is a pure function of the working copy, a crash costs nothing:** recovery is recomputation,
not replay.

---

## 1. What binds this design

### 1.1 Skip's spec, verbatim

- **Option 2, and why:** *"we use the transitive closure of doc roots, maintaining a list
  of docs in the project somewhere in the repo … and then we sync a like filtered branch or
  clone, which gets applied onto the users working copy"* — chosen over *"we just use
  whatever fucking git repo is given us"*, whose downside is *"our users are fucking
  messy"*.
- **Roots are declared:** *"roots arent implicit / again / messy people"*.
- **One list, one kind of entry:** *"there is no root/extra distinction / a doc is a doc"*.
- **Declarable formats:** *"tex md qmd are the formats we support / as roots"*.
- **No validity machinery:** *"an unbuildable file is not a root"*, then *"call that a
  broken build / since a missing documentclass is just a compile error in a way of
  thinking"*.
- **One implementation:** *"i am not debugging two versions of this feature"*.
- **Idempotence:** *"paper sync is idempotent / we can toss paper edits / they're on the
  mini, they'll sync back up"*, and *"i really want you guys to think about idempotence —
  it's like the key to having ok behavior in a messy environment"*.
- **The branch model:** *"we maintain our branch checked out, update its files, and sync
  with main like manually and or when we want to push to pv[t]"*, *"squashed"*, *"like
  'updated on overleaf by X'"*, and on user commits to map onto: *"almost always none
  tbh"*.
- **The squash message is a borrow, not an invention:** *"updated on overleaf by X is how
  overleaf writes its squashed changes when someone git pulls / im proposing the analogous
  approach for moving stuff from our branch"*.
- **We do not track `main`:** *"we follow the working copy, not main, is my take"*.
- **Commit cadence:** *"per save posibly debounced"*.
- **The budget:** *"this is a real time system / real time"*, then *"sorry like real time is
  like / in a latex sense / for a small doc like 2-3 seconds / not yjs speed"*.
- **Deletion:** *"uh yeah so like git rm hook? uh.."*
- **The manifest, and how roots are named:** *"explicit add … that's git add"*, then *"then
  we like hook-transitive-closure … like do we even need a manifest?"*, then *"git add/git
  rm your roots, let the rest be handled"*, and *"can it just be every root doc?"*
- **His own objection to the option he chose:** closure is *"complicated, brittle in the
  sense that we need to calculate transitive closure."*

### 1.2 The two failures the design has to answer

Both are real, both are Skip's own papers, and they are **the same failure with the sign
flipped**:

| | server holds | daemon declares | result |
|---|---|---|---|
| `bregman-lower-bound` | 461 files, incl. `.bak-before-deletion.tex` which the disk had lost | 13 | every push refused, all day |
| a second paper, same night | a manifest naming `figures/*` the server's own disk does not have (12 of 12 sampled 404, every `.tex` 200, control run) | fewer | deadlocked: the server won't accept while its declared set names files it lacks, and the daemon won't send files that haven't changed |

**The class: two sides maintain independent member sets, and nothing reconciles them.** In
`bhief-of-staff`'s words on the first: *"when a file disappears the daemon forgets the
server still has it rather than telling the server to delete it — so the phantom can never
be removed and every push fails forever."*

`git-protocol-review` states the bar this sets, and I accept it: **membership that shrinks
is the dangerous direction** — anything unobserved can never be reported as gone — and
closure shrinks the set hard, 461 to 13 on Skip's own paper. **A design where membership
can only grow eventually wedges; a design where it shrinks silently loses files.** §7 is my
answer.

### 1.3 The revert does not bind

`22fb6182b` *"Make LaTeX membership the closure of the document's roots"* was reverted by
`e9c3ba890` the same day. **I checked the record rather than the diff, and the revert is
disowned by its own author, twice, unprompted:**

> **2026-08-17 23:14:57 EDT**, `bhief-of-staff` → Skip: *"I said my closure change broke
> your source pushes and I reverted it. That was wrong. The daemon was declaring 13 files
> at 15:40 and 16:04 — before that change deployed at 19:01 — and 12 files back in July.
> The small watch set was never mine. So I reverted a good change on a bad read."*

> **2026-08-18 01:15:58 EDT**, same agent → `chief`: *"Same for `e9c3ba890`, my revert of
> `22fb6182b`, which I made on a read I've since shown was wrong."*

The actual cause was the phantom manifest entry above, and then a 14 GB snapshot-per-push.
**There is no recorded design objection to closure membership.** On `main` today the revert
still stands: `daemon/source-sync.mjs` passes `authorityManifest` with a null watchSet for
LaTeX and a real one for Markdown — the pre-closure asymmetry — and
`shared/tex-deps.mjs`'s `scanTexDependencyClosure` survives on `main` **with zero
callers.**

### 1.4 What I take from `pm-sync`'s dossier, and what I re-measured

Taken as structural and re-derived from the tree: the entire new accept path is on branches
(`acceptSourceSnapshot`, `applyAcceptedSourceEffects`, `source-snapshot` all read 0 on
`main`; `processProjectPush` reads 5 as the control). Nothing described as a "gap" has ever
affected a running system.

Taken as a design constraint, and it is the most valuable thing in the dossier —
`actual-versioning`'s formulation:

> **When you restore a path that was dead, everything downstream of it becomes reachable
> for the first time — so the fix's blast radius is not the diff, it is everything the diff
> re-animates.**

Three of eleven gaps were created by fixes for earlier gaps. §9.4 is what I do about it.

**Re-measured rather than inherited:** the subprocess count and every timing. §8.

---

## 2. The object model

Three named things. Two of them are refs in the **user's own repository**; one is a ref in
the **server's** bare repository. Nothing else is state.

### 2.1 `refs/heads/<tlda-branch>` — the local history

The branch tlda owns and keeps checked out in the user's working copy. **Its commits carry
the project — the documents and their closure — and not the rest of the working tree.**
One commit per settle (§6.1).

- **Its parent is always its own previous commit.** Never `main`, never a remote. Skip:
  *"we follow the working copy, not main, is my take."* Nothing tracks anything.
- **Noise here is free**, because `main` only ever receives a squash.
- **It is never pushed anywhere by tlda.** It leaves the machine only when the user asks.

**This branch is the declaration. That is the whole of §3.** A document is on it because a
person put it there at init or added it since; everything else is on it because the closure
reached it. **There is no list anywhere, because the branch content *is* the list.**

**I had this backwards and it was load-bearing, so it is worth saying what changed.** An
earlier revision made this branch carry the *whole* working tree, on the reasoning that it
is what gets squashed into `main`, so a filtered branch would delete every non-member file
from the user's own repository. **The premise was wrong.** Skip, on the `.bak` files and
scratch drafts that §3.0 measures: *"these aren't going to be on our branch."*

**And that is what kills §3.0's objection rather than answering it.** I measured 1,371
derived roots against **the user's index** — 1,730 tracked files, most of them ours. **The
question was never what is in their index; it is what is on our branch**, and the mess was
never added to it. Derived roots on this branch give the paper, because nothing else was
ever put there.

**The squash still works, and the borrow is exact.** `main` receives a merge of two
histories with a common base, not a tree replacement — so paths our branch never touched
are untouched by the squash. **This is precisely how pulling from Overleaf works today:
Overleaf's repository contains only the project, you pull it into a repository that
contains much more, and nothing of yours is deleted.** Skip chose that precedent himself
for the squash message; it turns out to govern the mechanics too.

**Flagged rather than asserted, because it is the one piece I have not verified:** the
squash's merge base. It is exact under Overleaf's shape and I have not built the case for
every history our branch could end up with — a user who rebases `main` under us, most
obviously. §12.

### 2.2 `refs/tlda/project/<project>` — the wire object

Derived from §2.1 by filtering, in the same repository, so it **shares every blob with the
user's real commits and costs no additional bytes**. Its tree contains exactly the member
set (§4) and nothing else. It is never checked out and never appears in `git status`.

- Parent: its own previous commit. It is a real chain, so history of the *paper* is
  complete and independent of the mess around it.
- Message: human-legible, and it **names what left the set** (§7.3).
- Trailer: `Tlda-Source-Commit: <sha>` — the §2.1 commit it was derived from.

**Why a trailer and not a git note.** Notes live in a second ref that has to be pushed
separately and is silently dropped when nobody remembers; a trailer is part of the commit
object, so it rides the bundle for free and cannot be lost from the thing it describes.
(`chief-night` proposed notes for a commit *correspondence* problem; Skip's *"almost always
none tbh"* dissolved that problem. This trailer is a different and smaller thing: which
local checkpoint produced this revision, needed only so a refusal can be pointed at a
moment in the user's own history.)

### 2.3 `refs/tlda/source/<project>` — the project's published head

**Skip has collapsed the participant model and it removes the last special case:**
*"literally a convergent editor on a server-side checkout of the shadow with its own
daemon"*, and *"no special casing"*.

**So: N participants, each a checkout with a daemon, all equal.** Skip's Mini, a laptop, and
the browser source editor — which is a convergent editor over a **server-side checkout with
its own daemon** — are the same kind of thing. A conflict between the browser editor and the
Mini is a conflict between two checkouts, resolved by the same fast-forward-or-refuse. No
server case, no editor case, no third thing.

**The asymmetry that remains is in the ref, not in any participant, and it has to remain.**
Fast-forward-or-refuse is only decidable against a serialization point: somebody must hold
the answer to *what have we all agreed on*. Without one distinguished ref, N peers produce N
histories and every exchange becomes a merge — which is the design Skip did not choose.

**The borrow settles it: `refs/tlda/source/<project>` is `origin/main`.** In git, N clones
are equal and the origin is not a better clone — it is the agreed name for the published
head. Everyone, including the server's own checkout, is a peer that proposes to it.

**Two things follow, and they are the things that were being run together:**

- **The server's working copy is not "the server's copy". It is a participant's checkout**,
  so it **should** be written by that participant's daemon rather than by the accept
  carrying an extra effect.

  **Read that as what the model implies, not as a description of anything that exists.** An
  earlier revision wrote it as *"it gets written because a daemon writes it — which is what
  daemons do"*, which reads as settled fact. **`pm-sync` looked for that daemon and could
  not find one**: the room applies to its Yjs document, the remote materializer writes its
  own `sourceDir` from `state.sourceDir` and hard-fails `project-not-watched` without one,
  and nothing materialises into the server's `sourceFilePath()` except the old push path
  and the effect built to replace it.

  **So this is a component the model implies and nobody has built.** It is §12 item 15, it
  is `pm-sync`'s gate to close rather than mine, and **the design does not get to assert
  the thing into existence in a bullet.** This is the second time in this document that
  prose asserted a carrier that does not exist while reading as settled — the notes ref
  (§5.2) was the first — and it is worth naming as a pattern rather than fixing twice
  quietly.
- **`refs/tlda/source/<project>` stays distinguished, and I am justifying it explicitly
  rather than removing it.** It is a name, not a privilege.

Already implemented, in `server/lib/source-git-store.mjs`, along with
`refs/tlda/applied/<bindingId>`, `built`, `mirrored`, `refused`, and every operation this
design needs: `writeBlob`, `acceptRevision`, `readManifest`, `bundleSince`, `ingestBundle`,
`fastForward`, `isAncestor`. **416 lines, all `spawn('git', …)`, zero reimplemented git.**
I am not proposing to replace it.

### 2.4 What stops being state

- **`sourceManifest`** — the list of member paths sent alongside the bytes. Deleted. The
  tree is the manifest. §7.
- **`overleafSourceManifest`, `remoteBaseline`, `nonRemotePaths`, `previousManifest`** in
  `server/lib/overleaf-sync.mjs` — the per-remote territory bookkeeping. §7.4.
- **`watchSet`, `projectWatchSet`, `authorityManifest`, `sendingPaths`** in
  `daemon/source-sync.mjs` — four overlapping notions of membership, plus
  `collectSourceManifest`'s re-check-existence pass and its comment about *"the gap between
  walking and the server validating"*. All of it exists because the manifest is computed
  from a filesystem that keeps moving. §5 removes the gap rather than defending it.

**What deleting `sourceManifest` obsoletes downstream, enumerated by `pm-sync` because they
built it and I did not.** Recorded here so nobody finds these commits later and tries to
preserve them:

- **the 18 caller migrations**, all of which send `sourceManifest`, move again;
- **`carryForward`**, which exists solely to reconcile a manifest against the files actually
  sent, goes — and with it `GET /source-entries`, and the fix for the refusal that named
  every file in the project rather than the one that changed, **which existed only because
  carry-forward made `files` the whole project.**

**That is roughly a third of one night's caller and carrier work, obsoleted by this design
rather than by being wrong.** It should be recorded as obsoleted rather than rediscovered.

**What survives, same source:** `source-git-store.mjs` untouched as §2.3 says, the accept
semantics, the ref-rollback fix, the no-op tree comparison, the crash boundaries, the
journal and dedup, and the six post-accept effects.

---

## 3. Roots

Skip's last word on this is *"git add/git rm your roots, let the rest be handled"*, and
before it *"can it just be every root doc?"* — a root being a tracked doc that nothing else
pulls in. **The second of those is a question, and §3.0 is the measured answer to it.**

### 3.0 Why roots are derived from *our branch* and not from the user's repository

Measured in-process, no subprocesses, on every paper repository in `~/work` I could find.
**I ran the last four as a control on the first, expecting them to agree with it. They do
not, and that changes the finding.**

| repo | on disk | tracked | tracked docs | **derived roots** | **members** |
|---|---|---|---|---|---|
| **bregman-lower-bound** | 2,040 | **1,730** | 1,404 | **1,371** | **1,436** |
| balancing-act | 844 | 33 | 3 | 3 | 16 |
| survival | 433 | 8 | 2 | 2 | 2 |
| eiv-paper | 114 | 7 | 5 | 5 | 6 |
| ctd-paper | 6 | 4 | 4 | 4 | 4 |

**So the honest statement is not "derived roots do not work".** On four of these they are
exactly right, because the mess is *untracked* — `balancing-act` has 844 files on disk and
33 in the index, and `git add` has already done the filtering the design wants.

**On `bregman-lower-bound` they select 1,436 files, against 11 for the two documents he
actually works in.** The mess there is tracked: 1,730 of 2,040 files are in the index.

**And this is the repository that matters.** It is the paper he is writing, it is the one
that wedged for a day, and **the first derived root, alphabetically, is
`.bak-before-deletion.tex` — the exact file that wedged it.** It is tracked. So are
`.bak-before-foc-delete.tex`, `.bak-before-mollif-delete.tex`, `.outlines/*-draft.tex`, and
the twelve files in `.scratchinputs.bak/`.

I tested the one alternative derivation before concluding. **`\documentclass` as the root
test on bregman: 22 roots.** Much better, still wrong — still led by the three `.bak` files,
and eleven of the rest are under `refs/`, other people's downloaded arXiv papers, each a
complete compilable document with its own `\documentclass`.

**1,371 → 22 → 11, and only the last is his paper.** A `.bak` copy of a paper passes every
structural test for being a paper, because it *is* the paper, byte for byte.

**`git-protocol-review` then measured *why*, and it turns this from a judgement into a
finding.** I had assumed bregman was simply the oldest and most accumulated repository.
**That is false:**

| repo | commits | tracked | first commit |
|---|---|---|---|
| **bregman-lower-bound** | **2,087** | 1,730 | 2026-04-09 |
| balancing-act | 411 | 33 | 2025-05-01 |
| survival | 33 | 8 | 2025-04-17 |
| eiv-paper | 224 | 7 | **2020-07-01** |
| ctd-paper | 2 | 4 | 2026-02-21 |

**`eiv-paper` is six years old and has 7 tracked files. Age does not produce the mess.**
Bregman is four months old with 2,087 commits — five times any other repository's lifetime
total, in a sixth of the time. **The variable is intensity of agent work, and the mess is
ours.** The bad derived roots say so on their face: `.bak-before-deletion.tex`,
`.bak-before-foc-delete.tex`, `.scratchinputs.bak/`, `.outlines/*-draft.tex`, and
`.tlda/scratch/inject-l3352-1780624894252.tex`, which is unambiguously tlda's.

**So the four clean repositories are not counter-evidence. They are the untested case** —
the ones this product has barely touched. And the property that breaks derived roots is
*produced by us*, which means it is what every repository looks like after we work in it,
and the ones we work in are the ones that matter.

**That also supplies the mechanism for something reached separately: `git add` cannot be the
membership signal, because Skip did not do most of the adding.**

*(One caveat the reviewer would not hide and neither will I: the commit counts and dates are
measured; **attributing those specific `.bak` files to agents is inference from their names**,
sound for the one file that is certainly ours.)*

**I used this to argue for a declared root list. That was wrong, and the number was
answering a question nobody asked.**

I measured derived roots against **the user's index**. Skip, on those files: *"these aren't
going to be on our branch."* **The question is not what is in their index — it is what is
on our branch (§2.1), and the mess was never put there.** Derived roots on our branch give
the paper, because a person named the documents at init and nothing else was ever added.

**So my objection dies and the file goes.** I withdraw it. What the measurement is still
good for is the thing it actually shows: **you cannot derive the project from a working
repository**, which is *why* §2.1's branch has to exist as a separate thing rather than
being the working tree. It is evidence for the branch, not against the derivation.

**1,730 tracked files in the paper he is writing tonight** is the number to keep. It is the
reason *"we just use whatever fucking git repo is given us"* was rejected, measured.

**A second thing this control turned up, unlooked for:** `survival` tracks **5 files that
are absent from disk**. That is the second wedge of §1.2 visible from the other side — the
index and the disk already disagree in the direction that produced *"the server's manifest
names figures its own disk does not have."*

### 3.1 There is no list. The branch is the declaration.

Skip, shown `declared(R) = lines of tree(R):DOCUMENTS`: *"that's an agent describing a
manifest no? that's not part of my design. does someone want to argue with me?"*

**Nobody is arguing. The file is gone.** No `DOCUMENTS`, no `.tlda-docs`, no `.tlda/docs`,
no `declared(R)` reading anything out of stored state.

**A document is a root of our branch's tree** — a tracked doc that nothing else on the
branch pulls in. That is the same derivation §3.0 measured, applied to the branch it was
always meant to apply to (§2.1) rather than to the user's index.

**And when someone wants the list, they ask for it.** Skip: *"if you want a list / ask the
cli"*. `tlda docs` (name is mine, not his) computes it from the branch on demand.

Three consequences, and the first is the whole design in one line:

1. **Nothing is stored that can be derived.** A stored copy is a thing that can be wrong,
   and **every wedge in §1.2 was a stored copy being wrong.**
2. **One answer, one place.** The app, an agent, the CLI and Skip ask the same question of
   the same code. There is no file for anyone to hand-edit into disagreement with the tree.
3. **`tlda init` is an act, not a write.** A person says which documents; those go onto our
   branch. **Init adds files to a branch — it does not author a list.**

**This is the fourth time a written-down list has come back into this design**, twice
through me, and each time with a good argument. I argued that a manifest describes state
and can be wrong while a declaration states intent and cannot. **The distinction may even
be true and it was beside the point** — the mechanism should not exist, and a good defence
of a mechanism is what stops you noticing that.

**The tell, for whoever reads this next: any predicate of the form
`declared(R) = <something read from a file>`. If the answer to "what is a document" is
anything other than "a root of the tree", it has come back.**

### 3.2 The first day

**The first day is `tlda init`, and it is an act rather than a write.** Skip: *"the doc list
comes manually when someone tlda inits or whatever the project"*, and *"if you want a list /
ask the cli"*.

**A person says which documents. Those go onto our branch.** From that moment the branch
answers the question, and it keeps answering it without anybody maintaining anything.

**The state that used to be dangerous no longer exists to be guarded.** While there was a
list, an absent one meant an empty member set, so the first settle proposed an empty tree
and every synced path was a deletion — and I answered that with a rule distinguishing
*absent* from *empty*.

**Both the danger and my guard are gone with the file.** A branch with no documents on it is
not a project that computed the wrong answer; it is a project nobody has initialised, and
there is nothing to sync because nothing was ever put there. **`init` is the only way
content arrives, so "before init" is not a state the sync path can be in.**

**That is the second time on this point that removing the mechanism beat guarding it**, and
it is the same move as §7.2: a state that cannot occur beats a guard that has to fire.

**What remains is a one-time act by a person**, for the three projects that predate this:
someone runs `init` and names the documents. That is not a migration and Skip's *"i am not
debugging two versions of this feature"* is not engaged — there is one mechanism, and three
projects go through it.

### 3.3 This absorbs `referencedRoots`, and that is a live behaviour

Today `shared/source-manifest.mjs` seeds membership from **two** places: `mainFile`, and
`referencedRoots` — paths referenced in chat, which make a file a member whatever its
extension. That second seed is the route `b4-outline.md` came in by; its comment records
that without it *"the column made from it froze at the moment it was opened — with no build
to fail and nothing to report."*

**Under this design there is one list, so opening a chat reference as a column must append
that document onto our branch.** That is Skip's collapse applied to a mechanism that already
exists, and it is the only behaviour-preserving reading of *"a doc is a doc"*.

**Flagged for review as a behaviour change, not smuggled:** the append is a write into the
user's repository triggered by a UI action. I believe it is the intended reading. It is not
mine to decide alone.

---

### 3.4 A declared document that does not exist, or does not compile

Nothing happens at membership time. Skip: *"an unbuildable file is not a root … call that a
broken build / since a missing documentclass is just a compile error in a way of
thinking."*

- A declared path absent from the tree contributes **no members** and is recorded in the
  revision's `missing` set. `scanTexDependencyClosure` already returns exactly this and its
  comment already says why.
- A present file with no `\documentclass` contributes its closure normally. It fails at
  build, as a build error, in the build's own error channel.

**There is no validity check, no type check, and no gate.** A declaration you cannot build
is a broken build, which is a thing the product already knows how to say.

## 4. Membership

For a revision *R*:

```
docs(R)     = { p ∈ tree(R) : p ends .tex, .md or .qmd }
roots(R)    = { d ∈ docs(R) : no e ∈ docs(R) pulls d in }
members(R)  = ⋃  closure(d, tree(R))
             d ∈ roots(R)
```

**Nothing is read out of a file. `roots(R)` is computed from `tree(R)` and nothing else** —
which is the property §3.1 exists to protect, stated where an implementer will copy it.

`closure` is the existing scanner — `shared/tex-deps.mjs` for `.tex`,
`shared/markdown-deps.mjs` for `.md`/`.qmd` — with **one change: it must read from a git
tree, not from the filesystem.** Today both take a `sourceDir` and call `fs.statSync` /
`fs.readFileSync`. They need an oracle instead: *does path P exist in this tree*, and
*give me P's bytes*.

That is not a rewrite. Both scanners already isolate their filesystem contact in two
places (`resolveWithExtensions` and the read at the top of the walk loop), and the tree
backing is two subprocesses **for the whole closure regardless of its size**: one
`ls-tree -r --name-only` for the existence set, and one long-lived `cat-file --batch` for
contents.

**This is the reason the whole design holds together and it is worth stating plainly.**

### 4.1 Membership is computed after the commit, from the commit

The order is: **commit the working tree first, then compute the closure against that
commit's tree.**

Not the other way round. Every membership bug in the current daemon is a consequence of
computing the set from a filesystem that keeps moving while you compute it — and the code
knows it. `collectSourceManifest` carries a comment beginning *"A walk implies existence,
which was true until the gap between walking and the server validating got long enough to
matter"*, and then defends the gap with three separate mechanisms: `authority` so a
disappeared file is not undeclared, `sendingPaths` so a file read into the payload but
since deleted is not undeclared, and a re-`existsSync` pass for quarto's scratch files that
appear and vanish mid-render (*"a different file each render, which is why it reads as
intermittent and unfixable"*).

**Commit first and the gap does not exist.** A tree is immutable. The closure over it is
computed at leisure, cannot race anything, and gives the same answer forever. All three
defences, and the four overlapping membership sets they operate on, are deleted rather than
repaired.

This is also the answer to `chief-night`'s hard part — *membership changes within the
commit that adds an `\input`*. It does, and it is not a problem: the `\input` and the
membership it creates are both facts about one immutable tree, read in that order.

### 4.2 Measured: what this actually costs

Closure of the real paper, against `/Users/skip/work/bregman-lower-bound`:

| | |
|---|---|
| files on disk | **2,040** |
| files with `\documentclass` at top level | **8** |
| closure of `bregman-lower-bound.tex` | **10** |
| closure of `b4-outline.md` | **1** |
| union, both declared | **11** |
| scan time, filesystem-backed, warm | **7.5 ms** for the Markdown root; 99 ms cold for the TeX root incl. module load |

**Two things in that table are the argument for the whole design.**

**2,040 → 11.** That is the ratio between what the mess is and what the paper is.

**Eight files carry `\documentclass`.** Skip's *"roots arent implicit / again / messy
people"* is not a stylistic preference — auto-detection on his own paper selects eight
roots at the top level (22 across the tree, §3.0), seven of the eight being `-old`, `-icml`
and cut drafts. **The declared list is the feature.**

### 4.3 Cycles

LaTeX permits `a.tex` to `\input` `b.tex` and `b.tex` to `\input` `a.tex`; TeX recurses
until it runs out of capacity. **So the graph is not structurally a DAG, and a cycle is a
compile error** — Skip's existing rule, needing no new machinery.

**But the closure walk must not merely survive a cycle, it must report it.** Both existing
scanners already terminate on one — `scanTexDependencyClosure` keeps a `tex` set and skips
anything already visited — so a cycle produces a *correct* member set silently. That is
fine here.

**The real hazard is on the derivation side, and with §3.1 it is live rather than
hypothetical.** In a cycle every file is pulled in by another, so **nothing in the cycle is
a root**. Roots are now derived from the branch and nothing else, so a cycle among a
project's only documents makes `roots(R)` empty, `members(R)` empty, and **the whole project
silently vanishes from itself.**

**An earlier revision of this section said the design did not have this hole because roots
were declared. It has it now**, and the correct response to Skip removing the file is to say
so rather than to leave the old sentence standing.

**So this is the one place a computed set is allowed to fail loudly instead of returning an
answer:** if the document graph contains a cycle, `roots(R)` is **an error, not a smaller
set.** It reports the cycle as a broken project state and the settle does not propose.

**This costs nothing to detect** — the included-by map is already computed for orphan
collection (§7.3), and a cycle is a node reachable from itself in it. **Never let a root or
orphan computation return a quietly smaller set**, which is the general form and the one
worth carrying: an empty answer from a graph computation and an empty answer from an empty
project are indistinguishable downstream, and only one of them is true.

### 4.4 `subfiles`: a document that is also a fragment

The `subfiles` package makes a file both a standalone compilable document and something a
parent `\input`s. Under an included-by test it stops being a root.

**Decision: it does not matter here, and that is the reason to prefer the declared list.**
A `subfiles` chapter is `\input` by its parent, so it is not a root, so it is a member via
the parent's closure and never its own document. **That is the right default** and it needs
no rule.

**If a derived list is chosen instead** (against §3.0), then the rule should be: **a
`\documentclass` overrides the included-by test.** That is the `subfiles` convention's own
signal, it is one line, and it is the same borrow the rest of the design runs on — the
package says a subfile carries `\documentclass{subfiles}` precisely to mark it standalone.
`scanTexDeps` already recognises `\subfile` and `\subfileinclude` as followable, so the
graph side is in place.

---

## 5. What crosses the wire

### 5.1 Up — daemon proposes

One request carrying:

- the **bundle** of `refs/tlda/project/<project>`, from the server's acknowledged head to
  the new commit. `bundleSince` already does this, and its own comment records why: the
  whole history in one base64 body *"timed out at 53 s on 2026-08-17 and stopped mirroring
  bregman altogether."*
- `expectedRevision` — the head the daemon believes the server holds.
- identity: `sourceDaemonKey`, `sourceMachineId`, `sourceBindingId`, `requestId`.

**Nothing else. No file list, no manifest, no content array.** (The bundle's ref list is §5.2,
and it is enumerated — anything not named there does not travel.) The bundle carries the
bytes, the tree carries the membership, and the commit carries the provenance.

### 5.2 The bundle enumerates its refs, so anything not named does not travel

**This is the one place in the design where the reconstruction hazard lives**, and it is
worth stating where an implementer will hit it rather than where the feature is described.
`bundleSince` on `main` builds an explicit list:

```js
const range = have && await isAncestor(have, revision) ? [`${have}..${ref}`] : [ref]
if (includeRefused && await readRef('refused', project)) range.push(refFor('refused', project))
await git(['bundle', 'create', bundlePath, ...range])
```

**Two refs, named one at a time.** A ref that is not in that list does not ride the bundle
in either direction — **and the failure is silent, because the commits arrive perfectly and
only the thing nobody enumerated is missing.** That is AGENTS.md §"Prove the wire, not the
two ends", in its reconstruction shape: both ends have the feature, nothing carries it.

**So the refs that travel are named here, and this list is the spec:**

| ref | direction | condition |
|---|---|---|
| `refs/tlda/project/<project>` | both | always — this is the revision |
| `refs/tlda/refused/<project>` | down | when a refusal exists (already implemented) |
| **`refs/notes/tlda/<project>`** | **both** | **when it exists** — attribution (§6.2) |

**Attribution travels.** Skip reads the version history in tlda's UI, which reads it from
the server, so metadata that stayed on one machine would be metadata he cannot see. It is
also small: notes are a few bytes per commit.

**One detail not to get wrong, and it is why this is a spec line rather than a one-word
change.** The `have..want` subtraction above is computed from `refs/tlda/mirrored`, which
tracks the *project* ref. **The notes ref has its own history and moves independently** —
an amend inside the settle window rewrites notes without moving the project ref at all. So
it needs **its own `have` marker**, or every bundle re-sends the whole notes history. That
is the same mistake as bundling the full project history, which *"timed out at 53 s on
2026-08-17 and stopped mirroring bregman altogether"*, just smaller and slower to notice.

### 5.3 Down — server tells the daemon

`bundleSince(project, revision, { includeRefused: true })` — already implemented, including
the refused-commit ref, whose comment states the point exactly: *"a refused push is a real
commit that never became the head. It rides the same bundle so the person who made it can
look at it."*

### 5.4 Carrier: a bundle over the wire we already have — not `git push`

**I am declining `git push` with a `pre-receive` hook**, and the reasons should be
argued with rather than accepted.

What `git push` genuinely offers, all of it real and all of it available on this box (git
2.50.1, and `/Users/skip/work/deploy/testing` already runs an arbitrated `pre-receive`
remote here):

- **Negotiation** — the client and server compute haves/wants, so no object is sent twice.
- **The `pre-receive` sideband** — stderr streams back as `remote:` lines, a genuine
  structured-refusal channel.
- **Push options** (`-o k=v` → `GIT_PUSH_OPTION_n`) for intent.

Why I decline it anyway:

1. **Negotiation is solving a problem we do not have.** It exists because the two ends do
   not know each other's state. Ours do: the server's reply on every accept carries its
   head, and `bundleSince` subtracts exactly that. The one case where the daemon's belief
   is wrong is a non-fast-forward, which is a case we must handle anyway.
2. **A hook is a second wire, and this repository's most expensive recurring failure is a
   second wire nobody proved.** `pre-receive` runs in its own process; every effect an
   accept owes — the build, the room fan-out, the Overleaf push, the refusal trace — would
   have to travel from that process back into the server. AGENTS.md §"Prove the wire, not
   the two ends" is a list of what happens then. Accepting in the server's own process, by
   calling `createSourceGitStore`, has no wire in it at all.
3. **The sideband is worse than the reply we already have.** A refusal needs
   `evidence.classifications[]`, the conflicting revision, the merged text with markers,
   and the identity that holds the lock. That is a structured object. `remote:` lines are
   a text stream we would have to serialise into and parse back out of.
4. **A new endpoint is a new deploy and auth surface**, on Fly, for a thing the existing
   authenticated route already carries.

**What I lose and want a reviewer to weigh:** with `git push`, a wedged project can be
inspected and repaired with stock git from a terminal — `git push`, read the refusal, fix,
push again — with no tlda process involved at all. With a bundle in an RPC, recovery needs
our code to be working. Given that both wedges in §1.2 needed hand repair, that is not
nothing. **I still think the second-wire cost dominates, but this is the weakest link in
my argument.**

### 5.5 Rejected: sparse-checkout and partial clone

Both filter **what a client materialises from a repo it already has**. Our requirement is
the opposite: **the server must never be given the mess.** Neither restricts what is sent.

Partial clone is worse than merely irrelevant: it makes a repository whose refs can point
at trees whose blobs are absent, fetched on demand from a promisor. That destroys the
single invariant §7.2 rests on. **`--filter` must be forbidden on the server's source
repository, and that is a thing to write down where someone will read it before adding it
as an optimisation.**

---

## 6. Cadence, and where git sits relative to the render

### 6.1 A commit is a settle, not a keystroke

Skip: *"per save posibly debounced"*, and *"this is a real time system … in a latex sense …
for a small doc like 2-3 seconds / not yjs speed."*

**Established rather than assumed, because `chief-night` asked and it changes what the
debounce attaches to:** the browser source editor **is** CRDT-backed.
`src/shapes/FleetSourceEditorShape.tsx` imports `yjs` and `y-codemirror.next`, constructs a
`Y.Doc` and a `getText('source')` per file, drives CodeMirror through `yCollab(ytext,
null)`, and runs a per-file `WebSocket` source room (`sourceSyncPath(projectName,
sourcePath)`) applying updates with `Y.applyUpdate(…, 'source-room')`. Its own header says
it *"pushes checkpoints through the normal project authority path."*

**So there are three writers into the accept, and git hears from none of them
continuously:** the room checkpoint, Overleaf, and the daemon watching disk. Live
co-editing is resolved in the room and git never learns it happened.

**But the editor is not a special writer.** Skip: *"yjs editor works like any other daemon
backed shit"*, and *"no special casing"*. Its edits reach the daemon and the file changes,
exactly like an agent's write, a CLI push, or someone typing in vim.

**So "settled" is not a concept to build.** I had started to define it as a Yjs room
quiescing; that would have been a mechanism for one writer, which is the special case Skip
removed. **The file changed. That is the whole event**, and the debounce is an ordinary
idle window on it, identical for every writer.

**The value.** I propose `batch(3s)` idle, configured, not a literal — the unit is part of
the value (AGENTS.md §"Notation is borrowed").

**The ordering, re-derived, because my first one rested on a premise §6.3 then removed.**
I originally ranked history legibility last on the grounds that window length is sync
latency against the 2–3 s budget. **§6.3 establishes that git is not on the render path, so
that latency argument does not apply, and the reason I used to overrule `chief-night` is
gone.** Re-deriving from what survives:

1. **It bounds what an unclean shutdown loses.** This is now the first criterion, and it is
   real but weak: §9's I6 says the loss is *recomputed from disk*, not replayed, so what a
   lost window costs is the record of an intermediate state, never the state itself.
2. **It must not compete with the build for the machine.** Also real, also weakened by
   measurement — §8 says a settle is four subprocesses and ~1.1 s on real content, so at a
   3 s window the duty cycle is already low, and at 30 s it is negligible either way.
3. **Legibility of the version history.** `chief-night`'s criterion, and **with my
   objection withdrawn it has the strongest surviving claim**, because Skip reads this
   history and nothing else in the list is about something he looks at.

**So the honest conclusion is that my `batch(3s)` was argued from a premise I then
retracted, and the argument now points at a larger value.** I am leaving the proposal at
`batch(3s)` and flagging it rather than silently moving it, because the number should come
from someone watching what the history reads like — which is a product judgement and, per
§12, not settled here. **What I will assert is the ordering above, not the value.**

**Not settled, and it needs checking rather than choosing:** whether an editor that saves
by delete-and-recreate defeats the settle window. `daemon/source-sync.mjs` already carries
the atomic-save case and why a file the server knows must stay declared through the gap;
§4.1 removes the reason that mattered, but the *watcher* still sees a delete followed by a
create and must not treat the gap as a deletion. **The rule that falls out: a path observed
absent is not a deletion until the settle window closes with it still absent.**

### 6.2 Attribution is not on the write path

Skip: *"it's not something we worry about at fucking send time / **it's not something the
daemon should worry about at all** … resolution to a daemon, fine … resolution to an agent —
that's like, metadata. either tag or amend the commit msg or whatever"*.

**Two levels, and only one of them is on the write path:**

| level | when | how |
|---|---|---|
| **daemon** | at commit time | the daemon knows it is the daemon. **`Author` is the daemon. No lookup.** |
| **agent or person** | afterwards | **metadata** — an amended message, or a note |

**Nothing on the write path waits for, consults, or can be wrong about identity. The daemon
commits as itself and moves on.**

**This retires a hard part rather than solving it, and I had built the wrong thing.** An
earlier revision of this section authored the commit *from the edit event*, with the
watcher as a fallback — a correlation on the write path that can be wrong, can be late, and
can be missing. **It is deleted.** Skip's own account of why agent attribution is hard —
*"it's based on resolution of events ingested from jsonls"* — describes a **downstream join
over the ingester's output**, not a step in a commit.

So `daemon/source-sync.mjs:1355`'s `resolveEditor` correlation, which I reported as the
mechanism this design would consume, **is not consumed by the commit at all.** It remains
useful to whatever writes the metadata afterwards. It is simply not in this path.

**The amend-versus-note boundary, which is the one thing here that can corrupt something:**

| state | mechanism | why |
|---|---|---|
| **unpushed**, inside the settle window | **amend** the open commit | most attribution lands this way for free, and it composes with the window the debounce already defines |
| **pushed** | **`refs/notes/*`** | an amend rewrites the sha, so amending a pushed commit forks history |

**State the test, not just the pair.** *"Amend or note"* without the pushed/unpushed
condition is exactly the instruction that gets implemented as an unconditional amend and
corrupts a published branch.

**And this reverses a judgement I made in §2.2, which I should say rather than let a reader
find.** There I rejected git notes and used a commit trailer instead, on the grounds that
notes live in a second ref that gets forgotten. **That reasoning was about a different job**
— provenance that must never be separable from the commit it describes — and it still
holds there. **Here notes are correct**, because the requirement is precisely to attach
information to a commit that already exists without touching it.

**The footgun is real and does not go away by being appropriate**, and an earlier revision
of this sentence walked straight into it: it said the notes ref *"is pushed and fetched with
the project like any other ref."* **This design has no push and no fetch.** §5.4 declines
`git push` deliberately and §5.1 says the daemon sends the project bundle and *nothing
else* — so that sentence named a carrier that does not exist, while reading as settled.

**The carrier is the bundle, and it is enumerated. See §5.2.**

### 6.3 Git is not on the render path

`chief-night` named two exits from the latency budget and asked me to evaluate both. **Take
both; they are not alternatives.**

**The structural one: the build reads the bytes it was handed, and the commit happens
alongside as the durable record of what was rendered — not as a gate in front of it.** The
2–3 seconds then belongs to LaTeX, which is where Skip put it. A design that puts *any*
accept between a keystroke and a rebuilt page is spending his budget on bookkeeping.

**The cheap one: make the accept fit anyway**, because a build that is dispatched from a
revision that has not been accepted yet is a second source of truth about what is being
rendered. §8 says the accept fits — 3 subprocesses, ~470 ms — so we get both without a
trade.

---

## 7. Shedding, and why the wedge class stops existing

This is the section `git-protocol-review` set as the bar, and it is where I claim the
design earns its keep.

### 7.1 The disease is a manifest beside the bytes

Today a push carries `files[]` **and** `sourceManifest[]`, and the server stores its own
authority set. That is **two representations of one fact**, and every wedge in §1.2 is
those two representations disagreeing. No amount of validation fixes it, because validation
is what turns a disagreement into a refusal.

### 7.2 A tree cannot disagree with itself

**The tree is the manifest.** `source-git-store.mjs` already says this, in the comment on
the accept decision:

> *"the tree that arrived IS the manifest, so a path that left the paper is absent because
> nobody named it rather than because somebody remembered to list it."*

Two consequences, and both are structural rather than guarded:

**A member with no bytes is unrepresentable.** A tree names blobs; git's fetch verifies
connectivity before the ref moves. So if `refs/tlda/source/<p>` points at *C*, every blob
in *C*'s tree is in the object store. **The second paper's failure — a manifest declaring
`figures/*` the server does not have — cannot be written down in this design.** (This is
the invariant §5.5 protects by forbidding `--filter`.)

**Shedding is just a smaller tree.** The proposal carries a complete tree, not a delta, so
`.bak-before-deletion.tex` is gone from the project by not being in it. **There is no
authority set left to violate, so there is no refusal to be stuck behind.** bregman's
461 → 13 becomes an ordinary commit that removes 448 paths — and it is a commit, so it is
in history and reversible, which is more than the old store could say for a file dropped
from a manifest.

### 7.3 Absence is deletion, and what makes a deletion suspicious

**Skip's rule, and it is better than the one I had written:** absence in a tree *is*
deletion. A tree has no unmentioned state, so there is nothing to reconcile and no phantom
is representable. **Shedding stops being a mechanism to design and becomes a property.**

I had proposed carrying a shed *reason* — `gone` versus `unreferenced` — so that removing
an `\input` would not delete a colleague's copy. **I am dropping it.** It adds a second
description of the change alongside the tree, which is the disease this whole section
exists to cure, and the case it protects is recoverable: the file is in history on both
sides. **One mechanism, no special case.**

**But the property cuts both ways, and the dangerous side is the one to design for.** With
tree semantics, the 461 → 13 incident would not have wedged — it would have **deleted 448
of Skip's files**. Wedging is loud and recoverable; silent mass deletion is neither. So the
safety moves from *we cannot express deletion* to *we can, and something checks a large one
before it lands.*

**The predicate I first wrote was wrong, and `git-protocol-review` killed it.** I had:
*a deletion is legitimate iff a root was removed in the same change.* Cutting a section —
delete `\input{sec3}`, delete `sec3.tex` — removes no root, so **the most ordinary
structural edit in writing a paper was refused.** So was `git rm` of any non-root file.
The safety instinct was right and the predicate was not.

**Skip states the rule, and it splits by kind:**

> *"we manually remove roots and then automatically delete unreferenced files"*

| | how it goes |
|---|---|
| **a root** | **manually** — `git rm` from our branch. Never automatic. |
| **everything else** | **automatically** — when **no root** references it. Never manual. |

**"Unreferenced" means unreferenced by *any* root, and that is the DAG case doing its own
work.** Remove one paper and its private figures go; `macros.tex` stays because two other
papers still `\input` it. **This is what the `gone`-versus-`unreferenced` tag was invented
for, achieved by not inventing it** — which is why dropping the shed reasons was right.

**What follows is the check that enforces that rule**, not a competing one. It needs no side
data and no threshold:

> **Refuse a revision in which a path that was in the previous tree is absent from the new
> tree while the new tree still references it.**

**The server can compute this itself, which is the whole point.** It holds both trees, and
the referencing documents *are in the tree* — so it re-derives `members(newTree)` with the
same closure the daemon ran and compares. That is an independent check in a component that
is not the daemon (§7.5), it is exact rather than heuristic, and §8 says the tree-backed
closure costs about two subprocesses.

Against the cases:

| change | still referenced? | verdict |
|---|---|---|
| cut a section — `\input` and file both go | no | **accept**, ordinary |
| `git rm` a retired figure | no | **accept**, ordinary |
| `git rm` a figure the paper still `\includegraphics` | **yes** | **refuse**, naming it — and this is a real save |
| crawler drops `sec3.tex` while `body.tex` still `\input`s it | **yes** | **refuse**, naming it |
| a file referenced and absent from *both* trees | never existed | **accept** — Skip's rule, a broken build, not a refusal |

**Membership stays a pure function of one tree; the guard is allowed to look at two**,
because a guard is inherently about a change. That distinction is what my first attempt
blurred.

**One consequence, found by `git-protocol-review` and real: a settle window can split an
ordinary two-step edit.** Delete `sec3.tex`, then remove `\input{sec3}` four seconds later,
with a 3-second window. **Revision 1 has the file gone and the reference live, so it
refuses. Revision 2 accepts and it self-heals.** No data is at risk — the daemon's next
settle carries both halves — but routine editing would produce refusals in the UI.

**So a refusal of this shape is damped, not surfaced immediately:** the check refuses the
revision, the daemon does not surface it, and it surfaces only if the *next* settle
reproduces it. **An alarm that fires constantly and an alarm that never clears are the same
alarm** — nobody reads either — and `pm-sync`'s gap 11 is that failure from the other
direction.

**This is a third input to the settle-window value (§6.1), and unlike legibility it is
about correctness:** a longer window makes the split less likely, because more of a
two-step edit lands in one revision. It does not eliminate it, and nothing should be tuned
to pretend it does — the damping is what makes it a non-event.

### 7.4 And the mass-deletion guard can go entirely

I had proposed a magnitude check with an acknowledgement token. **Working the cases through,
it is unnecessary, and the reason is worth stating because it inverts the scare.**

**The 461 → 13 transition is correct and harmless under this design.** The 448 files that
leave are `.bak-before-deletion.tex`, `.outlines/`, `.scratchinputs.bak/` — none of them
referenced by the paper, so the reference check above does not fire, and **they are not
deleted from anybody's disk.** §2.1's branch carries the user's whole working tree; only the
*project* tree sheds them. Nothing is lost, and the thing everyone has been calling "448 of
Skip's files deleted" is 448 files leaving *sync scope* while sitting untouched in his
directory and in history.

**The scare came from reading the project tree as the user's files. It is not.** That is the
same conflation §2.1 exists to prevent, and I had it myself while writing §7.3.

**So there is no threshold, no acknowledgement token, and no tree-sha binding to build.** I
am withdrawing my own acknowledgement-token mechanism. The accidental collapse is caught by the reference
check — because an accidental collapse leaves the references intact, which is exactly its
signature — and a deliberate one is deliberate.

*(The deletion-size measurement I started is therefore moot. For the record it was
directional only, cut short by timeout: real deletions across four of his papers run one to
two files at a time.)*

**Orphan collection is "nothing else needs it", not "its parent went away".** The
dependency graph is a DAG, not a forest: a shared `macros.tex` is `\input` by several
documents. `git rm` one of three papers and the macros file stays, because the other two
still reach it. **Getting this wrong deletes a file that is still in use**, and the
included-by map §3.0 measures is exactly what answers it.

### 7.5 Where the check lives, and why not `pre-receive`

`chief-night`'s constraint is right and I am adopting it: **a guard that lives in the
component it is guarding is not a guard.** The daemon computes the closure, so a bug in the
daemon's closure is what produces a collapsed member set, so the daemon cannot be the one
to check it.

**It does not follow that the check needs `pre-receive`.** Under §5.4 the accept already
runs in the **server's** process, which is equally not-the-daemon, and it has both trees in
hand: one `diff-tree --name-status old new` — one subprocess — gives the deleted paths
exactly. It then re-derives `members(newTree)` with the same closure (§7.3) and refuses any
deleted path the new tree still references.

**Implementers: the check is §7.3's, not a root-removal comparison.** An earlier draft of
this section justified the placement by saying the server can compare the old root list
against the new one to see whether a root was removed. **That was the rationale for the
predicate §7.3 killed, and building it would reinstate the rule that refuses cutting a
section.** The server does hold both versions of the file, and that fact is not used here.

**And the refusal is better as a reply than as a sideband.** `remote:` lines are a text
stream; the refusal needs to name the paths as structured data (§10).

*(§7.4 withdraws the acknowledgement token this section used to describe. If a magnitude
check is ever reintroduced, the one thing worth keeping from it is that the acknowledgement
must bind to the proposal's **tree sha** rather than be a boolean — `allowMassDelete: true`
authorises any deletion, including a different one that arrives after the user clicked.)*

### 7.6 Hooks are convenience on his path, never load-bearing on ours

**We author our own commits**, so the daemon runs the closure and stages the dependencies
before committing. **No hook, and nothing to bypass.**

A hook exists only so that a `git commit` *Skip types by hand* does not produce a commit
referencing a file it did not include. **That is convenience on the human path.** A design
that depends on a hook firing has a `--no-verify`-shaped hole in it, and this one does not:
if the hook never runs, his hand-made commit is missing a file, the closure records it as
`missing` (§3.4), and the build says so.

### 7.7 This answers Skip's own objection to closure

He raised it against his own preferred option: closure is *"complicated, brittle in the
sense that we need to calculate transitive closure."*

**It is still a crawler and it will still miss things** — §12 lists six TeX constructs I
have not verified it handles. **But under this design a miss means *a file was not in this
commit*, which git surfaces at once and locally, rather than *a list silently disagrees
with disk forever*, which is what both wedges in §1.2 actually were.**

**The failure mode moves from silent and permanent to loud and local.** That is the whole
answer to the brittleness objection, and it is why the crawler being imperfect is
survivable here and was not survivable before.

### 7.8 Reconciliation, when the two sides disagree

Under this design **they can only disagree in one way: ref position.** There is no set to
compare, so there is no set to diverge. The states are:

| daemon's proposal vs server head | resolution |
|---|---|
| descends from it | fast-forward. Accept. |
| equal to it | already current. No-op, no effects. |
| does not descend | **refuse.** The daemon ingests the server's head, merges, and proposes again (§9.2). |

**No third state exists**, and in particular there is no "accepted but inconsistent" state
for a human to unwedge by hand. That is the property both incidents in §1.2 lacked.

`fastForward` and `isAncestor` in `source-git-store.mjs` already implement exactly this.

### 7.9 What this costs Overleaf, and it is a simplification

`server/lib/overleaf-sync.mjs` maintains `overleafSourceManifest` as *"what THIS remote last
told us it had"*, and computes `nonRemotePaths` so a remote cannot delete content it never
introduced — a **territory** model, carefully built, with a sibling problem on the replica
side.

That model exists because several ingestion routes write into one flat manifest and each
needs to know which paths are its business. **Under this design the routes are commits on
one branch and territory is expressed by ancestry**, which git already computes. The
territory bookkeeping goes.

**Flagged, not resolved:** Overleaf's own repository is a real git remote with its own
history, so the Overleaf path is a genuine merge between two histories, not a fast-forward.
That is the one place in the system where a real merge belongs, and it is where the
*"updated on overleaf by X"* borrow comes from in the first place. I have not designed it,
and I say so in §11.

---

## 8. Cost — measured

**All numbers: `mini.local`, load average 13–20, git 2.50.1 (Apple Git-155), macOS 26.5.2,
10 cores.** Two harnesses, twenty and ten iterations. Median, with min and max, because the
spread under load is the point.

### 8.1 The finding: spawn count is the entire cost function

| operation | spawns | median | min | max |
|---|---|---|---|---|
| **control: one `git --version`** | 1 | **150 ms** | 86 | 366 |
| `ls-tree -r` — whole path set of 1,730 files | 1 | 156 ms | 100 | 295 |
| accept over parent, 2 changed paths | 4 | 667 ms | 461 | 868 |
| **filtered tree from scratch, M = 13** | 3 | **467 ms** | 353 | 647 |
| filtered tree from scratch, M = 100 | 3 | 475 ms | 267 | 769 |
| filtered tree from scratch, M = 500 | 3 | 412 ms | 309 | 649 |
| **filtered tree from scratch, M = 1,730** | 3 | **554 ms** | 371 | 883 |

Second harness, fresh object store, 2,040 files, 10 iterations: control spawn 132 ms
median; filtered tree M = 13 → 467 ms; M = 2,040 → 709 ms; accept over parent (6 spawns) →
1,018 ms. **Two independent runs, same shape.**

Three things follow, and they decide the design:

1. **A subprocess costs ~130–150 ms on this box under this load. Everything git actually
   does is free next to that.**
2. **Tree size is free.** Building a tree of 13 paths and a tree of 1,730 paths differ by
   ~90 ms — inside the noise of a single spawn. **So there is no incremental-versus-whole
   trade-off to make: always build the complete filtered tree.** That is what §7.2 needs,
   and it turns out to cost nothing.
3. **The budget is a spawn budget.** Anything per-file is fatal: the same harness importing
   2,040 blobs with one `hash-object` per file took **372,672 ms — six minutes.**

### 8.2 The nine subprocesses: organic, not inherent

`chief-night` asked whether the other seven are inherent. **They are not.** The inherent
accept is:

```
hash-object -w --stdin-paths   (1 spawn, all changed files)
update-index --index-info      (1 spawn, complete member set)
write-tree                     (1 spawn)
commit-tree                    (1 spawn)
```

**Four, flat in file count.** Measured at 467–709 ms, which fits inside Skip's 2–3 seconds
with the build — and §6.3 takes it off the render path anyway.

The seven that are organic, each with its own reason for existing:

- **`run('rm', ['-f', indexFile])`** — a whole subprocess to delete a temp file. `fs.rm`
  is already imported in the same file, two lines above.
- **`hash-object` per file** — should be one `--stdin-paths`.
- **`cat-file -s` per file for `blobSize`** — should come from `ls-tree -l`, and
  `readManifest`'s own comment already says so: *"asking per file turns one subprocess into
  one per file on a book with 1499 of them."* The comment is right and the accept path does
  not take its advice.
- **`read-tree` of the parent** — not needed at all when building the complete tree
  (`replaceTree`), which §7.2 requires anyway.

**So the cheap accept and the correct accept are the same accept.** That is unusual enough
to be worth checking rather than believing, and it is on my list for the reviewer.

### 8.2a Two independent instruments, and the latency question is closed

**`chief-night` re-measured on real content** — `bregman-lower-bound`, 1,730 files / 41 MB,
one file changed, load 19: **four-spawn accept, median 1,127 ms, min 818, max 1,402.**
Slower than my 467–709 ms, and the difference is real content against a synthetic subset.
*(Their first run printed negative milliseconds because it spawned `python3` twice per
iteration to read the clock — the instrument cost more than the operation. The figure above
is the corrected single-process run.)*

**`git-protocol-review` re-measured with their own harness rather than mine**, deliberately,
as an independent control: bare `git --version` **143.8 ms** median, `ls-tree -r` over 1,730
files **108.9 ms**. **That reproduces the load-bearing row: listing the entire tree costs
less than starting a process that does nothing.** Three instruments, three authors, same
conclusion — *always build the complete tree, never a delta*.

**And the latency constraint is gone, which retires an argument I made twice.** Skip:
*"bregman takes like 20s to build."* **1.1 s of accept against a 20 s LaTeX run is about
5%**, and the 2–3 s budget is a *small-document* budget.

**So: do not optimise the sync path for speed.** It is already fine, on the real paper, by
an order of magnitude. §6.3's conclusion — git runs alongside the render rather than in
front of it — stands on its own merits, and §8.2's four-spawn accept is a reason not to
bother with `fast-import` rather than a target to hit. **What is left as a constraint is
correctness and attribution.**

### 8.3 What I did not measure

- **An idle box.** I could not get one; the fleet was on it all night. **A control spawn at
  150 ms is dominated by fork/exec under load, so every absolute number here is a
  worst-case.** The *ratio* results — spawns dominate, tree size free — do not depend on
  that, because both sides of the comparison pay the same process cost.
- **Whether the new accept is faster or slower than the path it replaces.** `pm-sync` flags
  this as unestablished and it still is.
- **`git fast-import`**, one persistent process with zero per-accept spawns. If four spawns
  is one too many, that is the next move and it is a known technique; I did not need it and
  did not measure it.
- **The tree-backed closure scanner** — it does not exist yet, so its two-spawn cost is an
  estimate from the `ls-tree` and `cat-file --batch` shapes, not a measurement.

---

## 9. Idempotence

Skip: *"i really want you guys to think about idempotence — it's like the key to having ok
behavior in a messy environment."* Stated as claims, so a reviewer can attack one.

### 9.1 What is idempotent, and why

- **I1 — `members(R)` is a pure function of `tree(R)`.** The declared list is in the tree;
  the closure reads only the tree (§4.1). Nothing consults the clock, the disk, or a cache.
- **I2 — the filtered tree is a pure function of `tree(R)`.** Verified: five builds of the
  same 500 paths produced **one** distinct tree sha; the control, 499 paths, produced a
  different one, so the instrument is not vacuously passing.
- **I3 — two daemons with identical working copies produce identical project trees.** From
  I1 and I2. This is what makes multi-machine editing converge instead of oscillate.
- **I4 — a proposal whose tree equals the head's tree is not sent.** See below.
- **I5 — ingesting the same bundle twice is a no-op.** Content-addressed objects, and the
  quarantine ref is set to the same sha.
- **I6 — a crash costs nothing.** Recovery is *recompute from disk*, not *replay a queue*.
  There is no in-flight state, no journal to drain, no pending set to reconcile. **This is
  the claim that matters and it is the one Skip was pointing at:** *"we can toss paper
  edits / they're on the mini, they'll sync back up."*

### 9.2 Idempotence is at the tree, never the commit — and this kills a live defect

`commit-tree` puts a timestamp in the commit sha, so **the same content commits to a
different sha every time.** `pm-sync` found the consequence already shipped: *"a no-op
proposal minted a fresh commit that fast-forwarded and fired every post-accept effect"* —
the no-op build storm.

**So the equality test is on trees, and the rule is: if the filtered tree equals the
current head's tree, do not commit and do not propose.** The storm is then impossible by
construction rather than caught by a guard downstream. This is why I4 is stated at the
daemon and not as a server-side check.

### 9.3 What is not idempotent, said plainly

- **The commit history on the tlda branch.** A crash mid-window loses a checkpoint, and the
  next settle produces a commit with different boundaries. **The state is reproducible; the
  history is not.** That is the right trade and it should be written down so nobody
  "fixes" it.
- **The squash to `main`.** Human-initiated, demand-driven (Overleaf squashes on *pull*),
  and should not be idempotent.
- **Provenance through a pull.** Skip: *"we follow the working copy, not main."* A
  collaborator's work arriving by `git pull` becomes a commit on our branch that looks like
  the local user's edit. **Overleaf has exactly this property**, the real history is still
  in `main`, and it is the price of the branch being a pure function of disk — which is
  what I1–I6 rest on. **Written down explicitly so nobody later "fixes" it and costs us
  idempotence.**

### 9.4 Effects, which are where idempotence actually breaks

Everything above is about the revision. The **effects** downstream of an accept — build,
room fan-out, Overleaf push, replica dispatch, refusal trace — are not pure, and `pm-sync`'s
§2a is the warning: three of eleven gaps were created by fixes for earlier gaps, because
restoring a dead path re-animates everything downstream of it.

**Mechanism: every effect is keyed by (revision, effect) and records completion as a
ref.** The store already does this for one case — `refs/tlda/built/<project>` — and
`markBuilt`/`markMirrored` are already compare-and-swap. **Generalise the thing that
exists** rather than adding a journal beside it: `refs/tlda/<effect>/<project>`, moved only
on completion, CAS'd so two workers cannot both claim it.

Consequences: a replay re-runs only effects whose ref is behind; a crash between the ref
move and the effect leaves the ref behind, so the effect re-runs, which is the safe
direction; and *"has this been built"* stops being a field that can drift from the thing it
describes.

**The re-animation hazard is not solved by this and I will not pretend otherwise.** §12
carries what I want done about it instead.

---

## 10. Refusal, and how it reaches the author

A refusal is a real commit that never became the head. `markRefused` and the
`includeRefused` bundle path already exist.

- **Immediately**, in the reply to the proposal: status, the server's actual head, the
  classifications, and the merged text with conflict markers where there are any.
- **Durably**, as `refs/tlda/refused/<project>`, so it survives the request, and it rides
  the next bundle so **other participants can see whose work is stuck** — the thing
  `pm-sync`'s gap 6 records as missing (*"the pusher learns from an HTTP status and nobody
  else ever learns"*).
- **Carrying the machine**, `sourceMachineId`, so the answer to *whose work is stuck* names
  where to go and look — gap 7.
- **Cleared on the accept that supersedes it**, by the same identity that wrote it — gap 11
  is an alarm that never clears, and an alarm that never clears is one nobody reads.
- **Surfaced in immobile UI**, not on a shape. This repo's rule and Skip's.

**The refusal names one file, not the project.** Gap 10 is a refusal naming every file in
the project as stuck work; with a tree we know precisely which paths conflict, because the
merge computed them.

---

## 11. Conflict

**The daemon rebases. The server never merges.**

The server's whole decision is fast-forward-or-not (§7.4). When it refuses, the daemon:

1. ingests the server's head from the refusal bundle;
2. **three-way merges the project trees** — base `refs/tlda/applied/<bindingId>`, ours our
   proposal, theirs the server's head. Per path, `git merge-file`, which is what already
   produces the `merged` text with genuine conflict markers that `pm-sync` proved decodes
   correctly;
3. writes merged content into the working copy **for member paths only**, honouring the
   shed reasons in §7.3;
4. **holds the settle loop while any member path is conflicted**, so conflict markers are
   never committed and never propagate into anyone else's prose;
5. surfaces it, in immobile UI, naming the paths.

**Why the daemon and not the server:** the working copy and the person are both on the
machine, the daemon owns machine-local state (AGENTS.md §"The server reports daemon facts;
it does not own daemon state"), and a merge resolved anywhere else has to be applied
somewhere it cannot see.

**This is the Overleaf-parity case**, and it is the only merge in the system apart from the
squash. Skip's *"we can toss paper edits / they're on the mini, they'll sync back up"* is
the fallback when a merge is not wanted: dropping our side is safe precisely because I6
says the next settle recomputes it from disk.

---

## 12. What I did not settle

Named rather than smoothed, in the order I think they matter.

1. ~~Whether roots are declared or derived.~~ **Closed, and I withdrew it** (§3.0). My
   measurement was against the user's index; the roots come from our branch, where the
   mess was never added.
2. ~~The first day.~~ **Closed** (§3.2) — `init` is an act, and "before init" is not a
   state the sync path can be in.
3. **The squash's merge base** (§2.1). Exact under Overleaf's shape, which is the
   precedent Skip chose; I have not built the case for every history our branch could meet,
   a user rebasing `main` under us most obviously. **This is the piece of §2.1 I am least
   sure of and it replaced something I had wrong.**
4. **The Overleaf merge.** §7.9. Overleaf is a real remote with its own history, so that
   path is a genuine two-history merge and not a fast-forward. It is also the origin of the
   *"updated on overleaf by X"* borrow. I did not design it and it is the largest hole
   here.
5. **The branch is visible in the user's own repo.** `git status` in Skip's own directory
   will say something he did not choose. **Measured, and it is not hypothetical:**
   `bregman-lower-bound` is on `fleet-backup-20260612` with 166 dirty files;
   `balancing-act` on `master` with 116; `eiv-paper` on `eiv-decoupling-repair` with 23.
   His repos are *already* on branches somebody else picked, with large dirty sets. **This
   is a product decision and I am surfacing it, not making it.**
6. **Adding a chat-referenced document to our branch** (§3.3) is a behaviour change and a
   write into the user's repository from a UI action. I believe it is the intended reading
   of "a doc is a doc". It is not mine to decide.
7. **The settle-window value.** I propose `batch(3s)` and my reasoning (§6.1) explicitly
   disagrees with `chief-night`'s. That disagreement should be resolved by someone, and the
   deciding question is whether the version history's legibility can be recovered by
   grouping at read time. I think it can.
8. **`git push` versus a bundle** (§5.4). I decline the hook; my own account of what that
   costs — stock-git recovery of a wedged project from a terminal — is the weakest link in
   this document.
9. **Delete-and-recreate saves** (§6.1). My rule is that absence is not deletion until the
   window closes. Not verified against a real editor.
10. **Projects that are not git repositories.** Every project I sampled is one, but tlda
   would have to `git init` in a directory it does not own. Product decision, not mine.
11. **Whether the closure scanners are complete.** They are pre-existing and I did not audit
   them. `\import`, `\subimport`, `\lstinputlisting`, `\verbatiminput`, `graphicspath`, and
   `.bbl` are all things a real paper uses; `scanTexDeps` handles six command families and
   I did not check it against Skip's actual papers beyond counting the closure. **§7.3c is
   why this is survivable rather than fatal**, but it is still the most likely source of a
   "my figure did not sync" report.
12. **`fast-import`** as the zero-spawn accept, if four is one too many. §8.3.
13. **Cycle reporting** (§4.3). I say `roots(R)` errors on a cycle and the settle does not
    propose; I have not said where that surfaces or what it says. **Raised in priority by
    §3.1** — with roots derived, a cycle among a project's only documents empties the
    project, so this stopped being a tidiness item.
14. ~~`resolveEditor`'s notion of *recent*.~~ **Closed by Skip, twice over** — attribution
    is not on the write path at all, so there is nothing to correlate at commit time
    (§6.2). Kept visible because I listed it as open two revisions ago and built the wrong
    mechanism for it once.
15. **Does the server-side checkout have a daemon, and is it the room's or a new one?**
    `pm-sync` put this to stage 1 and it is the right question. **The design's answer is
    that it needs one** — under §2.3 the server's checkout is an ordinary participant, and a
    participant's checkout is written by its own daemon. So the "seventh effect" is either
    scaffolding to remove or that daemon's write wearing an unfamiliar name, and **which one
    it is depends on a component that does not clearly exist yet.** `unified-server.mjs:1556`
    already splits the room from remote daemons, which is the special case *"no special
    casing"* removes — so converging them is a change, not a re-derivation. **I am not
    closing `pm-sync`'s working-copy gate on this and it is not mine to close;** the design
    says what should write that checkout, not that anything currently does.
16. **`.tlda/scratch/` membership.** `\inputscratch` is a followable closure edge, so the
    closure can reach into a directory tlda's own `.gitignore` excludes — in bregman, two
    of seven files there are tracked and five are not. Latent rather than live, since
    bregman's roots do not `\inputscratch` anything.
17. **The notes ref's own `have` marker** (§5.2). I say it needs one; I have not said
    where it is stored, and `refs/tlda/mirrored` tracks the project ref only.
18. **The distribution of real deletion sizes.** My measurement was cut short by timeout
    and is directional only (§7.3). It no longer decides anything, because the deletion
    rule is exact rather than thresholded — but if anyone reintroduces a threshold, this is
    the number they need and it does not exist.

---

## 13. What stage 2 should attack first

If I were reviewing this, these are where I would expect it to break:

- **§2.1, hardest, because it is the newest and it replaced something I had backwards.**
  The branch carries the project rather than the working tree, and the squash onto `main`
  is a merge with a common base rather than a tree replacement. **I argue that from the
  Overleaf precedent and I have not built the case for every history our branch could
  meet.** If the merge base is wrong in some ordinary case, non-member files in the user's
  own repository are what pays for it — the worst blast radius in the document.
- **Whether a list comes back a fifth time.** Four times a stored declaration re-entered
  this design, twice through me, each time with a good argument. **The tell is any predicate
  of the form `declared(R) = <read from a file>`.** If "what is a document" has an answer
  other than *a root of the tree*, it is back.
- **§7.3's deletion rule.** *A deletion is legitimate iff a root was removed in the same
  change* is clean, and I want it attacked on the case where a root is removed **and**
  something unrelated is deleted in the same settle window — the rule authorises both.
- **§8.2's claim that the cheap accept and the correct accept are the same.** That is
  suspiciously convenient and I would not take it from someone else without re-deriving it.
- **§4.1's claim that committing first removes the race.** It removes it from *membership*.
  It does not remove it from the *watcher*, which still observes a moving filesystem — I
  moved the problem to one place rather than eliminating it, and §6.1's absence rule is
  the only thing standing there.
- **§9.4.** Effect keying is the thinnest part of this document and it sits exactly where
  `pm-sync` measured the highest defect rate.
- **My numbers.** Re-run them. The harnesses are
  `bench-tree.mjs` and `bench-accept.mjs` in this session's scratchpad, both with controls
  in them; `git-protocol-review` should re-run rather than read them, per AGENTS.md
  §"a zero from a failing command is indistinguishable from a zero from a working one".
