# git-protocol-review — revision against `ae80cff3a`

**This supersedes parts of my first verdict.** I reviewed the 20:40 working file; §3 and
§7.3 were rewritten before the commit. Re-read and re-checked against
`ae80cff3a:scratch/git-sync-protocol-design.md`.

## retraction

**My finding 2 is dead. Drop it.**

I reported that §7.3's `gone`/`unreferenced` shed reasons were a property of a *transition*
rather than a tree, and therefore sat outside the I1–I6 idempotence argument.

**The rewritten §7.3 deletes the shed reasons entirely**, on Skip's rule that absence in a
tree *is* deletion, with the reasoning that a second description of the change alongside the
tree is the disease the section exists to cure. **That is a better answer than my
objection** — I said the mechanism was outside the correctness argument; they removed the
mechanism. Nothing of my finding 2 survives and it should not be carried into
implementation notes as an open item.

## finding-1-stands-and-is-now-sharper

`.tlda/docs` is still the load-bearing file (§3.1), still declared *"itself a member of every
revision"*, and §2.1 still makes `.gitignore` the membership gate. And the rewrite added the
thing that makes it worse: §3.1 now says **"`git add`/`git rm` still works exactly as Skip
described — it governs the root list"**, quoting his *"git add/git rm your roots, let the
rest be handled"*.

**His stated act fails.** Reproduced in a throwaway repo carrying bregman's actual
`.gitignore`, two lines verbatim:

```
$ git add .tlda/docs
The following paths are ignored by one of your .gitignore files:
.tlda
hint: Use -f if you really want to add them.

$ git ls-files
              ← empty. The root list is not in the index.
```

Only `git add -f` puts it there. So the design's central user gesture — the one Skip named
himself — is refused by a rule this project wrote into his repo under the comment
`# tlda internals`.

This is not a naming problem to be fixed by moving the file. The exclusion is the
**directory**, and the directory is already carrying two of tlda's own leaked scratch files
at `HEAD` (`.tlda/scratch/inject-l3352-1780624894252.tex`,
`.tlda/scratch/scratch-template.tex`). **Either the roots list moves out of `.tlda/`, or
`.gitignore` stops ignoring it and the scratch is excluded some other way.** That is a
choice the design has to make and currently does not know it is facing.

## new-finding-the-two-halves-of-shedding-contradict-each-other

The rewritten §7.3 states two rules that cannot both hold.

**First half**, justifying dropping the shed reasons:

> I had proposed carrying a shed *reason* — `gone` versus `unreferenced` — so that removing
> an `\input` would not delete a colleague's copy. **I am dropping it.** […] the case it
> protects is recoverable: the file is in history on both sides.

So **deletion-by-dereference is legitimate**: remove an `\input`, the file leaves the tree,
the far side deletes it, and that is fine because history holds it.

**Second half**, the safety check:

> **A deletion is legitimate iff a root was removed in the same change.**
> Every legitimate deletion is downstream of an explicit `git rm` of a root. Files vanishing
> with no `git rm` behind them is a bug, always, and is refused outright.

Removing an `\input` is not a root removal. **So the operation the first half declares
legitimate is the operation the second half refuses outright.**

Two routine cases fall in the hole, and neither is exotic:

1. **Cutting a section.** Delete `\input{sec3}` from the paper and delete `sec3.tex`. No
   root changed. Refused.
2. **`git rm` of any non-root file** — a retired figure, a dead `macros-old.tex`. It is an
   explicit `git rm`, performed deliberately by the user, but not of a *root*. Refused.

Cutting a section is close to the most common structural edit there is in writing a paper.
As written, the check refuses it and demands an acknowledgement token (§7.3a) for an
ordinary Tuesday.

**I do not think this sinks the check** — the safety instinct is right, the threshold
critique is right, and binding the acknowledgement to a tree sha rather than a boolean
(§7.3a) is genuinely good and should survive. **The predicate is what is wrong.** It needs
to distinguish *the closure collapsed* from *the author removed something*, and "a root was
removed" is not that predicate. I am not going to write the replacement — that is stage 1's
job, and my pre-read said I would not become a second designer.

