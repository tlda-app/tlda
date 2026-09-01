# Open tasks by topic — rebuilt from the full set

**245 open tasks.** Every open row is here; `tasks()` paginates at 200 and the
previous build of this file stopped at that boundary, dropping 48 rows.

Age = time since last notify. Sorted newest first inside each topic.
**Status is a mark on the row, not a section.**

| mark | meaning |
|---|---|
| **live** | still real, still wanted, someone should own it |
| done, unclosed | the work happened — evidence in the row |
| superseded | overtaken by later work or a later decision |
| unestablished | I could not determine it. Not a guess either way |

Dispositions carry their evidence. A row marked `unestablished` has had no
evidence read yet — it is an honest gap, not a verdict.

## What this pass found

**1. The previous build of this file was one page.** `tasks({limit:200})` states
**245 open**, returns 200, and hands back a cursor. The prior file totalled 197
and contained no row from the tail. 48 rows had never been triaged, including
seven of Skip's own.

**2. Skip owns 15 rows, not 8.** The seven that were missing: Review Part 1
course sequence · Review Part 2 course sequence · Review enrichment breather ·
Bootstrap managed testing daemon · Supply Zach estimator specification
(`every:900s`, re-notifying for 465h) · Drop-test complete, no task work
performed · Check chat transition resistance after revert.

**3. One display defect makes 39 rows unreadable, and it is why they were never
triaged.** For a re-delegated task, `tasks()` shows the **delegation message**
where the task title belongs. So a bulk transfer writes its own note over every
row it touches:

| rows | what every one of them reads as | who wrote it |
|---|---|---|
| 25 | "Parking stale backlog task during fleet cleanup — owner hibe…" | `claude-chief`, 08-16 17:51 |
| 9 | "Transferred from an Opus agent to the nobody bot at Skip's r…" | `fall-class`, 08-13 15:22 |
| 5 | "Ownership transfer while the chief/package lane has the next…" | on `tlda-recovery-chief-sol`, still open |

The real subjects are recoverable: the parking delegations are second-for-second
with the rows' notify timestamps, so joining on that timestamp resolves **25 of
25 with no ambiguity**. This file shows the recovered subjects for those 25. The
nine from 08-13 collide within one second and resolve only to their batch. The
five on `tlda-recovery-chief-sol` are not yet recovered — that owner is awake and
can simply be asked.

*This describes the observed behaviour. I have not read the code that renders the
title, so the cause is not established here.*

**4. The 25 recovered subjects are product work, not debris.** They were parked
for "owner hibernating, no live progress" — a fact about the owner, never about
whether Skip still wants the thing. Among them: *Rebuild index page to Skip's
spec* · *Recover and build the index page columns* · *Make composer slider
salient on touch* · *Work with Skip on the tlda README* · *Hold Enter until the
voice transcript finalizes* · *Build document place-stack navigation* · *Fix
invisible math-agent messages* · *Restore lifecycle authority and Reanimate* ·
*Stop `tlda daemon stop` from unloading the launchd job*. Exactly one of the 25
has landed work on `main`.

**5. Nothing will pick that bucket up.** Its owner `nobody` (fleet:9307b38c) has
been hibernating **318h**. The only running agent of that bot model is
`quiet-nobody` — a bot under a non-canonical name, which AGENTS.md §"A renamed
mint and an inert bot are both the design" makes inert by construction.

## How a row was disposed, and where I stopped

Every `done` cites a commit whose **subject is the deliverable**, checked on
`main` by message rather than by ancestry — four of the commits cited here are
not ancestors of `main` and would have read as never-landed.

Two instruments were tried and rejected, both after running a counterfactual on a
row already settled by hand:

- A title↔commit keyword matcher returned a **plausible wrong commit** for the
  known row and missed the true one.
- An owner-name↔branch matcher matched a branch holding that agent's *other*
  work.

Neither appears as evidence in any row. Where one produced a lead that does not
settle a row, the lead sits in the evidence column under `unestablished`.

**101 rows have had no evidence read yet.** They carry `unestablished` with no
evidence, and that is what they are — not a judgement that they are dead.

## The second list, and that this job is a row on it

`the-list.md` is tracked on `main`, 63 rows, **last touched 2026-08-13** — 18 days
ago. It is Skip's own items in his own voice, grouped by topic with status as a
mark on the row.

**One of its rows is this job.** Status ○, not started:

> **A second list exists and nobody reads it** — 34 open fleet tasks, 26 of them
> stale, the oldest 328 hours, and every one has an owner who is hibernating.
> **They are not all the same thing, and nobody knows which is which — that is
> the finding.** Three kinds have already turned up in a sample of nine: work
> that is *abandoned*, which needs an owner or a decision; work that is
> **finished and never closed**, which needs only a close and until then inflates
> the backlog and hides the real ones; and **eight of the nine that have no row
> here at all — invisible rather than duplicated.**

That is the same taxonomy this triage was asked for, written 18 days ago and
never started. **Then: 34 open, oldest 328h. Now: 245 open, 194 with a
hibernating owner, oldest 41 days.** Seven times bigger.

His third kind — *invisible rather than duplicated* — is what §3 above measured:
39 rows that carry a transfer note where their subject should be.

**No code change would have prevented the 197-row miss.** His rule *"everything
that paginates announces it, at the top and at the bottom"* shipped as
`2cb6cac1e` on 2026-08-13, and `tasks()` obeys it at both ends — the top of
tonight's own output reads *"Showing 200 of 245 open tasks"* and the bottom reads
*"45 more open task(s) not shown. Next page: …"*. The announcement was there and
was read past.

**Cross-links worth keeping** between his list and the task table:

| his row | in the backlog as |
|---|---|
| Place-stack forward/back over documents | *Build document place-stack navigation* — one of the 25 invisible parked rows |
| An inert `dev` reclaims no disk | *Why supervised dev is not reclaiming* (11d, owner hibernating) |
| `mint` and `delegate` report success for an agent that never joined | *Diagnose mint success-without-login…* and *Fix mint+delegate dropping the delegation* (both 16d) |
| The agent read path does not fold amends | *Fix thread historical names and amend marking* — marked done here on `aedd8f978`; **his row says the amend half is still open**, which is why that row carries a re-check |
| A bot loses its own name to its mint's shell row | no task. `96c35417d` established `quiet-<name>` has **two** causes — the sanctioned stop, and a mint's row squatting a running bot — and left a question with Skip |

**I have not established how much of his list the task table covers.** The two
are written in different voices — his are symptoms, the tasks are imperatives —
so keyword overlap under-matches badly, and this is the third matcher this pass
that I am declining to report a number from.

---

## Assigned to Skip — 15, 1 with evidence

