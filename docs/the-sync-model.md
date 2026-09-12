# The sync model

What happens to an edit, from the moment it is made to the moment everyone else
can see it. Written 2026-08-25, after a night of finding out that most of what
was implemented did not match this.

Everything here is either measured or cited to the code. Where something is
unverified it says so.

## An edit enters a project by exactly three routes

These are not a sample. They are the complete set, and a claim about "sync"
that only exercises one of them is a claim about one path.

| route | who | how it arrives |
|---|---|---|
| **disk** | a person or agent editing files in a checkout | the daemon notices, settles the tree, pushes a proposal |
| **browser** | the source editor | CodeMirror → a Yjs source room → the same proposal path |
| **remote** | someone pushing to a linked Git remote | polled, or pulled explicitly |

`bin/sync-demo.mjs` drives all three against a throwaway project and times each
hop. The document it writes into *is* the log: every line names the route that
wrote it, so a route that stops working stops appearing and you can see which
one without reading anything.

## Two refs, because there are two objects

This is the centre of the model, and conflating the two is what broke the app.

```
refs/heads/tlda/<project>     THE AUTHOR'S BRANCH
                              their whole tracked tree, standable,
                              advanced under them on every settle

refs/tlda/project/<project>   THE REVISION CHAIN
                              the document roots and their dependency
                              closure, and nothing else; internal,
                              never a branch
```

**They are different things and they must never be the same ref.** The chain is
what gets *published* — a revision is what the server builds and versions, and
it deliberately excludes files that are not part of any document. The branch is
what the author *stands on*.

Skip, 2026-08-23: *"OBVIOUSLY YOU FUCKING WANT A FUCKING BRANCH WITH YOUR SHIT
ON IT."*

That was answered by renaming the chain into `refs/heads/`, which gave it a
branch's name without making it a branch. Measured on a checkout holding
`demo.md` and `notes.txt`, both tracked and committed: the branch contained
`demo.md` alone. A branch that would delete your files if you checked it out is
one nobody checks out — so nobody stood where the daemon was writing, every
author's own branch never moved, and their working tree was dirty against it
from the first edit onward. That is why `git checkout` and `tlda project remote
pull` refused every single time. Git was right; the app had put the person
somewhere no git operation could succeed.

## When the daemon commits, and when it does not

Skip, 2026-08-25: *"if you have a daemon-managed branch checked out — it
commits, and pushes, and all that shit. otherwise it doesn't."*

- **On the work branch:** every settle commits the author's tracked tree to
  their branch, resets their index to it, and pushes a filtered revision.
  Because the commit is parented on HEAD, the branch move is a fast-forward and
  **the working tree goes clean.**
- **Anywhere else:** nothing is committed and nothing is pushed. The settle
  returns `not-on-work-branch` and names the command that fixes it. It does not
  fail silently, and it does not commit to a branch the author is not on.
- **`tlda project link` leaves the checkout standing on the work branch.**
  Nothing did this before, which is why every checkout on the machine was in the
  broken state.

**The index reset is load-bearing and is not an optimisation.** Settling stages
into a *copy* of the author's index so that it never disturbs what they have
staged. The consequence is that moving the branch alone leaves their real index
holding the pre-edit blob — `git status` reports `MM`, and `git checkout` still
refuses. Moving the branch without resetting the index looks like a fix and
changes nothing.

**One exception:** `.source-room/working` is a tree the app owns, created by
`ensureRepo`, with no person standing in it. It is exempt from the branch rule,
because gating it would stop the browser editor's path entirely.

**Untracked files are not submitted.** Staging is `git add -u` — tracked paths
only — so a new file reaches nobody until the author `git add`s it. That is a
deliberate cost: the alternative swept every scratch file in the checkout into
the project.

## How an existing checkout gets fixed

A checkout linked before this repair is standing on whatever it was linked
from, with a work branch full of chain commits. **Relinking migrates it**, and
the migration never discards anything.

The branch is recognised as the chain by either of two facts, and which one
applies depends on when the project was made:

- **both refs present and related** — the rename created the branch *at* the old
  `refs/tlda/project/<p>` and left that ref in place, so a project that lived
  through it has both.
- **the branch tip is a chain commit** — a project created *after* the rename
  never had the old ref, so there is nothing to compare against. The
  discriminator is the subject the daemon itself writes: a chain commit says
  `tlda project revision`, a settled one says `tlda settled edit cluster`.

The chain's tip is carried onto its own name **first**, so every commit that
existed stays reachable; it just stops being called a branch. Only then does the
branch name change hands.

**A branch holding real settled work is never adopted** — that is what a fresh
link creates, and treating it as the chain made `recover()` push it as an
outstanding revision that had never been sent.