## findings-3-and-4-stand

**Finding 3, no first day.** §3.1 still never says how `.tlda/docs` comes to exist for the
papers that exist now, and §12 still does not list it. **The rewrite makes it worse rather
than better:** with tree semantics, an absent or empty root list at the first settle is no
longer a wedge — per the new §7.3 it is *deletion of every member*. The design's own words
for that case are *"silent mass deletion is neither loud nor recoverable"*. The new §7.3
check may catch it, which is lucky rather than designed, and turns adoption into a refusal
the user has to acknowledge without being told what it is.

**Finding 4, §6.2 retracts §6.1's premise.** I re-read §6.1 at the commit; it is unchanged.
*"Legibility is recoverable at read time by grouping commits; latency is not recoverable at
all"* still overrules `chief-night`, and §6.2 still establishes that git is not on the
render path, which removes the latency consequence. Stands as reported.

## answering-derived-roots-directly

`git-protocol-design` asked whether *"bregman is the one that matters"* is special pleading.
**It is not, and the reason is better than the one in §3.0 — but my own first hypothesis
about why was wrong, so here is the measurement.**

I assumed bregman was simply the oldest and most-accumulated repo, and that the other four
were its past. **That is false.** Measured across the same five:

| repo | commits | tracked | first commit |
|---|---|---|---|
| **bregman-lower-bound** | **2,087** | 1,730 | 2026-04-09 |
| balancing-act | 411 | 33 | 2025-05-01 |
| survival | 33 | 8 | 2025-04-17 |
| eiv-paper | 224 | 7 | **2020-07-01** |
| ctd-paper | 2 | 4 | 2026-02-21 |

`eiv-paper` is **six years old** with 7 tracked files. Age does not produce the mess.
Bregman is four months old with 2,087 commits — **five times any other repo's lifetime total,
in a sixth of the time.**

**So the variable is intensity of agent work, and the mess is ours.** The files §3.0 names as
the bad derived roots say so on their face: `.bak-before-deletion.tex`,
`.bak-before-foc-delete.tex`, `.bak-before-mollif-delete.tex`, `.scratchinputs.bak/`,
`.outlines/*-draft.tex` — machine-shaped names, and `.tlda/scratch/inject-l3352-1780624894252.tex`
is unambiguously ours. Skip did not commit 1,730 files by being messy. **We did.**

That makes §3.0's conclusion stronger than it claims and changes its character:

- It stops being *four clean, one messy, and I am privileging the messy one*. The four clean
  repos are the ones **tlda has barely touched**. They are not counter-evidence; they are
  the untested case.
- The property that breaks derived roots is **produced by this product**, so it is not an
  accident of one repo. It is what every repo looks like after we work in it, and the
  repos that matter are exactly the ones we work in.
- **`git add` cannot be the membership signal for the reason `chief-night` reached
  separately** — Skip has already added everything — and now with the mechanism: he did not
  add most of it.

**So it is a measurement, not a judgement.** I would state the finding as: *derived roots are
correct only where the index is clean, tlda's own activity is what makes an index dirty, and
therefore derived roots degrade precisely in proportion to how much the project is used.*
That is worth putting to Skip in those words, because it is a fact about our behaviour and he
may want the `.bak` and scratch generation fixed as well as designed around.

**One caveat I will not hide:** I have not established that agents authored those specific
`.bak` files — I am reading their names and the one file I can attribute with certainty. The
commit counts and dates are measured; the attribution of the mess is inference.

## editorial

Two different sections are both numbered **§3.1** — *"So: a root list, and only a root list"*
and *"A declared document that does not exist, or does not compile"*. §7.3 already
cross-references *"the closure records it as `missing` (§3.1)"*, which now points at two
places.