| age | status | owner | owner state | task | evidence |
|---|---|---|---|---|---|
| 2d | unestablished | `skip` | never picked up | Decide managed-branches landing | — |
| 9d | unestablished | `skip` | never picked up | Handing this back to you because the next action is yours, n | — |
| 11d | unestablished | `skip` | never picked up | Maintained Markdown draft sent directly in message 3136654 f | — |
| 17d | unestablished | `skip` | never picked up | Choose Homework 0 guidance location | — |
| 17d | unestablished | `skip` | never picked up | Review course development publication flow | — |
| 17d | unestablished | `skip` | never picked up | Choose LMS assignment delivery | — |
| 17d | unestablished | `skip` | — | Scope update from the settled 16:00:20–16:20:18 EDT classroo | — |
| 17d | unestablished | `skip` | never picked up | Returned unchanged. | — |
| 17d | unestablished | `skip` | never picked up | Review Part 2 course sequence | — |
| 17d | unestablished | `skip` | never picked up | Review enrichment breather | — |
| 17d | unestablished | `skip` | never picked up | Review Part 1 course sequence | — |
| 18d | unestablished | `skip` | never picked up | Bootstrap managed testing daemon | — |
| 18d | done, unclosed | `skip` | never picked up | Drop-test complete; no task work was performed. | The row's own text: drop-test complete, no task work performed. Skip-owned, so closing it is his. |
| 19d | unestablished | `skip` | — | Check chat transition resistance after revert | — |
| 19d | unestablished | `skip` | never picked up | Supply Zach estimator specification | — |

## Parked under `nobody` — 34 rows nobody has triaged — 34, 34 with evidence

| age | status | owner | owner state | task | evidence |
|---|---|---|---|---|---|
| 18d | unestablished | `nobody` | owner hibernating | Gate late-alpha release preparation | Parked by `claude-chief` 08-16 17:51 for "owner hibernating, no live progress" — a fact about the owner, not about the work. **No commit on main carries this subject.** Whether Skip still wants it is his call or the chief's, not an agent's. |
| 18d | unestablished | `nobody` | owner hibernating | Gate stray upload refusal | Parked by `claude-chief` 08-16 17:51 for "owner hibernating, no live progress" — a fact about the owner, not about the work. **No commit on main carries this subject.** Whether Skip still wants it is his call or the chief's, not an agent's. |
| 18d | unestablished | `nobody` | owner hibernating | Gate docs and Overleaf onboarding | Parked by `claude-chief` 08-16 17:51 for "owner hibernating, no live progress" — a fact about the owner, not about the work. **No commit on main carries this subject.** Whether Skip still wants it is his call or the chief's, not an agent's. |
| 18d | unestablished | `nobody` | owner hibernating | Gate short image references | Parked by `claude-chief` 08-16 17:51 for "owner hibernating, no live progress" — a fact about the owner, not about the work. **No commit on main carries this subject.** Whether Skip still wants it is his call or the chief's, not an agent's. |
| 18d | unestablished | `nobody` | owner hibernating | Take this preserved independent layout/obligation gate after… | Parked by `claude-chief` 08-16 17:51 for "owner hibernating, no live progress" — a fact about the owner, not about the work. **No commit on main carries this subject.** Whether Skip still wants it is his call or the chief's, not an agent's. |
| 18d | unestablished | `nobody` | owner hibernating | The task’s bounded capture and generic delayed-touch diagnos… | Parked by `claude-chief` 08-16 17:51 for "owner hibernating, no live progress" — a fact about the owner, not about the work. **No commit on main carries this subject.** Whether Skip still wants it is his call or the chief's, not an agent's. |
| 18d | done, unclosed | `nobody` | owner hibernating | The fresh manager handoff was received and executed. | The row's own text: handoff received and executed. (Recovered subject — this row is one of the 34 whose title `tasks()` hides.) |
| 18d | unestablished | `nobody` | owner hibernating | Carry accepted WM outputs forward | Parked by `claude-chief` 08-16 17:51 for "owner hibernating, no live progress" — a fact about the owner, not about the work. **No commit on main carries this subject.** Whether Skip still wants it is his call or the chief's, not an agent's. |
| 18d | unestablished | `nobody` | owner hibernating | Gate shared highlighter repair | Parked by `claude-chief` 08-16 17:51 for "owner hibernating, no live progress" — a fact about the owner, not about the work. **No commit on main carries this subject.** Whether Skip still wants it is his call or the chief's, not an agent's. |
| 18d | unestablished | `nobody` | owner hibernating | Transferred because your hold `2830652`, relayed in wm-follo… | Parked by `claude-chief` 08-16 17:51 for "owner hibernating, no live progress" — a fact about the owner, not about the work. **No commit on main carries this subject.** Whether Skip still wants it is his call or the chief's, not an agent's. |
| 19d | unestablished | `nobody` | owner hibernating | Watch post-revert chat telemetry | Parked by `claude-chief` 08-16 17:51 for "owner hibernating, no live progress" — a fact about the owner, not about the work. **No commit on main carries this subject.** Whether Skip still wants it is his call or the chief's, not an agent's. |
| 19d | unestablished | `nobody` | owner hibernating | Transferred from an Opus agent to the nobody bot at Skip's r | Moved to `nobody` by `fall-class` 08-13 15:22 **"at Skip's request"** — that citation is unchecked. Title is the transfer note; the real subject is one of the nine in the batch-A list, which resolve only to the second, not to the row. |
| 19d | unestablished | `nobody` | owner hibernating | Transferred from an Opus agent to the nobody bot at Skip's r | Moved to `nobody` by `fall-class` 08-13 15:22 **"at Skip's request"** — that citation is unchecked. Title is the transfer note; the real subject is one of the nine in the batch-A list, which resolve only to the second, not to the row. |
| 20d | unestablished | `nobody` | owner hibernating | Transferred from an Opus agent to the nobody bot at Skip's r | Moved to `nobody` by `fall-class` 08-13 15:22 **"at Skip's request"** — that citation is unchecked. Title is the transfer note; the real subject is one of the nine in the batch-A list, which resolve only to the second, not to the row. |
| 20d | unestablished | `nobody` | owner hibernating | Transferred from an Opus agent to the nobody bot at Skip's r | Moved to `nobody` by `fall-class` 08-13 15:22 **"at Skip's request"** — that citation is unchecked. Title is the transfer note; the real subject is one of the nine in the batch-A list, which resolve only to the second, not to the row. |
| 20d | unestablished | `nobody` | owner hibernating | Transferred from an Opus agent to the nobody bot at Skip's r | Moved to `nobody` by `fall-class` 08-13 15:22 **"at Skip's request"** — that citation is unchecked. Title is the transfer note; the real subject is one of the nine in the batch-A list, which resolve only to the second, not to the row. |
| 20d | unestablished | `nobody` | owner hibernating | Transferred from an Opus agent to the nobody bot at Skip's r | Moved to `nobody` by `fall-class` 08-13 15:22 **"at Skip's request"** — that citation is unchecked. Title is the transfer note; the real subject is one of the nine in the batch-A list, which resolve only to the second, not to the row. |
| 21d | unestablished | `nobody` | owner hibernating | Transferred from an Opus agent to the nobody bot at Skip's r | Moved to `nobody` by `fall-class` 08-13 15:22 **"at Skip's request"** — that citation is unchecked. Title is the transfer note; the real subject is one of the nine in the batch-A list, which resolve only to the second, not to the row. |
| 21d | unestablished | `nobody` | owner hibernating | Work with Skip on the tlda README | Parked by `claude-chief` 08-16 17:51 for "owner hibernating, no live progress" — a fact about the owner, not about the work. **No commit on main carries this subject.** Whether Skip still wants it is his call or the chief's, not an agent's. |
| 22d | unestablished | `nobody` | owner hibernating | Transferred from an Opus agent to the nobody bot at Skip's r | Moved to `nobody` by `fall-class` 08-13 15:22 **"at Skip's request"** — that citation is unchecked. Title is the transfer note; the real subject is one of the nine in the batch-A list, which resolve only to the second, not to the row. |
| 23d | unestablished | `nobody` | owner hibernating | Task expiry notifications and timer path | Parked by `claude-chief` 08-16 17:51 for "owner hibernating, no live progress" — a fact about the owner, not about the work. **No commit on main carries this subject.** Whether Skip still wants it is his call or the chief's, not an agent's. |
| 23d | unestablished | `nobody` | owner hibernating | Interleaved two-writer editing session test | Parked by `claude-chief` 08-16 17:51 for "owner hibernating, no live progress" — a fact about the owner, not about the work. **No commit on main carries this subject.** Whether Skip still wants it is his call or the chief's, not an agent's. |
| 25d | unestablished | `nobody` | owner hibernating | Restore lifecycle authority and Reanimate | Parked by `claude-chief` 08-16 17:51 for "owner hibernating, no live progress" — a fact about the owner, not about the work. **No commit on main carries this subject.** Whether Skip still wants it is his call or the chief's, not an agent's. |
| 25d | unestablished | `nobody` | owner hibernating | Fix invisible math-agent messages | Parked by `claude-chief` 08-16 17:51 for "owner hibernating, no live progress" — a fact about the owner, not about the work. **No commit on main carries this subject.** Whether Skip still wants it is his call or the chief's, not an agent's. |
| 26d | unestablished | `nobody` | owner hibernating | Transferred from an Opus agent to the nobody bot at Skip's r | Moved to `nobody` by `fall-class` 08-13 15:22 **"at Skip's request"** — that citation is unchecked. Title is the transfer note; the real subject is one of the nine in the batch-A list, which resolve only to the second, not to the row. |
| 31d | done, unclosed | `nobody` | owner hibernating | Split metadata.source into via and source | Real subject recovered: *Split metadata.source into via and source*. `10eb76da9` on main, exact subject. |
| 31d | unestablished | `nobody` | owner hibernating | Build the gesture classifier in the tldraw fork | Parked by `claude-chief` 08-16 17:51 for "owner hibernating, no live progress" — a fact about the owner, not about the work. **No commit on main carries this subject.** Whether Skip still wants it is his call or the chief's, not an agent's. |
| 32d | unestablished | `nobody` | owner hibernating | CLI command for an agent to restart its own MCP | Parked by `claude-chief` 08-16 17:51 for "owner hibernating, no live progress" — a fact about the owner, not about the work. **No commit on main carries this subject.** Whether Skip still wants it is his call or the chief's, not an agent's. |
| 32d | unestablished | `nobody` | owner hibernating | Stop `tlda daemon stop` from unloading the launchd job | Parked by `claude-chief` 08-16 17:51 for "owner hibernating, no live progress" — a fact about the owner, not about the work. **No commit on main carries this subject.** Whether Skip still wants it is his call or the chief's, not an agent's. |
| 32d | unestablished | `nobody` | owner hibernating | Delete wiretaps | Parked by `claude-chief` 08-16 17:51 for "owner hibernating, no live progress" — a fact about the owner, not about the work. **No commit on main carries this subject.** Whether Skip still wants it is his call or the chief's, not an agent's. |
| 32d | unestablished | `nobody` | owner hibernating | Build gesture transitions in the tldraw fork | Parked by `claude-chief` 08-16 17:51 for "owner hibernating, no live progress" — a fact about the owner, not about the work. **No commit on main carries this subject.** Whether Skip still wants it is his call or the chief's, not an agent's. |
| 33d | unestablished | `nobody` | owner hibernating | Recover and build the index page columns | Parked by `claude-chief` 08-16 17:51 for "owner hibernating, no live progress" — a fact about the owner, not about the work. **No commit on main carries this subject.** Whether Skip still wants it is his call or the chief's, not an agent's. |
| 33d | unestablished | `nobody` | owner hibernating | Make composer slider salient on touch | Parked by `claude-chief` 08-16 17:51 for "owner hibernating, no live progress" — a fact about the owner, not about the work. **No commit on main carries this subject.** Whether Skip still wants it is his call or the chief's, not an agent's. |
| 33d | unestablished | `nobody` | owner hibernating | Rebuild index page to Skip’s spec | Parked by `claude-chief` 08-16 17:51 for "owner hibernating, no live progress" — a fact about the owner, not about the work. **No commit on main carries this subject.** Whether Skip still wants it is his call or the chief's, not an agent's. |