If the branch cannot be moved — the person has something there that git refuses
to overwrite — the link still succeeds and says which branch to check out. It
does not force, and it does not fail the link.

## What a revision contains

`filteredProjectCommit` starts from the declared document roots (or, absent
those, every `.tex`/`.md`/`.qmd` in the tree) and walks each one's dependency
closure. Only what it reaches is in the revision.

A file that is tracked but that no document root reaches is **dropped**, and the
settle says so — a push that reports success has to report what it left out in
the same breath.

## The browser path

The source editor does not read the file. It reads a **Yjs source room**, one
per `(project, file)`, persisted under `.source-room/`.

A room is brought up to date by exactly one function,
`reconcileRoomToRevision`, from both directions it can go stale:

- it was **open** when a revision landed — `headChanged` fires on every
  successful publish
- it was **closed** and is being reopened — `createRoom` reconciles the restored
  snapshot against the revision that is current now

**It merges, it does not overwrite.** A room can hold text the person typed and
has not saved; a three-way merge against the revision the room was holding keeps
both sides and marks the room blocked if they genuinely conflict.

### What this replaced, because it explains the symptom everyone reported

`headChanged` used to set `room.heldRevision = revision`, persist that, and
broadcast `status: 'synced'` — **without touching the room's text.** The room
recorded that it held a revision whose content it did not have, and said so out
loud.

Two things followed, and the second is the serious one.

**You saw old code.** Measured on a throwaway project: the server's copy of a
file carried four edits that a *freshly mounted* editor did not show. Not a
stale subscription — the initial load was already twenty minutes old, because
the persisted snapshot won over the file. Reopening did not help either: a
reopened room compares held against current, found them equal, and correctly
concluded it had nothing to do. **The stamp is what made the staleness
undetectable from inside.**

**And your writing could be overwritten.** On that `synced` broadcast the client
adopts the new revision as its base *and* records the stale text as saved
(`FleetSourceEditorShape.tsx:1256–1259`). The next keystroke saves the **whole**
stale document — `view.state.doc.toString()`, not a delta — against a base the
server agrees is current. So it is accepted, with no conflict and no merge,
because the base genuinely matches. Everything that landed in between is
replaced.

It needed the person to type after the broadcast; an editor left open and
untouched overwrote nothing.

## A refusal must be visible

When the server refuses a save, the response used to be discarded whenever the
person had typed one more character while it was in flight — the sequence guard
covered both *may this touch the buffer* and *may this tell the person*. Those
are different questions. The buffer must not be clobbered by a superseded
response; the refusal is true regardless.

Not being told what changed costs a stale read, which you find out about. Not
being told you were **refused** costs the writing.

## Measured latency

An edit written on disk, reaching the server, on the deployed box:

```
9s   10.2s  11.0s  11.4s  11.7s  12.6s  12.7s     and one 26.0s
```

The 9s is from the post-repair verification below. Roughly 3s of any of them is
a deliberate debounce (`quietMs = 3000`, nothing
overrides it). About 7s is settle, push and admit. The remainder is the
observer's own polling. The 26s outlier is not explained.

**Latency is part of the contract, not a footnote.** The complaint this model
exists to answer has two halves — the files do not get there, *or they get there
old* — and a pass/fail on arrival only answers the first.

## Verified against the running system

Not a test — a project created from scratch on the deployed box, 2026-08-25:

```
before link   branch = main
after link    branch = tlda/sync-proof, status clean, tree = doc.md notes.txt

one edit on disk
  reached the server   9s
  branch tip           1f4b1e1 -> 947a042
  commit subject       tlda settled edit cluster
  status afterwards    clean
  notes.txt            still tracked, and absent from the published revision
```

The last two lines are the pair the old code could not do at once, because it
used one ref for both jobs.

## Known gaps, as of writing

- **The client source manifest is written by nothing.**
  `updateClientSourceManifest` has zero callers, so `GET /:name/files` returns
  `[]` for every project. Two other call sites already route around
  `listSourceFiles` for this reason, calling it "the trap next door" in
  comments. It is **not** a deletion risk — the browser's route ignores the
  manifest it is sent — but nothing that lists a project's files can see any.
- **A build card's change summary is filtered to `*.tex`**, so a markdown or
  qmd project reaches "no tex diff" and emits no card. That is a decision about
  what a build card is for, not a path bug.
- **A linked remote added after linking is never polled.** The daemon builds its
  polling bridge from `binding.remote`, which is written at link time only;
  `tlda project remote add` runs a plain `git remote add` in the checkout and
  does not touch the binding. Such a remote is one you pull by hand.
- **`applyAcceptedSourceMutation` has no callers.** It does the room-update job
  from a files payload. `headChanged` is the hook that actually runs, and takes
  a revision, which is what the daemon path has. The dead one is left in place
  rather than duplicated around.
