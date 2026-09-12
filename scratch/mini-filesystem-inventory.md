# Mini filesystem inventory — 2026-09-01

Nothing has been deleted, moved, zipped, or stashed. This is the inventory only,
which the brief names as the deliverable. Reclamation is proposed at the bottom
and not started.

## inventory-headline

**1,132 checkouts** across seven locations, **932 of them worktrees of the one
tlda repository**. The repo carries **2,853 branches** and **61 stash entries**.

**634 checkouts hold work that is not on `main`.** 498 do not, and are the
reclaim candidates.

Skip's complaint is literally true and it is not about duplicate *names* — no two
checkouts share a basename. It is topical: **13 `classroom*` copies, 12
`route-probe*`, 10 `tlda-phone*`, 9 `fall-class*`, 7 each of `tlda-project*` and
`dot-claude*`.** Nothing in a directory listing says which is real.

## inventory-where

| location | checkouts | note |
|---|---|---|
| `~/worktrees` | 688 | the sanctioned location |
| `~/work/tlda/.worktrees` | 249 | **inside the repo** |
| `~/work` | 138 | mixed with Skip's own project directories |
| `~/work/tlda/scratch/worktrees` | 37 | **inside the repo** |
| `~/work/tlda/.claude/worktrees` | 12 | **inside the repo** |
| `~/work/tlda-worktrees` | 7 | |
| `~/work/tlda-wt` | 1 | |

**298 checkouts sit inside the repository itself.** `AGENTS.md` §"Every working
copy lives in `~/worktrees`" forbids this precisely because `tsc -b` and the
greps this project runs constantly walk them. The `post-checkout` hook that is
supposed to fail loudly on this did not stop 298 of them.

One of those, `chat-flicker-live`, is a worktree that **itself hosts 8 nested
worktrees**.

**69 checkouts are on a detached `HEAD`** — they have no branch name at all, so
nothing about them is recoverable from a branch listing.

## inventory-occupancy

**No worktree is in use by any live agent.** All 69 live tmux panes sit in
exactly four directories:

| live cwd | panes |
|---|---|
| `~/work/tlda` (the shared checkout) | 40 |
| `~/work/dot-claude` | 18 |
| a teaching project | 9 |
| a research project | 2 |

This is measured from `tmux list-panes`, not inferred from names. A *hibernating*
agent could still resume into a worktree, so this is not licence to delete — but
nothing is being written to right now.

## rescue-list

**This is the step that pays for the job, and it is not small.**

**361 checkouts contain source files edited in place and committed nowhere.**
Counting only real source — build output, `node_modules`, `.tsbuild`, `_freeze`,
vendored assets and agent scaffolding excluded.

**346 checkouts carry commits whose subject appears nowhere on `main`.** Checked
by subject against all 7,553 `main` subjects, not by `merge-base` — `main` is
assembled by cherry-pick and ancestry lies here.

Union: **634 checkouts to preserve before anything is reclaimed.**

### rescue-caveat

**The largest rows are era drift, not someone's unsaved afternoon.** Four
checkouts show 2,255–2,578 "modified" files; their last commit is June/July and
their working tree has simply diverged from a very old `HEAD`. Reporting those as
2,500 files of endangered work would be false.

The believable ones are moderate and recent, e.g. a window-manager checkout with
47 edited `src/` files, a phone-layout one with 26, a grading one with 18.

**Age of last commit on the 361:** 170 from 2026-06, 129 from 2026-07, 47 from
2026-08, 5 from 2026-09. Most has sat for two to three months.

### rescue-stash

**61 stash entries on the shared repo**, and at least one is explicitly rescued
work — `stash@{0}` reads *"RECOVERED by agent-mi0h 2026-08-19 … popped by
accident from an unlabelled stash, returning it"*.

A stash is invisible in every directory listing, so it is the least legible place
work can sit. This is one item, not 298: **worktrees share one stash list**, and
an early version of this inventory counted the same 61 entries once per worktree.

### rescue-meta

`tlda-homework-grading-recover-demo` holds untracked files named
`0001-RECOVERED-…-Recover-the-uncommitted-classroom-grad.patch`. **Work that was
already rescued once, into patch files that are themselves uncommitted.**

## proposed-reclamation

Not started. Proposed order, each step reversible:

1. **Commit the 361 in-place edit sets to branches** named for their checkout,
   and **`git stash branch` the 61 stashes**. After this nothing is unique to a
   working directory and the rest is cheap.
2. **Reclaim generated files only** — `node_modules`, `dist`, `.tsbuild`,
   `_freeze`, `.quarto`, build output — across all 1,132. Touches no source.
3. **Retire the 498 reclaim candidates**, `git worktree remove` then `rm` to
   `~/.Trash`. Zip first where a checkout is not a plain tlda worktree.
4. **Move the 298 in-repo worktrees out**, or retire them, so the repository
   stops containing its own copies.

Step 1 is the one worth doing regardless of whether the rest happens.

## measurement-honesty

- Size is not yet measured cleanly; a first `du` run was corrupted by a duplicate
  process and its numbers are discarded. Skip said this is not about disk space,
  so it did not gate the inventory.
- "Unlanded by subject" cannot see work that landed under a *reworded* subject.
  It errs toward preserving, which is the safe direction.
- Two instrument faults were caught and corrected mid-run and their outputs
  rebuilt: `zsh`'s `print -r` left `\t` literal, and reading a field into a
  variable named `path` silently destroyed `PATH` so every `git` call in the
  classifier returned nothing. The second one produced a clean-looking all-zero
  result. The rerun carries a positive control — 68 rows reporting unlanded
  commits — so a zero now means zero rather than a broken instrument.