## Lab 1 and this week’s lecture — 14, 10 with evidence

| age | status | owner | owner state | task | evidence |
|---|---|---|---|---|---|
| 14m | **live** | `static-deck-toolset` | never picked up | Settle the toolset for static decks outside tlda | Owner `static-deck-toolset` is awake and this was notified 14m ago — in hand now. |
| 16m | **live** | `wm-frame-adapter` | never picked up | Design the external coordinate frame adapter | Owner `wm-frame-adapter` is awake and this was notified 16m ago — in hand now. |
| 5h | **live** | `lab1-deck-tester` | never picked up | Test the Lab 1 deck against Skip's three conditions | Owner `lab1-deck-tester` is awake and this was notified 5h ago — in hand now. |
| 5h | **live** | `lab1-floor-builder` | never picked up | Build the floor deck: code cells, plots visible, in sequence | Owner `lab1-floor-builder` is awake and this was notified 5h ago — in hand now. |
| 5h | **live** | `experiment-plot-design` | never picked up | Design the experiment plot appearance | Owner `experiment-plot-design` is awake and this was notified 5h ago — in hand now. |
| 5h | **live** | `slides-requirements-reader` | never picked up | Read Skip's thread, hold the slide requirements | Owner `slides-requirements-reader` is awake and this was notified 5h ago — in hand now. |
| 5h | **live** | `app-chief` | never picked up | Publish rebuilt deck by the working route | Owner `app-chief` is awake and this was notified 5h ago — in hand now. |
| 5h | **live** | `pic-lab1` | never picked up | Restore stripped slide config and rebuild deck | Owner `pic-lab1` is awake and this was notified 5h ago — in hand now. |
| 6h | **live** | `slides-content-advocate` | never picked up | Advocate: content vs his ask and needs | Owner `slides-content-advocate` is awake and holds this advocacy now. |
| 12h | **live** | `app-chief` | never picked up | Ship Sampling chapter and slide alternate | Owner `app-chief` is awake and this was notified 12h ago — in hand now. |
| 1d | unestablished | `pic-lecture-opus` | owner hibernating | Replace lecture agent with Opus | — |
| 7d | unestablished | `deck-read-late-2` | owner hibernating | Deck/chapter read: Sep 15 and Sep 17 | — |
| 7d | unestablished | `deck-read-mid` | owner hibernating | Deck/chapter read: Sep 3 and Sep 8/10 | — |
| 11d | unestablished | `classroom-quarto-pm` | owner hibernating | Correction superseding the deck-as-peer phrasing: Skip says | — |

