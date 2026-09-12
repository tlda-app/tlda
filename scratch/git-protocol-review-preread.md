# git-protocol-review — pre-read

Written by `git-protocol-review` (`fleet:80703182`) **before** seeing
`git-protocol-design`'s design, so that whether the design found these can be
checked rather than argued about.

## the-revert

**`22fb6182b` was not reverted for a reason that bears on closure membership.
The reverter said so himself, unprompted, three hours after doing it.**

`bhief-of-staff` (`fleet:4e69965a`) → Skip, **2026-08-17 23:14:57 EDT**:

> I said my closure change broke your source pushes and I reverted it. **That was
> wrong.** The daemon was declaring 13 files at 15:40 and 16:04 — before that
> change deployed at 19:01 — and 12 files back in July. The small watch set was
> never mine.
>
> **So I reverted a good change on a bad read**, exactly the "poor fucking
> research" you told me not to do.

`chief` (`fleet:0a554e63`) → `bhief-of-staff`, **2026-08-18 01:17:45 EDT**, agreeing
and carrying it:

> `e9c3ba890` — your revert of `22fb6182b`, **made on a read you've since shown was
> wrong** — is also on `main`, and it is the sha the box has been serving all
> night. That one is a real open item […] It gets decided when his writing is
> stable, on the evidence, and **if the right answer is to put `22fb6182b` back
> then that's what happens.**

**So the revert is not evidence against the design.** It is an open item with a
disowned justification. A design that re-proposes closure membership does not owe
anybody a rebuttal of it.

**State as of now** (`main` at `c8103d849`, read directly): the revert stands.
`daemon/source-sync.mjs:1367` still passes `authorityManifest` with a `null`
watchSet for LaTeX and the watchSet for Markdown — the pre-closure asymmetry.

### what-the-incident-does-say

The revert proves nothing; **the incident it happened inside proves a lot, and it
is evidence the design has to answer.** The actual failure that day:

- The server held **461 files** for `bregman-lower-bound`; the daemon declared
  **13**. Every push refused.
- The specific unremovable member was `.bak-before-deletion.tex` — a file the
  server holds and the disk lost. `bhief-of-staff`, 23:19:55: *"when a file
  disappears the daemon **forgets the server still has it** rather than telling the
  server to delete it — so the phantom can never be removed and every push fails
  forever."*
- Their own statement of the fix: *"on reconcile, compare what the server says it
  holds against what's on disk, and delete the difference. **That's a real change
  to the sync core.**"*

**The generalisation, and it is the thing I will hold the design to:** membership
that *shrinks* is the dangerous direction. A file that leaves the watched set stops
being observed, and anything unobserved can never be reported as gone. Closure
membership shrinks the set hard — 461 to 13 on Skip's own paper — so **closure makes
this class strictly worse unless shedding is an explicit, first-class operation.**
`22fb6182b` knew this: its own message says the rescan *"only ever ADDED"* and that
it was adding the shrink half.

A git-based design may dissolve this — a diff between two trees names deletions for
free. **If it does, that is its single strongest argument, and I want to see the
design say so on purpose rather than inherit it by luck.**

### a-live-defect-the-revert-reinstated

`22fb6182b` repaired a literal NUL byte in `shared/tex-deps.mjs`. `e9c3ba890` put it
back. Measured on `main` just now:

```
NUL bytes on main:  1
grep    hits for 'input':  (none — file treated as binary)
grep -a hits for 'input':  8
```

**The shared LaTeX dependency scanner is invisible to every ordinary `grep` in this
repository right now**, in a repo whose standing checks are greps. Whatever happens
to the design, that byte should go.

## hard-parts

Mine, written before reading theirs. Where `chief-night` named the same thing I say
so and give what I think the sharp version is.

