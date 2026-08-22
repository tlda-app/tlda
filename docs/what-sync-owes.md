# What sync owes

This is the statement of what source synchronization must do, recovered from
sixteen test files that held it and are now mostly deleted.

**It is not a description of the current implementation, and it is not a test
suite.** The mechanism these promises used to reach through — `processProjectPush`
and the serialized accept path around it — has been removed. The replacement does
not exist yet. So these are **acceptance criteria**: the properties the new
mechanism must satisfy before anyone can say sync works, written so an
implementer can check against them rather than rediscover them.

## How this document came to exist, and why it is not a test

On 2026-08-19, `scratch/old-sync-test-sort.md` sorted 23 test files that
referenced the old accept path and found that most of them were not tests of an
implementation:

> **The finding that decides this: most of these files are not tests of the old
> implementation. They are the written specification of what sync owes Skip, and
> several quote him directly in their header comments.** Delete them with the
> old path and the new path ships with no statement of what it must do — which
> is the "ruined by subsequent work" outcome, arriving green.

It named sixteen as specifications that had to be carried across the deletion,
with a standing rule at the bottom:

> **A test that quotes Skip in its header is a specification, not a fixture.**

**Nothing was carried.** Measured on `main` at `5969602f682b`, 2026-08-22:
**twelve of the sixteen files are deleted; four survive**, and all four survivors
throw before their first assertion because the store API they call was removed.
**Zero of the sixteen are currently verified by anything.**

The warning quoted above was written two days before that became true.

**This document recovers the promises, not the tests.** No test was restored and
none was written — the cannot-start group has an owner and that work is not this.

## How to use it

Each entry below is one promise, stated as a property of the system rather than
of the mechanism that used to carry it. Under it:

- **Acceptance** — what must be true for the promise to be kept. This is the row
  to check an implementation against.
- **Recovered** or **Inferred** — see below.
- **Origin** — the file that held it and the commit that deleted it, so the
  original assertions can be read if the wording here is not enough.

### Recovered against inferred, and the difference matters

- **Recovered** means the file's header states the promise and this document
  quotes or closely paraphrases it. Where it quotes Skip, **his words are
  verbatim with whatever attribution the header carried.** His words are the part
  nobody can reconstruct later; assertions can be rewritten by anyone.
- **Inferred** means the header does not state the promise and it is read out of
  the assertions. **These are the weaker rows.** They are marked so that a
  disagreement about one is settled by reading the origin file, not by arguing
  from this document.

Twelve are recovered. Four are inferred, in whole or in part, and say so.

### On names

**No project is named anywhere in this document.** Two of the origin headers name
one; where a quoted error message contained a project name it is written
`[project]` and the redaction is noted at that entry. Shapes, dates, counts and
durations are carried in full — they are the evidence and none of them requires a
name.

---

# A. The floor: nothing that got anywhere is lost

## A1. An edit is exposed for a bounded, known window and no longer

**Acceptance.** Git is the floor: anything that reached a remote or the shadow
history is recoverable. The only genuinely losable edit is one that never reached
either. **The window between a person typing and the text reaching the source
authority must be bounded, and its length must be a known number** — not an
assertion that the window is zero, which would mean a push per keystroke.

The old path's window was: text lives in the server's memory as one Y.Doc per
project and file, and reaches the authority when the room checkpoints
`pushDelayMs` after the last edit — **250 ms by default**. A server death inside
that window loses the text: no file on disk, no revision, nothing for git to be a
floor under.

**The new path must state its own equivalent number.** The promise is not the
250 ms; it is that the exposure ends and that somebody can say when.

**Recovered.** Skip's criterion, quoted in the header as "tonight":

> "I shouldn't be risking a paper... unless you're gonna run a delete operation
> on fucking GitHub or Overleaf, nothing is gonna go away. But the goal is to not
> lose fucking data."