## Classroom — homework, release, students — 22, 10 with evidence

| age | status | owner | owner state | task | evidence |
|---|---|---|---|---|---|
| 0m | **live** | `classroom-pm-2` | owner hibernating | Own classroom: homework, release, student flow | Owner `classroom-pm-2` is awake and this was notified 0m ago — in hand now. |
| 11h | **live** | `hw-release-pairing` | never picked up | Fix HTML/ZIP divergence in course release | Owner `hw-release-pairing` is awake and this was notified 11h ago — in hand now. |
| 14h | **live** | `tlda-recovery-chief-sol` | never picked up | Review and assemble classroom book repair | Owner `tlda-recovery-chief-sol` is awake and this was notified 14h ago — in hand now. |
| 16h | **live** | `classroom-delivery-advocate-sol` | never picked up | Gate recovered classroom delivery | Owner `classroom-delivery-advocate-sol` is awake and this was notified 16h ago — in hand now. |
| 21h | unestablished | `bhief-of-getting-shit-done:Mendel` | owner hibernating | This older classroom audit/repair task is now in assembly an | — |
| 23h | unestablished | `pic-book-release-process-opus` | owner hibernating | Establish correct Quarto release process | — |
| 23h | unestablished | `pic-syllabus-schedule-opus` | owner hibernating | Reconcile syllabus topic schedule | — |
| 1d | superseded | `pic-delivery-advocate-opus` | owner hibernating | Advocate PIC delivery | Advocacy seat for work that has moved on; owner `pic-delivery-advocate-opus` hibernating 1d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 1d | unestablished | `pic-homework-opus` | owner hibernating | Deliver working Homework -1 and 0 | — |
| 1d | unestablished | `qtm285-homework-writer` | owner hibernating | Fix HW−1 and HW0 writing | — |
| 1d | superseded | `qtm285-recovery-advocate` | owner hibernating | Advocate QTM285 classroom recovery | Advocacy seat for work that has moved on; owner `qtm285-recovery-advocate` hibernating 1d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 4d | unestablished | `hw0-repair` | owner hibernating | Add Positron visual-mode CSS to handouts | — |
| 4d | done, unclosed | `classroom-positron-heic` | owner hibernating | HEIC drag-drop and Positron submit proof | `147f1e6e8` "A dragged iPhone photo reaches the grader" on main; `9e3cb2a2c` then withdrew the drop provider because the shipped extension already does more. |
| 4d | done, unclosed | `classroom-build-wipe` | owner hibernating | A failed build must not destroy output | `cb1a94beb` on main — "A failed build leaves the last good render serving"; `cff3c21d3` covers the rebuild case. |
| 4d | **live** | `classroom-share-token` | owner hibernating | Fix project share printing wrong-env token | `67ecf5422` landed (checks the token against the box in the URL) — but `classroom-pm-2` re-reported tonight that `share` prints a working URL and QR for a project not on the server it points at, resolving the **host** from shell env. Same family, not the same defect. Chief has already routed the host fix; **do not double-assign.** |
| 4d | unestablished | `alassroom-pm` | owner hibernating | Deliver working public classroom flow | — |
| 4d | unestablished | `classroom-advocate` | owner hibernating | Independently verify classroom recovery | — |
| 7d | done, unclosed | `classroom-layer-builder` | owner hibernating | Build integrated classroom student layers | `430195d67` on main — "Merge classroom student layers". |
| 7d | unestablished | `classroom-pm` | owner hibernating | Recover this existing classroom PM session and carry the att | — |
| 9d | unestablished | `classroom-book-pic` | owner hibernating | Make book build and view on pic | — |
| 9d | unestablished | `classroom-layers-2` | owner hibernating | Build classroom layer system | — |
| 9d | unestablished | `classroom-tokens-2` | owner hibernating | Complete classroom token access | — |

## Sync and source of truth — 19, 8 with evidence

| age | status | owner | owner state | task | evidence |
|---|---|---|---|---|---|
| 15h | **live** | `sync-repair-sol` | never picked up | Repair exact programmatic highlight geometry | Owner `sync-repair-sol` is awake and this was notified 15h ago — in hand now. |
| 16h | **live** | `sync-repair-sol` | — | Implement source reference link semantics | Owner `sync-repair-sol` is awake and this was notified 16h ago — in hand now. |
| 4d | unestablished | `reliability-pm` | owner hibernating | Own recovery for already-diverged sync rooms | — |
| 6d | unestablished | `features-pm` | owner hibernating | Fix TLS preview source push | — |
| 6d | done, unclosed | `reliability-pm` | owner hibernating | Fix symlink closure source push | `f08b95238` on main — resolves a closure member pointing through a committed symlink; `25f697cf6` records the unverifiable criterion. |
| 10d | unestablished | `sync-territory-fix` | owner hibernating | Branch, diverge, merge back without junk commits | — |
| 10d | unestablished | `sync-corruption-proof` | owner hibernating | Prove sync works and does not corrupt projects | — |
| 13d | done, unclosed | `sync-convergence-codex` | owner hibernating | Build sync convergence state-machine tests | `395ac27b8` on main — "Add sync convergence state-machine boundary harness". |
| 13d | unestablished | `overleaf-daemon-codex` | owner hibernating | Implement settled Overleaf daemon sync | — |
| 13d | unestablished | `overleaf-daemon-owner` | owner hibernating | Skip finalized the conflict workflow in messages 3028492–302 | — |
| 13d | unestablished | `sync-convergence-tester` | owner hibernating | Add Skip message 3028421 as a required convergence-harness u | — |
| 13d | superseded | `sync-wedge` | owner hibernating | Manage tlda app priorities | `app-chief` holds this (awake, 95 commits on main, most recent today). |
| 14d | unestablished | `strip-old-sync` | owner hibernating | Mark old-sync entries with Skip's dispositions | — |
| 14d | superseded | `pm-sync` | owner hibernating | PM: sync, Skip's priority 2 | Standing PM seat, owner hibernating 14d; the lane is now run by `reliability-pm`/`sync-repair-sol` under `tlda-recovery-chief-opus`. |
| 14d | unestablished | `bhief-of-staff` | owner hibernating | New sync deploy 2: post-accept effects + daemon caller | — |
| 15d | unestablished | `idio-sweep` | owner hibernating | Think through the idiosyncratic-randomization sweep | — |
| 15d | done, unclosed | `doc-sync-pm` | owner hibernating | Reassigning from bhief-of-staff, who correctly stopped rathe | Title is a reassignment note. The work landed: `22fb6182b` "Make LaTeX membership the closure of the document's roots" — the implementation AGENTS.md §"A subsystem is Skip's decision" names as the correct one. |
| 16d | unestablished | `sync-autopsy` | owner hibernating | Independent root-cause report on document sync | — |
| 18d | done, unclosed | `sync-wedge` | owner hibernating | The owner-only bootstrap action is already satisfied. | The row's own text says the owner-only action is already satisfied. |