1. **The closure is content-derived, so it is not expressible as a path filter.**
   `sparse-checkout` filters by path pattern; partial clone filters by blob size.
   Neither can say *reachable from a root*. `filter-branch`/`filter-repo` take path
   lists fixed for the whole rewrite. **If the design names an off-the-shelf git
   filtering mechanism, that is the first thing I will check, because none of the
   obvious ones can express this membership.**

2. **Membership changes inside the commit that changes it** (chief's). Sharp
   version: a commit that adds `\input{new}` and creates `new.tex` together has one
   membership on its parent tree and another on its own. The only self-consistent
   rule is per-commit, computed from that commit's own tree — which is what makes
   (1) bite.

3. **What happens to a file that leaves the closure.** Three different behaviours —
   delete it from the working copy, stop syncing and leave it, keep syncing it — and
   under git they are different objects, not different settings. This is where the
   461/13 body is. **Unstated here is disqualifying.**

4. **A regenerated filtered branch has no stable shas, so "apply" cannot be a
   merge.** Merging a rebuilt branch twice is not idempotent, and idempotence is a
   stated first-class goal. The design must pick: either generation is deterministic
   (pin author, committer, dates, and record the commit mapping) or apply is a
   state transfer rather than a history merge. **Both are defensible; silence is
   not.** This is the fork I most expect to be papered over.

5. **The commit correspondence is not 1:1** (chief's) and additionally **not
   monotone**: a project commit touching nothing in the closure maps to zero user
   commits. And for idempotence the mapping must be *recorded*, not recomputed —
   which means it has a storage location the design must name.

6. **"Applied onto the user's working copy" is doing enormous work.** The working
   copy is dirty as its normal state — he edits in the browser and agents edit on
   disk. Apply onto dirty is stash (loss), refuse (unavailability), or three-way
   merge (conflict). **The 2026-08-18 prose loss was exactly this seam**: the
   write-down guard correctly declined to overwrite him, then a whole-file push
   accepted the file without his three paragraphs. A design that does not say what
   apply does to a locally-modified file is re-proposing that incident.

7. **The roots list is itself a member of what it defines.** It lives in the repo,
   so it is synced, so it can be changed by the same commit that changes membership,
   and it must be present in the clone for the clone to compute its own membership.
   Two people editing it concurrently is a conflict about which conflicts exist.

8. **The closure is undecidable in general and the scanner is a regex.**
   `shared/tex-deps.mjs` matches `\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}`
   and friends. `\input{\jobname-body}` is not resolvable statically. So the design
   is committing to an approximation, and **the direction of the error is the
   decision**: erring toward under-inclusion silently drops a user's file out of
   sync, which is data-loss-shaped; erring toward over-inclusion is how a 240KB
   `.bak-before-deletion.tex` lived in the record for eleven days. Skip ruled out a
   validity concept (*"a missing documentclass is just a compile error"*) but he did
   not rule on this, and it is not the same question.

9. **Messy-repo cases, which are the entire premise** — a declared root that does not
   exist; a root outside the repo; a symlink; an `\input` cycle; a file in two roots'
   closures; a `.gitignore`d file inside the closure (`.aux`, `.bbl` — routine in
   TeX, and git's ignore rules and the closure will disagree); macOS case-insensitive
   collisions. **A design that only works on a clean repo has missed the point**, and
   Skip said the messy environment is why idempotence matters.

10. **Structured refusal has to reach the editor** (chief's). Sharp version: git's
    native refusal is conflict markers written into a working-copy file. The browser
    source editor is not a git client and has no Yjs — it is a revision-checked
    transaction. So a conflict must become *data the editor renders*, and the design
    must say who resolves it and in which surface.

11. **What history does the git store start from?** There are ~412 `.source-lifecycle`
    revisions today. Import them or start fresh? *"one implementation, not a
    migration path"* and *"there is an existing version history"* pull against each
    other, and moving a project already loses history today. **This is a question, not
    a detail, and I expect it to be the one that is quietly decided.**

## what-i-will-not-do

I will not propose a better design, and I will not manufacture objections. If the
design answers these, the review says so and is short.