**Origin.** `bin/an-edit-that-reached-nowhere-test.mjs`, deleted in `f6d0f9089`
*"Delete parallel server source authority"*.

## A2. A process that dies mid-accept loses no work, and disk does not diverge from authority

**Acceptance.** A crash at any point during an accept leaves the system in a
state a reader can trust: no half-published revision, and no divergence between
what is on disk and what the authority reports.

**Carry this caveat unresolved — it is the sort document's, not mine.** The old
dangerous window was *snapshot → write bytes → record revision*, with disk itself
as the place a reader could see half-written content. **The new path has no
snapshot, so the window changes shape.** The promise still stands and **someone
has to say where the new window is.**

The last recorded analysis, which is about the git-backed store and may itself
need re-deriving: content-addressed objects are written touching no ref, so a
crash there publishes nothing; publishing is a single atomic compare-and-swap on
a ref, so there is no half-applied ref state. The window moves to a narrower,
later one — the ref advances and *then* a local cache of the state name is
written, and a crash between those two leaves the cache stale. That was held to
be self-healing because a read re-derives from the live ref rather than trusting
the cache.

**Recovered**, with the caveat carried verbatim in intent from
`scratch/old-sync-test-sort.md`:

> **`source-restart-mid-edit` needs its window re-derived rather than repointed
> blindly.** … The new path has no snapshot, so the window changes shape — but "a
> process that dies mid-edit does not lose the work" is still owed, and someone
> has to say where the new window is.

**A method note the origin file is emphatic about, worth keeping:** the crashes
must be **real process kills, not injected throws.** A throw runs the rollback the
code already has; a restart does not, and recovering without one is the thing
under test.

**Origin.** `bin/source-restart-mid-edit-test.mjs` — **survives on `main` and
cannot start.**

## A3. A crash at either durability boundary loses no work and the retry is answerable

**Acceptance.** Two boundaries, each named for what is durable at it:

- **after-accept** — the revision is durable and the journal is not.
- **after-terminal-result** — the journal is durable and the effects have not run.

A crash at either loses nothing, and a retry afterwards gets a real answer rather
than an error or a silent no-op.

**One deliberate semantic the origin file asserts rather than merely describes:**
because the revision is durable at the ref move, a retry after a crash
**re-accepts as a clean rebase onto the revision it created** — a second commit
with identical content. **No work lost; history one entry longer.** An
implementation that instead errors, deduplicates, or drops the retry has not kept
this promise, it has changed it.

**Recovered.**

**Origin.** `server/lib/durable-source-acceptance.test.mjs`, deleted in
`f6d0f9089`.

## A4. A replayed request does not double-apply

**Acceptance.** One durable terminal result per operation, **replayed rather than
re-run.** A repeated request returns the stored result; it does not perform the
work twice.

This is the idempotence rule from `AGENTS.md` §"Idempotence is what makes a messy
environment survivable" landing on the accept path specifically: re-running must
converge rather than duplicate.

**Recovered.**

**Origin.** `server/lib/source-operation-ingress.test.mjs`, deleted in
`f6d0f9089`.

## A5. A character typed into a socket that goes away is not lost silently

**Acceptance.** An update in flight when a room socket closes must not vanish
without a trace. **This is a gesture, not a fault** — the origin file is explicit
that this is not a network story: opening and closing a panel tears down and
rebuilds the room connection, cleanly and with no leak, **on an ordinary button
Skip presses constantly.** So the window is reachable in normal use, and a
character lost there is lost on a click.

**Scope, stated in the origin file and worth preserving:** the server-side half —
a source-sync socket closing around an update — is reachable without a browser.
The unmounting copy's document destroy happens only in a React tree and is not
reachable this way. **If everything else holds, that destroy is the remaining
suspect.**

**Recovered.**

**Origin.** `bin/typing-when-the-socket-goes-away-test.mjs`, deleted in
`f6d0f9089`.

---

# B. More than one person