## The app Skip uses day to day — 26, 19 with evidence

| age | status | owner | owner state | task | evidence |
|---|---|---|---|---|---|
| 2m | **live** | `backlog-triage` | — | Triage the 197 open tasks and mine chat for unrecorded todos | Owner `backlog-triage` is awake and this was notified 2m ago — in hand now. |
| 4d | unestablished | `search-pm` | owner hibernating | Witness deployed search card interaction | — |
| 5d | done, unclosed | `inbox-empty-diagnosis` | owner hibernating | Diagnose empty inbox shape | `3ab30571d` "Give the inbox its own subscription, like every other panel" + `1f11759f2` "Mark the inbox buffer server-fed, or the subscription delivers into a hole", both on main. |
| 5d | superseded | `search-card-expand` | owner hibernating | Exercise in-app search cards and expand | Expand deleted by `3d4454abe`; replaced by one control, `6a4c8acf4` on main. **Remnant:** never exercised in a browser — `search-pm` established a card with a second page may be unreachable on a preview by construction. |
| 5d | unestablished | `features-pm` | owner hibernating | Remaining work only: verify search-card-one-control on its o | — |
| 5d | unestablished | `project-targets-recovery` | owner hibernating | Recover projects missing layout targets | Lead: `0ce641013` on main, "Stop loading a document from a manifest entry, which has no targets". Fixes the cause; whether the already-broken projects were recovered is not stated. |
| 9d | done, unclosed | `chip-drag` | owner hibernating | Drag a markdown chip onto the canvas to open it | `f03f7f5cb` on main — "Keep Markdown chip drags on canvas pointer path". |
| 11d | unestablished | `chat-intermittency` | owner hibernating | Reproduce Skip's intermittent chat | Lead: `e7aede620` "Make activity card rendering idempotent". That is a fix, not the reproduction this row asks for. |
| 11d | unestablished | `duembgen-proof-sol` | owner hibernating | Snap guides match targets | — |
| 12d | done, unclosed | `pdf-document-architecture` | owner hibernating | Refactor document formats and add PDF | `db61cefd4` on main — "Refactor document formats and add native PDF". |
| 12d | unestablished | `app-tester` | owner hibernating | Trace missing expanded-thread collapse | — |
| 12d | unestablished | `app-tester` | owner hibernating | Trace 30-second project white spinner | — |
| 12d | done, unclosed | `snap-grid-visualization` | owner hibernating | Restore themed snap grid visualization | `1ecc7fd80` on main, plus test `4274f7a4a`. |
| 12d | done, unclosed | `whole-document-diff-ui` | owner hibernating | Implement whole-document history diff | `47eb7d8b8` on main — "Add stateful whole-document history diff". |
| 12d | unestablished | `project-document-ui` | owner hibernating | Acceptance addition from Skip, chat#3086828: finish the narr | Lead: `6719514a2` "Model project document roots by format". Row cites Skip chat#3086828 — read that message before disposing. |
| 12d | unestablished | `ui-artifact-release` | owner hibernating | Review pending UI artifacts | Lead: `000573cac` "Restore source editor panel controls". A review row; what it was reviewing is not named in the title. |
| 12d | unestablished | `app-librarian` | owner hibernating | Correction/addition from Skip, chat#3085884: generate the th | Row cites Skip chat#3085884 — read that message before disposing. |
| 12d | unestablished | `app-tester-codex` | owner hibernating | Citation correction: final scope authority is chat#3071535 a | — |
| 12d | **live** | `bhief-sol` | owner hibernating | Task remains intentionally unstarted under your chat#3067914 | **Intentionally unstarted** under Skip's chat#3067914 — a deliberate hold, not neglect. Read that message before anyone restarts it. |
| 16d | done, unclosed | `history-fold-audit` | owner hibernating | Fix thread historical names and amend marking | `aedd8f978` on main — "Give thread and search recipients the name they held at send time, and mark amends". ⚠ A later standing note says `thread` still does not fold amends — re-check that half before closing. |
| 16d | done, unclosed | `panel-model-row` | owner hibernating | Show an agent's model in the agents panel expansion | `4fac22085` (seat records resolved model) + `8687158d6` (backfill) + `2bbd70231` (also in the table), all on main. |
| 16d | **live** | `claude-scroll-drift-fix` | owner hibernating | URGENT, live, blocking Skip right now — he cannot view his B | Delegated 08-17 02:14 and the thread ends there — the agent never answered. Source-manifest rejection on one of his documents. |
| 16d | done, unclosed | `claude-scroll-drift-fix` | owner hibernating | New, urgent, separate bug — Skip just reported it live: "FUC | `53dccb7ac` on main — pinned annotation viewer wheel+touch. Chief: "Ship as-is — deploying now." **Carve-out below: the regression test Skip asked for was deferred and never built.** |
| 16d | done, unclosed | `claude-scroll-drift-fix` | owner hibernating | Second, different chat-scroll bug — live and urgent, Skip is | `d7e16c36f` on main — debounces the follow-off decision. `claude-chief` deployed it and said "released unless it recurs". Preceded by `fd55a2f72`. |
| 16d | unestablished | `claude-scroll-bottom-fix` | owner hibernating | Update before you start: Skip added detail and pointed you a | — |
| 16d | done, unclosed | `claude-ui-clutter-fix` | owner hibernating | Skip just reported (2026-08-16, ~4:45 PM EDT, verbatim): "I | `71c56104a` on main — "Remove recordings chrome from document view". |

## Infrastructure — daemon, mint, storage, tests — 21, 8 with evidence

| age | status | owner | owner state | task | evidence |
|---|---|---|---|---|---|
| 1d | unestablished | `daemon-suite-red` | owner hibernating | Make main's daemon suite come back clean | — |
| 7d | superseded | `sol-dev-advocate` | owner hibernating | Restore the advocate task to the newly minted `sol-dev-advoc | Restoring an advocate task to `sol-dev-advocate`, which has been hibernating 7d. `sol-dev` is awake and on-call; its advocacy now sits with the current chief advocates. |
| 10d | unestablished | `symptom-gate-probe` | owner dead | Probe: does delegate refuse a dead seat | — |
| 10d | unestablished | `versioning-check` | owner hibernating | Make in-app editing produce a build and a version | Six commits on main incl. `ec37d074e` "Record the root cause: WrongHead, rejected silently" and `94569675b`. Root cause recorded; whether an in-app edit now yields a build **and** a version is not asserted by any of them. |
| 11d | unestablished | `mini-disk` | owner hibernating | Why supervised dev is not reclaiming | — |
| 12d | unestablished | `dev-noticer-release-codex` | owner hibernating | Repair current mint launch failure | — |
| 12d | unestablished | `dev-noticer-release-codex` | owner hibernating | Make cleanup bots reliable | — |
| 13d | unestablished | `app-tester-codex` | owner hibernating | Serve as Codex app tester | — |
| 13d | unestablished | `queue-paper-reader-sol` | owner hibernating | Read exact queue scheduling literature | — |
| 13d | done, unclosed | `queue-theory` | owner hibernating | The build queue design, with the real case | `57e0616b4` on main — gives the build queue its second slot. |
| 14d | unestablished | `drain-probe` | owner hibernating | Mint probe after the outbox discard | — |
| 14d | unestablished | `mint-attach` | owner hibernating | Delegate attaches tasks to the requested name, not the returned id | Owner landed 8 commits on main but none on this subject. |
| 14d | superseded | `pm-mint-comms` | owner hibernating | PM: mint/comms, Skip's priority 1 | Standing PM seat, owner hibernating 14d; the lane is now run by the current chief under `tlda-recovery-chief-opus`. |
| 14d | unestablished | `fleet-db-blocking` | owner hibernating | Prune the 3.82 GB of FTS nobody sweeps | `29e8474a7` put the vacuum runbook in place, but no commit prunes FTS. Per AGENTS.md `auto_vacuum` is `NONE`, so this needs the maintenance-window procedure run, not code. |
| 14d | **live** | `deploy-no-interrupt` | owner hibernating | Ship the front door — deploys stop hurting him | Partly landed — `fc7c58cc0`, `51574efd9` "Move the tailnet front door off the machine a deploy replaces". But the newest commit on the theme, `13d093cc0` (08-28), is *"Stage the cutover, and **stop documenting a front door that is not there**"*. By its own author the front door is not shipped. |
| 15d | unestablished | `he-is-not-the-monitor` | owner hibernating | Get dev running relevant tests against his live surfaces | — |
| 15d | unestablished | `b2-taste` | owner hibernating | Taking this back off my queue — the next action is yours, so | — |
| 16d | unestablished | `history-wire-audit` | owner hibernating | Fix the missing read-file route | — |
| 16d | unestablished | `mint-delegate-fix` | owner hibernating | Fix mint+delegate dropping the delegation | — |
| 16d | unestablished | `mint-login-truth` | owner hibernating | Diagnose mint success-without-login and dropped delegation | — |
| 16d | done, unclosed | `claude-fleet-reliability` | owner hibernating | Urgent, live right now: Skip and other agents' mint attempts | `da1d76f0a` "Fix three false-failure/false-negative reliability bugs found tonight" + `217132a11` in-flight spawn guard against concurrent duplicate mints, both on main. |

## Writing and papers — 44, 27 with evidence

| age | status | owner | owner state | task | evidence |
|---|---|---|---|---|---|
| 15h | **live** | `intro-polish-process-advocate` | never picked up | Keep intro-polish on requested artifact | **Deliberately blocked on one bare question to Skip** — the referent of "second bullet" in his own instruction. Three agents have guessed; the advocate is holding rather than mutating. Subscription #92757 live. This is the one row in this bucket that genuinely needs him. |
| 2d | **live** | `intro-polish` | never picked up | Land remaining edits and clear advocate gate | Held now. `intro-polish-process-advocate` reports the artifact under an active gate, writer frozen, nothing accepted. |
| 9d | unestablished | `paper-safety-pm` | owner hibernating | Own paper-text integrity and the viewing bugs | — |
| 9d | superseded | `appendix-math` | owner hibernating | Find and carry the outstanding appendix math work | Superseded by the current introduction lane: `intro-polish` (awake) with `intro-polish-process-advocate` (awake), which reported 09-01 04:52 that it holds the artifact under an active gate. That lane, not this 9-day-old cohort, is where the work is. |
| 9d | superseded | `term-sentence-writer` | owner hibernating | Write the title-term sentence | Superseded by the current introduction lane: `intro-polish` (awake) with `intro-polish-process-advocate` (awake), which reported 09-01 04:52 that it holds the artifact under an active gate. That lane, not this 9-day-old cohort, is where the work is. |
| 9d | superseded | `intro-sentence-advocate` | owner hibernating | Advocate on the term sentence | Advocacy seat for work that has moved on; owner `intro-sentence-advocate` hibernating 9d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 9d | superseded | `intro-sentence-writer` | owner hibernating | Finish one partially dictated sentence | Superseded by the current introduction lane: `intro-polish` (awake) with `intro-polish-process-advocate` (awake), which reported 09-01 04:52 that it holds the artifact under an active gate. That lane, not this 9-day-old cohort, is where the work is. |
| 9d | superseded | `intro-writer-advocate` | owner hibernating | Advocate on the intro writer | Advocacy seat for work that has moved on; owner `intro-writer-advocate` hibernating 9d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 9d | superseded | `intro-advocate-standing` | owner hibernating | Standing advocate for the introduction | Advocacy seat for work that has moved on; owner `intro-advocate-standing` hibernating 9d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 10d | superseded | `intro-writer-fresh` | owner hibernating | Fresh opus writer for the introduction | Superseded by the current introduction lane: `intro-polish` (awake) with `intro-polish-process-advocate` (awake), which reported 09-01 04:52 that it holds the artifact under an active gate. That lane, not this 9-day-old cohort, is where the work is. |
| 10d | superseded | `intro-opus-advocate` | owner hibernating | Advocate for synth-newintro-advocate on the introduction | Advocacy seat for work that has moved on; owner `intro-opus-advocate` hibernating 10d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 10d | superseded | `appendix-e-advocate-2` | owner hibernating | Advocate for appendix-synth-pushable on Appendix E | Advocacy seat for work that has moved on; owner `appendix-e-advocate-2` hibernating 10d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 10d | unestablished | `appendix-e-advocate-2` | owner hibernating | **This task is Skip's and it is now yours. | — |
| 10d | superseded | `intro-integrator` | owner hibernating | Integrate settled introduction outline | Superseded by the current introduction lane: `intro-polish` (awake) with `intro-polish-process-advocate` (awake), which reported 09-01 04:52 that it holds the artifact under an active gate. That lane, not this 9-day-old cohort, is where the work is. |
| 10d | superseded | `intro-outline-advocate` | owner hibernating | Advocate paragraph two recovery | Advocacy seat for work that has moved on; owner `intro-outline-advocate` hibernating 10d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 10d | superseded | `intro-outline-advocate` | owner hibernating | Final independent outline pass | Superseded by the current introduction lane: `intro-polish` (awake) with `intro-polish-process-advocate` (awake), which reported 09-01 04:52 that it holds the artifact under an active gate. That lane, not this 9-day-old cohort, is where the work is. |
| 10d | superseded | `intro-outline-advocate` | owner hibernating | Recheck repaired outline nodes | Superseded by the current introduction lane: `intro-polish` (awake) with `intro-polish-process-advocate` (awake), which reported 09-01 04:52 that it holds the artifact under an active gate. That lane, not this 9-day-old cohort, is where the work is. |
| 10d | superseded | `intro-outline-advocate` | owner hibernating | Advocate-review current introduction outline | Advocacy seat for work that has moved on; owner `intro-outline-advocate` hibernating 10d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 10d | superseded | `intro-register-critic` | owner hibernating | Compare introduction merges for register | Superseded by the current introduction lane: `intro-polish` (awake) with `intro-polish-process-advocate` (awake), which reported 09-01 04:52 that it holds the artifact under an active gate. That lane, not this 9-day-old cohort, is where the work is. |
| 10d | superseded | `intro-reconciler` | owner hibernating | Reconcile Skip and Dmitry introduction outlines | Superseded by the current introduction lane: `intro-polish` (awake) with `intro-polish-process-advocate` (awake), which reported 09-01 04:52 that it holds the artifact under an active gate. That lane, not this 9-day-old cohort, is where the work is. |
| 10d | superseded | `synth-paper` | owner hibernating | Produce the real introduction outline | Superseded by the current introduction lane: `intro-polish` (awake) with `intro-polish-process-advocate` (awake), which reported 09-01 04:52 that it holds the artifact under an active gate. That lane, not this 9-day-old cohort, is where the work is. |
| 10d | superseded | `paper-advocate` | owner hibernating | Advocate on Skip's paper | Advocacy seat for work that has moved on; owner `paper-advocate` hibernating 10d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 10d | superseded | `rynth-advocate` | owner hibernating | Advocate watching synth-paper | Advocacy seat for work that has moved on; owner `rynth-advocate` hibernating 10d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 10d | superseded | `writing` | owner hibernating | Write the randomization-synth intro with Skip | Superseded by the current introduction lane: `intro-polish` (awake) with `intro-polish-process-advocate` (awake), which reported 09-01 04:52 that it holds the artifact under an active gate. That lane, not this 9-day-old cohort, is where the work is. |
| 10d | superseded | `synth-paper` | owner hibernating | Work with Skip on the paper, starting with the overlap merge | Superseded by the current introduction lane: `intro-polish` (awake) with `intro-polish-process-advocate` (awake), which reported 09-01 04:52 that it holds the artifact under an active gate. That lane, not this 9-day-old cohort, is where the work is. |
| 12d | unestablished | `fixed-count-prefix-sol` | owner hibernating | Recovery trigger: resume this exact existing integration tas | — |
| 12d | unestablished | `fixed-count-prefix-sol` | owner hibernating | Prove centered multiplier transfer | — |
| 12d | unestablished | `fixed-count-prefix-sol` | owner hibernating | Prove fixed-count Gram transfer | — |
| 12d | unestablished | `fixed-count-prefix-sol` | owner hibernating | Prove fixed-count small-ball transfer | — |
| 12d | unestablished | `fixed-count-prefix-sol` | owner hibernating | Repair optimizer block-mass rate | — |
| 12d | unestablished | `fixed-count-prefix-sol` | owner hibernating | Audit slow-diagonal absorption | — |
| 13d | unestablished | `fixed-count-review-sol` | owner hibernating | Extract readable fixed-count proof outline | — |
| 13d | unestablished | `fixed-count-review-sol` | owner hibernating | Re-review corrected fixed-count consumer | — |
| 13d | unestablished | `asymptotic-rate-sol` | owner hibernating | Write realized-count proof repair | — |
| 13d | unestablished | `asymptotic-rate-sol` | owner hibernating | Discharge diagonal repair gate | — |
| 13d | unestablished | `perm-transfer` | owner hibernating | Can cor:vanishing-share carry a rate | — |
| 13d | unestablished | `e2-specialist` | owner hibernating | Read appendix E2 and be ready to help | — |
| 15d | superseded | `duality-fml2765` | owner hibernating | WITHDRAWN BY SKIP 2026-08-18 ~01:25 EDT. | The row's own text: **withdrawn by Skip, 2026-08-18 ~01:25 EDT.** |
| 15d | **live** | `duality-fml2765` | owner hibernating | Parked: garbage in the B.3 setting | Explicitly **parked**, not abandoned. Owner hibernating 14d; parking was a decision, resuming is one too. |
| 15d | **live** | `duality-fml2765` | owner hibernating | Parked: B.2's a.e. handling, deal properly | Explicitly **parked**, not abandoned. Owner hibernating 14d. |
| 15d | superseded | `eiv-advocate` | owner hibernating | Advocate for eiv-paper work | Advocacy seat for work that has moved on; owner `eiv-advocate` hibernating 15d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 16d | unestablished | `interviewer-c` | owner hibernating | Interview transcript lines 1201-1774 | — |
| 16d | unestablished | `interviewer-b` | owner hibernating | Interview transcript lines 601-1200 | — |
| 16d | unestablished | `synth-audit` | owner hibernating | Meant-vs-actual audit of tonight's paper edits | — |

## Fleet process, ownership, audits — 50, 27 with evidence

| age | status | owner | owner state | task | evidence |
|---|---|---|---|---|---|
| 5h | **live** | `chief-advocate-fresh` | never picked up | Fresh advocate checking the chief | Owner `chief-advocate-fresh` is awake and holds this advocacy now. |
| 5h | **live** | `tlda-recovery-chief-opus` | never picked up | **Interval moved from 5 minutes to 30 while Skip is teaching | Owner `tlda-recovery-chief-opus` is awake and this was notified 5h ago — in hand now. |
| 5h | **live** | `tlda-recovery-chief-opus` | — | ## How I work — Skip, 09-01 13:0x EDT > YOU DO NOT HAVE THE | Owner `tlda-recovery-chief-opus` is awake and this was notified 5h ago — in hand now. |
| 5h | **live** | `tlda-recovery-chief-opus` | never picked up | **Carried list as of 15:57, and the interval goes 15m → 30m | Owner `tlda-recovery-chief-opus` is awake and this was notified 5h ago — in hand now. |
| 7h | **live** | `tlda-recovery-chief-opus` | never picked up | **Class is over — 17:50, his words: "im done with class dude. | Owner `tlda-recovery-chief-opus` is awake and this was notified 7h ago — in hand now. |
| 12h | **live** | `tlda-recovery-chief-advocate-4` | never picked up | Advocate tlda recovery chief | Owner `tlda-recovery-chief-advocate-4` is awake and holds this advocacy now. |
| 16h | **live** | `app-chief` | — | Index standing subscription queries | Blocked, 16h old, owner `app-chief` active. Note `35143d4e7` *deleted* "an index nobody queries" — worth reconciling against this before building one. |
| 16h | **live** | `tlda-recovery-chief-sol` | never picked up | Ownership transfer while the chief/package lane has the next | Owner `tlda-recovery-chief-sol` is awake and this was notified 16h ago — in hand now. |
| 16h | unestablished | `bhief-of-getting-shit-done:Mendel` | owner hibernating | Next action is your independent PASS/BLOCK on exact held com | — |
| 17h | **live** | `app-chief` | — | Implement corrected handoff enforcement | Owner `app-chief` is awake and this was notified 17h ago — in hand now. |
| 21h | **live** | `tlda-recovery-chief-sol` | never picked up | Ownership transfer while the chief/package lane has the next | Owner `tlda-recovery-chief-sol` is awake and this was notified 21h ago — in hand now. |
| 1d | unestablished | `tlda-recovery-chief-sol` | never picked up | Ownership transfer while the chief/package lane has the next | — |
| 1d | unestablished | `tlda-recovery-chief-sol` | never picked up | Ownership transfer while the chief/package lane has the next | — |
| 1d | unestablished | `tlda-recovery-chief-sol` | never picked up | Ownership transfer while the chief/package lane has the next | — |
| 2d | done, unclosed | `sol-dev` | never picked up | Integrated PIC-dev stage is complete and production is uncha | The row's own text: the integrated stage is complete and production unchanged. |
| 5d | unestablished | `existing-project-link` | owner hibernating | Fix existing-project link hang | Lead: `2e9ef9e91` on main, "Re-ask for the confirmation, do not rebuild the history that was already sent" — same area, but it does not say the hang is gone. |
| 6d | unestablished | `sol-dev` | never picked up | Decide: 13GB unreproducible, remaining conditions need your call | — |
| 7d | unestablished | `sol-dev` | never picked up | **Transferring because the next action is yours. | — |
| 9d | superseded | `sol-advocate` | owner hibernating | Watch chief work against Skip's ask | Advocacy seat for work that has moved on; owner `sol-advocate` hibernating 9d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 9d | unestablished | `reliability-pm` | owner hibernating | Own whether the app works for Skip day to day | — |
| 10d | unestablished | `model-default-probe` | owner hibernating | Verify the resolved model default | — |
| 10d | superseded | `advocate-3-2` | owner hibernating | Advocate for chief-advocate-2 | Advocacy seat for work that has moved on; owner `advocate-3-2` hibernating 10d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 10d | superseded | `chief-opus-2` | owner hibernating | Take the chief of staff seat | Advocacy seat for work that has moved on; owner `chief-opus-2` hibernating 10d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 11d | superseded | `chief-advocate` | owner hibernating | Advocate for chief-opus | Advocacy seat for work that has moved on; owner `chief-advocate` hibernating 11d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 11d | superseded | `chief-opus-2` | owner hibernating | **Stood down from this seat by Skip, 2026-08-22 ~18:44 EDT** | The row's own text is the evidence: **Skip stood this seat down, 2026-08-22 ~18:44 EDT.** Four chiefs have held it since. |
| 11d | unestablished | `bhief-sol` | owner hibernating | Corrected candidate returned — transferring, since by your o | — |
| 11d | unestablished | `bhief-sol` | owner hibernating | Candidate ready for integrated current-main and advocate rev | — |
| 12d | unestablished | `bhief-sol` | owner hibernating | Take ownership and implement the task as assigned by the cur | — |
| 12d | done, unclosed | `chief-sol` | owner hibernating | Primitive-condition repair is complete and reported in messa | The row's own text: repair complete and reported. The cited message is the evidence to check if closing. |
| 12d | unestablished | `bhief-sol` | owner hibernating | Recovered canonical record and created `/Users/skip/worktree | — |
| 12d | unestablished | `app-librarian` | owner hibernating | Retry retained document failures each sweep | — |
| 13d | done, unclosed | `lexical-me-owner` | owner hibernating | Canonical ownership transfer. | Title is a transfer note; the work is lexical `me`, landed as `cdada954c` "Fix lexical me in thread cards" on main. Matches the standing ruling in AGENTS.md §"`me` IS LEXICALLY SCOPED". |
| 13d | superseded | `appchief-sol-successor-3` | owner hibernating | Manage tlda app priorities | `app-chief` holds this (awake, 95 commits on main, most recent today). |
| 13d | superseded | `sol-lead` | owner hibernating | Manage tlda app priorities | `app-chief` holds this (awake, 95 commits on main, most recent today). |
| 14d | superseded | `chief-night` | owner hibernating | Take the chief of staff seat | Advocacy seat for work that has moved on; owner `chief-night` hibernating 14d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 14d | superseded | `advocate-chief-night` | owner hibernating | Advocate watching chief-night tonight | Advocacy seat for work that has moved on; owner `advocate-chief-night` hibernating 14d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 14d | unestablished | `audit-s6` | owner hibernating | Audit slice S6: Aug 13 commits | — |
| 14d | superseded | `pm-audit` | owner hibernating | PM: the August keep/cut audit | Standing PM seat, owner hibernating 14d; the lane is now run by the current chief under `tlda-recovery-chief-opus`. |
| 14d | unestablished | `audit-two-weeks` | owner hibernating | Audit the two-week window under the last two chiefs | — |
| 14d | unestablished | `chief-night-handed-off` | owner hibernating | **Item 8, final piece of the design, from Skip. | — |
| 15d | unestablished | `chief-aug18` | owner hibernating | **This is the seat's recurring obligation and the seat is yo | — |
| 15d | unestablished | `solved-non-problems` | — | # handback **Handing this back because every remaining acti | — |
| 15d | unestablished | `solved-non-problems` | owner hibernating | Transferring per your ruling — nothing on this list is mine | — |
| 15d | unestablished | `tlda-autopsy-fml` | owner hibernating | Chief-of-staff live coordination checkpoint | — |
| 16d | done, unclosed | `history-wire-audit` | owner hibernating | Give task transitions a record | `b18d29862` on main — "Record the task transitions that left no trace". |
| 16d | unestablished | `history-fold-audit` | owner hibernating | Audit history table folds | — |
| 16d | superseded | `bhief-advocate` | owner hibernating | Advocate for the chief-of-staff seat | Advocacy seat for work that has moved on; owner `bhief-advocate` hibernating 16d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 16d | unestablished | `bregman-architect` | owner hibernating | URGENT, live, blocking Skip right now — he cannot view his B | — |
| 17d | superseded | `claude-chief-advocate` | owner hibernating | You are the independent Claude advocate for the tlda chief-o | Advocacy seat for work that has moved on; owner `claude-chief-advocate` hibernating 17d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 41d | unestablished | `pin` | owner hibernating | Integrate approved freshness resilience manifest | — |

---

## Totals

| mark | rows |
|---|---|
| **live** | 35 |
| done, unclosed | 26 |
| superseded | 42 |
| unestablished | 142 |
| **all** | 245 |