## B1. Two daemons plus the editor is where real collaboration starts, and the count is a loop bound

**Acceptance.** The topology must scale as **2 + n** with no new code per
participant: the two-person case and the six-person case run the same path. An
editor in the browser is **a participant of the same kind** as a daemon and slots
in beside them rather than being a special case.

**The seam is the part that must work.** A daemon's edit and an editor's edit
reach the same file by two different routes — one submits directly, one
checkpoints from a room. **The failure this produces is the silent one: a flush
that reverts work the room never heard about.**

**Recovered.** Skip's threshold, quoted in the header:

> "one daemon plus the editor is a baseline. Two daemons, baseline. Two daemons
> plus the editor is starting to be a real collaboration. And then we can go from
> there... like, two n. That's the pattern."

**Origin.** `bin/collaborators-and-an-editor-test.mjs`, deleted in `f6d0f9089`.

## B2. The daemon rows of that same matrix

**Acceptance.** *n* people pushing at the source authority from their own
machines, with no room involved, converge. Same rule as B1: **the count is a loop
bound, not a mechanism** — nothing needs rewriting when someone asks for four.

**Recovered.**

**Origin.** `bin/collaborators-on-one-project-test.mjs`, deleted in `672ba4d90`
*"Cut daemon source sync over to Git proposals"*.

## B3. Two participants editing different files both land; two editing the same file produce a legible refusal

**Acceptance**, in two halves:

- **Disjoint edits converge.** Participant A submits, participant B submits
  against the older base, and B is accepted **as a clean rebase**. Afterwards
  both edits are present in the resulting revision and the head is B's revision.
  Neither participant's work is dropped and no human is involved.
- **Overlapping edits refuse cleanly.** When both touch the same file, the second
  is **refused as stale-base**, carries a per-path classification of `conflict`,
  and **the first participant's content is intact and unchanged** at their
  revision.

**Inferred.** This file has no header comment — only a shebang. The promise above
is read from its assertions and is therefore the weakest-sourced entry in section
B. If it is disputed, read the file.

**Origin.** `bin/two-participant-source-convergence-test.mjs` — **survives on
`main` and cannot start.**

## B4. A file nobody touched does not refuse a push

**Acceptance.** A binary file — a figure — that neither participant modified must
not cause a refusal. There is no three-way merge for bytes, so any design that
requires **every path in the project** to be a mergeable candidate will have one
bystander refuse a push it had nothing to do with.

**Why this one is load-bearing out of proportion to its size, and the lesson
generalises:** every other collaboration story in the suite used a project made
entirely of text, and **every one of them passed while this was broken on any
real paper.** A text-only fixture cannot see this class. **A fixture with the
shape of a real document — figures included — is the requirement, not a
refinement.**

**Recovered.**

**Origin.** `bin/a-paper-with-figures-in-it-test.mjs`, deleted in `a48b5a07a`
*"Remove retired source-room test metadata"*.

---

# C. A refusal is something its author can act on

## C1. A refusal names what differed, and in which direction

**Acceptance.** When a push is refused, the refusal tells its author **what
differed and which way** — computed as structured per-path evidence **before any
English sentence exists**, naming every path touched on either side and whether
each is a clean rebase or a real conflict.

Direction is the whole diagnosis, and the two directions mean opposite things:

| what the evidence shows | what it means |
| --- | --- |
| a path the declared set has and the submitted set lacks | a file the sender never sent |
| a path the submitted set has and the declared set omits | a file the sender should have deleted |

**Recovered.** The incident, 2026-08-18: source pushes failed **all night on the
same three lines, four times over two and a half hours**, with only this —

> source change rejected for [project]: Source transaction failed: stale-base
> source change rejected for [project]: Source transaction failed: stale-base
> source change rejected for [project]: Proposed snapshot does not match sourceManifest

**Redaction noted:** the origin header carries a project name in each of those
three lines and in its own first line. It is written `[project]` here. Nothing
else in the quote is altered.

That message said the two sets differed and nothing else. **The cost of not
saying which way was two and a half hours of reconstructing it by hand.**

**A note the origin file is careful about, and it applies to every entry in this
document:** it was **re-derived for the new path rather than repointed onto it.**
The old mechanism — a manifest-versus-snapshot mismatch producing a sentence
naming one path — does not exist any more, and the new refusal is a structurally
different failure. Repointing would have swapped what is proven rather than
preserved it. **The promise is the thing that survives; the wording is not.**

**Origin.** `bin/a-refusal-that-names-what-differed-test.mjs` — **survives on
`main` and cannot start.**

## C2. A refusal that produced no conflict markers is still recorded

**Acceptance.** A refusal must leave a trace **whether or not any file produced
merge markers.** If conflict state is written only from classifications that came
back saying `conflict`, then a refusal where nothing produced markers records
nothing at all — **the person who pushed learns from their HTTP status and every
other instrument reports the paper as fine.**

**Binary files are the ordinary route into this, not an exotic one.** Two people
replacing the same figure produce a refusal with no markers anywhere in it. The
same shape was measured on a real document on 2026-08-13 with a bibliography
neither side had marked up.

**A proof requirement the origin file states and that `AGENTS.md` §"Prove the
wire" governs:** recording is something *the route* does with what the lifecycle
refused. **Calling both halves from one process proves both halves and nothing
about whether a refusal reaches the record.** A check for this promise must cross
that boundary.

**Recovered.**

**Origin.** `bin/a-refusal-that-left-no-trace-test.mjs`, deleted in `a48b5a07a`.

## C3. Adding a document the way the app offers is not a deletion

**Acceptance.** A file added through the app's own affordance — clicking a
filename chip in chat — must not subsequently read as a deleted file. **Clicking
the chip is the feature working.**

The mechanism of the original failure is worth carrying because it is a shape,
not a bug: **a project's file set was recomputed from its main file, and a
chat-referenced document is a second root rather than a leaf reachable from the
main one.** The rescan therefore dropped it while the declared set still
contained it, and a path present in both was refused. **Any design that derives
membership by walking from one root will reproduce this** unless additional roots
are first-class.

**The blast radius is the part to remember: his edits stopped reaching the paper
entirely, for every push touching any file of that type** — not just the clicked
one.

**Recovered.** Skip, 2026-08-13 ~23:35 EDT, on a live project he was working in:

> "mirror sync fails. Source change for [project] was rejected by the server.
> Source manifest still contains deleted file agents dot m d"

and on how the file got there:

> "I fucking added agents dot m d by clicking on your fucking agents dot m d
> link"

**Redaction noted:** the first quote named the project; written `[project]`.

**One instrument rule from this entry, which cost two false reports on the
night:** the only thing that means a push landed is **the current revision
advancing.** A last-contact timestamp is written **on receipt**, before the push
is processed, so it moves just as happily for a push that is about to be refused.
**A revision that does not move is the only evidence that nobody's work is
landing.**

**Origin.** `bin/a-document-he-clicked-is-not-a-deletion-test.mjs`, deleted in
`672ba4d90`.

---

# D. Linked remotes

## D1. A project with a linked remote works in both directions

**Acceptance.** Two people typing in the browser, and a third author who has
never opened the app pushing to the linked remote. **Does your work reach them,
and does theirs reach you?** Both directions are owed:

- **Outbound** — a room checkpoint publishes to the remote **by the same door a
  daemon's push uses.** Not a second path.
- **Inbound** — a remote advance reaches the people editing.

**Carry this caveat unresolved.** The origin file records the inbound half as
**expected red**, inherited from D2: a remote advance was applied by the inner
function inside the lock while the notification handler sat on the wrapper, so
nobody was told. The file's own note on what should happen when that is fixed:
*if it goes green, the story stops being a finding and starts being a regression
guard.*

**Recovered.** Skip asked for this configuration directly:

> "is that do we have, like, the git story? Worked out too? Like, the sort of
> Overleaf type situation?"

**Origin.** `bin/the-room-and-a-git-remote-test.mjs`, deleted in `e3ba10559`
*"Make Git remotes ordinary daemon sources"*.

## D2. When a remote advances, the people editing are told

**Acceptance.** A collaborator who does not use the app pushes to the linked
remote. The app pulls the change and writes it into the project's source.
**Everyone with that project linked must be told.**

**The failure is silent in the worst available way.** Someone keeps editing
against a revision the project has already moved past, and either finds out by
being refused, **or does not find out at all — because a clean three-way rebase
quietly reconciles it and the version they were writing against is simply gone.**

**A structural requirement this entry establishes:** an accepted change must fan
out **for every carrier**, not per route. The original defect was that one
carrier's accept never set the field the fan-out checks, so **nobody was told
about any accepted push**, not merely about remote pulls. A design with per-route
notification will regrow this.

**Recovered.**

**Origin.** `bin/a-remote-pull-tells-nobody-test.mjs`, deleted in `e3ba10559`.

## D3. A browser edit concurrent with a remote edit is refused; a non-overlapping one reaches the remote

**Acceptance**, two promises the origin file attributes to Skip:

- A browser edit made concurrently with a remote edit **must be refused** — a
  conflict answer, not an acceptance.
- A **non-overlapping** browser edit **must reach the remote.**

**Carry this caveat unresolved.** Both were failing when the file was last read,
and **deliberately so**: the outbound publish is unwired on purpose. The function
that would publish **"has never been called by anything, ever"**, and its old
caller is gone. Wiring never-executed code into the path a live document travels
**"was judged the wrong risk to take even though the gap is real. It stays
unwired on purpose."**

**The discipline the origin file applied here is the reason this entry is worth
more than the others in D, and it is the rule this whole document exists to
serve:**

> **The assertions are left exactly as they were** … Weakening them to match
> current behaviour would turn his promise into a description of the gap, and a
> test that passes for a new reason is worse than one that is red for the right
> one.

**Do not soften D3 to match whatever the new mechanism does.** It is the check
for the outbound work, and it is supposed to fail until that work exists.

**Recovered.**

**Origin.** `test/linked-remote-divergence.test.mjs`, deleted in `e3ba10559`.

---

# E. Scale

## E1. Reading one file does not read any other file's bytes

**Acceptance.** Opening a single file out of a large project must not require
reading the whole project. On a **1492-file** book, the whole-snapshot read was
**525 MB** — which is not slow but **impossible**, because it exceeds the
runtime's maximum string length and throws. With per-file content addressing the
same parse is **259 KB**: one line per file rather than one file's worth per
file.

**State the promise precisely, because the obvious stronger version is false.**
This is **not** a claim that reading one file is O(1) in project size — the entry
list still grows with the number of files. **The property owed is that one file's
bytes do not require any other file's bytes.**

**The instrument is worth copying and is the best one in the sixteen:** delete
every other file's content and read the target anyway. If it returns the right
bytes it demonstrably did not need the others — **proven by making the
alternative impossible rather than by timing it.** And the control matters as
much as the assertion: **after the deletion, reading a file whose content is gone
must fail.** Without that control, a cached or inlined read passes vacuously,
*"which is the shape of every green that means nothing."*

**Recovered.**

**Origin.** `bin/one-file-out-of-a-big-book-test.mjs` — **survives on `main` and
cannot start.**

---

# Provenance, and the caveats I did not resolve

## Where each promise came from

| # | promise | origin | state on `main` |
| --- | --- | --- | --- |
| A1 | bounded exposure window | `an-edit-that-reached-nowhere` | deleted `f6d0f9089` |
| A2 | restart mid-accept | `source-restart-mid-edit` | survives, cannot start |
| A3 | durable at both boundaries | `durable-source-acceptance` | deleted `f6d0f9089` |
| A4 | replay does not double-apply | `source-operation-ingress` | deleted `f6d0f9089` |
| A5 | socket goes away mid-keystroke | `typing-when-the-socket-goes-away` | deleted `f6d0f9089` |
| B1 | 2 + n, editor is a participant | `collaborators-and-an-editor` | deleted `f6d0f9089` |
| B2 | the daemon rows | `collaborators-on-one-project` | deleted `672ba4d90` |
| B3 | two participants converge | `two-participant-source-convergence` | survives, cannot start |
| B4 | a bystander file does not refuse | `a-paper-with-figures-in-it` | deleted `a48b5a07a` |
| C1 | a refusal names what differed | `a-refusal-that-names-what-differed` | survives, cannot start |
| C2 | a marker-less refusal is recorded | `a-refusal-that-left-no-trace` | deleted `a48b5a07a` |
| C3 | a clicked document is not a deletion | `a-document-he-clicked-is-not-a-deletion` | deleted `672ba4d90` |
| D1 | linked remote, both directions | `the-room-and-a-git-remote` | deleted `e3ba10559` |
| D2 | a remote advance tells everyone | `a-remote-pull-tells-nobody` | deleted `e3ba10559` |
| D3 | concurrent refused, disjoint published | `linked-remote-divergence` | deleted `e3ba10559` |
| E1 | one file does not read the others | `one-file-out-of-a-big-book` | survives, cannot start |

Twelve deleted across five commits; four surviving and unable to reach their first
assertion. **Zero currently verified.**

## What is inferred rather than recovered

- **B3 in full.** No header comment; the promise is read from the assertions.
- **A2's new window**, which is explicitly *not* recovered — the old window is
  recovered and the sort document says the new one has to be derived by someone.
- **D1's outbound/inbound split** is recovered; the claim that outbound uses "the
  same door" is stated in the origin header against the old mechanism and is
  carried here as a requirement rather than as a description.
- **C1's direction table** is recovered from the header's prose and restated as a
  table. The wording is mine; the two directions and their meanings are the
  file's.

Everything else is recovered from a header that states it.

## Caveats carried, deliberately unresolved

Three, per the brief, plus one adjacent thing I could not resolve honestly:

1. **A2 — the dangerous window must be re-derived**, not repointed. The new path
   has no snapshot, so the window changes shape. Someone has to say where it now
   is.
2. **D1 — the inbound half is recorded as expected red**, inherited from D2. If it
   goes green the entry becomes a regression guard rather than a finding.
3. **D3 — both promises fail on purpose** while the outbound publish stays
   unwired, and **the assertions must not be weakened to match.**

**And one the brief pointed me at that I could not place as instructed.** The
brief named `source-manifest-contract` as carrying a caveat among the sixteen.
**It is not one of the sixteen** — `scratch/old-sync-test-sort.md` lists it in the
four-file "Dies with the mechanism" section, with this flag on it:

> the manifest contract. A bundle carries a tree and no manifest. **Largest single
> holder of the 121 references — check before deleting whether any assertion is
> about preservation rather than manifests**

I have not run that check and I am not recording it as a seventeenth promise,
because deciding that a dies-column file is really a specification is exactly the
call the standing rule reserves — and the rule's test is whether it quotes Skip.
**Someone should run that check.** If any of its assertions turn out to be about
preservation rather than manifests, that is a promise this document is missing.

## What this document is not

- **Not a test suite, and not a licence to write one.** The four surviving files
  have an owner and their disposition is not settled.
- **Not a description of `main`.** Several promises are known to be unkept today;
  where that is recorded it is stated at the entry.
- **Not a design.** Nothing here says how the new mechanism should work. Every
  entry is a property it must have, deliberately stated without a mechanism, so
  that it survives the next change of mechanism the way these did not.
