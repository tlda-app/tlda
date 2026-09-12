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

**231 of the 245 rows now carry a disposition.** The 14 that do not are Skip's
own — listed, untouched, because closing them is his.

**95 of the 231 are `unestablished`, and every one of them says why**, which is
the useful half: the lead that does not settle it, or the reason it cannot be
settled from here. Three recurring reasons are worth naming, because they are
structural rather than per-row:

- **The title is a handoff note.** 17 rows. What was transferred lives only in a
  referenced thread or message id — the §3 defect one row at a time.
- **It cannot be settled from this repository.** 17 rows, a mathematics cohort
  that all hibernated on 08-19/08-20; the work is in paper checkouts, so no
  commit here can speak to it.
- **A lead exists and stops short.** The commit is adjacent, or predates the row
  and is therefore prior art rather than its resolution.

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

## Lab 1 and this week’s lecture — 14, 14 with evidence

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
| 1d | superseded | `pic-lecture-opus` | owner hibernating | Replace lecture agent with Opus | A staffing action. `pic-lecture-advocate` and the Lab 1 cohort are awake on opus and ran today's lecture day. |
| 7d | **live** | `deck-read-late-2` | owner hibernating | Deck/chapter read: Sep 15 and Sep 17 | **Dated.** Raised 7d ago, owner `deck-read-late-2` hibernating since. |
| 7d | **live** | `deck-read-mid` | owner hibernating | Deck/chapter read: Sep 3 and Sep 8/10 | **Dated, and the first date is in 48 hours.** Raised 7d ago, owner `deck-read-mid` hibernating since. Nobody is reading these. |
| 11d | unestablished | `classroom-quarto-pm` | owner hibernating | Correction superseding the deck-as-peer phrasing: Skip says | **The title is a handoff/correction note, not the task.** What it transfers is only in the referenced thread or message id. Establishing it means reading that reference — the same defect as the 39 rows in §3, one at a time rather than in bulk. |

## Classroom — homework, release, students — 22, 22 with evidence

| age | status | owner | owner state | task | evidence |
|---|---|---|---|---|---|
| 0m | **live** | `classroom-pm-2` | owner hibernating | Own classroom: homework, release, student flow | Owner `classroom-pm-2` is awake and this was notified 0m ago — in hand now. |
| 11h | **live** | `hw-release-pairing` | never picked up | Fix HTML/ZIP divergence in course release | Owner `hw-release-pairing` is **awake**. Leads `78ca0ae63` "Retry interrupted course release stages" (08-30) and `d0b8098c9` (08-31) are adjacent, neither asserts the divergence fixed. |
| 14h | **live** | `tlda-recovery-chief-sol` | never picked up | Review and assemble classroom book repair | Owner `tlda-recovery-chief-sol` is awake and this was notified 14h ago — in hand now. |
| 16h | **live** | `classroom-delivery-advocate-sol` | never picked up | Gate recovered classroom delivery | Owner `classroom-delivery-advocate-sol` is awake and this was notified 16h ago — in hand now. |
| 21h | unestablished | `bhief-of-getting-shit-done:Mendel` | owner hibernating | This older classroom audit/repair task is now in assembly an | **The title is a handoff/correction note, not the task.** What it transfers is only in the referenced thread or message id. Establishing it means reading that reference — the same defect as the 39 rows in §3, one at a time rather than in bulk. |
| 23h | **live** | `pic-book-release-process-opus` | owner hibernating | Establish correct Quarto release process | Rolled into tonight's classroom recovery — `classroom-pm-2`, `classroom-repair-sol`, `classroom-ui-sol`, `hw-release-pairing`, `pic-release-opus`, all awake under the chief. Still wanted; the owner on this row is not the one doing it. No commit on main carries this subject; the chief has the release process live tonight. |
| 23h | **live** | `pic-syllabus-schedule-opus` | owner hibernating | Reconcile syllabus topic schedule | Rolled into tonight's classroom recovery — `classroom-pm-2`, `classroom-repair-sol`, `classroom-ui-sol`, `hw-release-pairing`, `pic-release-opus`, all awake under the chief. Still wanted; the owner on this row is not the one doing it. No commit on main carries this subject. |
| 1d | superseded | `pic-delivery-advocate-opus` | owner hibernating | Advocate PIC delivery | Advocacy seat for work that has moved on; owner `pic-delivery-advocate-opus` hibernating 1d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 1d | **live** | `pic-homework-opus` | owner hibernating | Deliver working Homework -1 and 0 | **Still open tonight.** The chief reports `classroom-pm-2` established HW−1 and HW0 **reach zero students** — never in `documentRoots` — and that `week0-homework.qmd` is published while its source no longer exists in the repo. `7989cb60f`/`6864b4180` (09-01) fix visual-mode rendering, which is a different half. |
| 1d | **live** | `qtm285-homework-writer` | owner hibernating | Fix HW−1 and HW0 writing | Rolled into tonight's classroom recovery — `classroom-pm-2`, `classroom-repair-sol`, `classroom-ui-sol`, `hw-release-pairing`, `pic-release-opus`, all awake under the chief. Still wanted; the owner on this row is not the one doing it. Same subject as the row above, which the chief has live. |
| 1d | superseded | `qtm285-recovery-advocate` | owner hibernating | Advocate QTM285 classroom recovery | Advocacy seat for work that has moved on; owner `qtm285-recovery-advocate` hibernating 1d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 4d | done, unclosed | `hw0-repair` | owner hibernating | Add Positron visual-mode CSS to handouts | `6864b4180` "Recognize homework in Quarto visual mode" and `7989cb60f` "Package visual-mode homework fix as 0.2.8", both on main today (09-01), both postdating this row. |
| 4d | done, unclosed | `classroom-positron-heic` | owner hibernating | HEIC drag-drop and Positron submit proof | `147f1e6e8` "A dragged iPhone photo reaches the grader" on main; `9e3cb2a2c` then withdrew the drop provider because the shipped extension already does more. |
| 4d | done, unclosed | `classroom-build-wipe` | owner hibernating | A failed build must not destroy output | `cb1a94beb` on main — "A failed build leaves the last good render serving"; `cff3c21d3` covers the rebuild case. |
| 4d | **live** | `classroom-share-token` | owner hibernating | Fix project share printing wrong-env token | `67ecf5422` landed (checks the token against the box in the URL) — but `classroom-pm-2` re-reported tonight that `share` prints a working URL and QR for a project not on the server it points at, resolving the **host** from shell env. Same family, not the same defect. Chief has already routed the host fix; **do not double-assign.** |
| 4d | **live** | `alassroom-pm` | owner hibernating | Deliver working public classroom flow | Rolled into tonight's classroom recovery — `classroom-pm-2`, `classroom-repair-sol`, `classroom-ui-sol`, `hw-release-pairing`, `pic-release-opus`, all awake under the chief. Still wanted; the owner on this row is not the one doing it. No commit on main carries this subject. |
| 4d | superseded | `classroom-advocate` | owner hibernating | Independently verify classroom recovery | `classroom-advocate` landed its record — `d153376a9` "The advocate's record of the classroom recovery", `f032ff8fd`, `bb22c804b`, `fd0a28a63`, `5ef53e13a` (all 08-28). Verification of *that* recovery is filed; tonight's is a later one with its own advocates awake. |
| 7d | done, unclosed | `classroom-layer-builder` | owner hibernating | Build integrated classroom student layers | `430195d67` on main — "Merge classroom student layers". |
| 7d | superseded | `classroom-pm` | owner hibernating | Recover this existing classroom PM session and carry the att | Session recovery for `classroom-pm`, hibernating 7d. `classroom-pm-2` is awake and carrying the lane. |
| 9d | **live** | `classroom-book-pic` | owner hibernating | Make book build and view on pic | `85326627a` (08-25) is a resumption point naming the cause: **pic has no daemon, which is why the course book never built.** A diagnosis, not a fix — the row stands and is blocked on that. |
| 9d | superseded | `classroom-layers-2` | owner hibernating | Build classroom layer system | Overtaken by the layer work that landed: `430195d67` "Merge classroom student layers" (08-27) and `c9978e0f9` "Compose classroom layers for the instructor" (08-31). |
| 9d | **live** | `classroom-tokens-2` | owner hibernating | Complete classroom token access | Rolled into tonight's classroom recovery — `classroom-pm-2`, `classroom-repair-sol`, `classroom-ui-sol`, `hw-release-pairing`, `pic-release-opus`, all awake under the chief. Still wanted; the owner on this row is not the one doing it. Leads `b669537cc` "Gate pic-dev with classroom tokens" and `6404d0106` "Ask who the reader is by credential, not by query parameter" (both 08-27/28) move it but do not assert it complete. |

## Sync and source of truth — 19, 19 with evidence

| age | status | owner | owner state | task | evidence |
|---|---|---|---|---|---|
| 15h | **live** | `sync-repair-sol` | never picked up | Repair exact programmatic highlight geometry | Owner `sync-repair-sol` is awake and this was notified 15h ago — in hand now. |
| 16h | **live** | `sync-repair-sol` | — | Implement source reference link semantics | Owner `sync-repair-sol` is awake and this was notified 16h ago — in hand now. |
| 4d | unestablished | `reliability-pm` | owner hibernating | Own recovery for already-diverged sync rooms | Lead: `304b054b7` (08-29) "Apply the accepted head when doing so cannot cost anything". `a1c0d768c` is a warning against this row's own method — *"Record two instruments agreeing on an absence because they share a blind spot."* |
| 6d | done, unclosed | `features-pm` | owner hibernating | Fix TLS preview source push | `e5701db4e` (08-26) on main — "The server's self-remote uses the host its cert is issued for"; `29389baf2` records the `TLDA_SELF_BASE_URL` trap alongside it. |
| 6d | done, unclosed | `reliability-pm` | owner hibernating | Fix symlink closure source push | `f08b95238` on main — resolves a closure member pointing through a committed symlink; `25f697cf6` records the unverifiable criterion. |
| 10d | unestablished | `sync-territory-fix` | owner hibernating | Branch, diverge, merge back without junk commits | Leads `4f588b0e6` (08-28) "Record the equal-tree silent success as the probe boundary" and this owner's nine commits on main to 08-22. None asserts the junk-commit-free round trip. |
| 10d | unestablished | `sync-corruption-proof` | owner hibernating | Prove sync works and does not corrupt projects | No commit asserts this proof. `21a4e891` landed nothing on main. |
| 13d | done, unclosed | `sync-convergence-codex` | owner hibernating | Build sync convergence state-machine tests | `395ac27b8` on main — "Add sync convergence state-machine boundary harness". |
| 13d | done, unclosed | `overleaf-daemon-codex` | owner hibernating | Implement settled Overleaf daemon sync | `e3ba10559` "Make Git remotes ordinary daemon sources", `6d524dea7`, `84b9733f2`, `3d7565539` — this owner's four commits on main (08-20). `8b4eac118` (08-24) then records **"Overleaf settled as fine"**. |
| 13d | unestablished | `overleaf-daemon-owner` | owner hibernating | Skip finalized the conflict workflow in messages 3028492–302 | **The title is a handoff/correction note, not the task.** What it transfers is only in the referenced thread or message id. Establishing it means reading that reference — the same defect as the 39 rows in §3, one at a time rather than in bulk. |
| 13d | unestablished | `sync-convergence-tester` | owner hibernating | Add Skip message 3028421 as a required convergence-harness u | **The title is a handoff/correction note, not the task.** What it transfers is only in the referenced thread or message id. Establishing it means reading that reference — the same defect as the 39 rows in §3, one at a time rather than in bulk. |
| 13d | superseded | `sync-wedge` | owner hibernating | Manage tlda app priorities | `app-chief` holds this (awake, 95 commits on main, most recent today). |
| 14d | unestablished | `strip-old-sync` | owner hibernating | Mark old-sync entries with Skip's dispositions | Lead: `b48d98be0` (08-22) "Recover the sixteen sync promises as a specification" — the specification exists; whether his dispositions were marked against it is not asserted. |
| 14d | superseded | `pm-sync` | owner hibernating | PM: sync, Skip's priority 2 | Standing PM seat, owner hibernating 14d; the lane is now run by `reliability-pm`/`sync-repair-sol` under `tlda-recovery-chief-opus`. |
| 14d | unestablished | `bhief-of-staff` | owner hibernating | New sync deploy 2: post-accept effects + daemon caller | Lead: `8df7d86bc` (08-18) "Give the accept path the effects it owed, so an accept preserves the work" — this owner's own commit and plausibly the deliverable, but it does not name the daemon caller half. |
| 15d | unestablished | `idio-sweep` | owner hibernating | Think through the idiosyncratic-randomization sweep | Part of a mathematics cohort that all hibernated on 08-19/08-20. **Not establishable from this repository** — the work lives in paper checkouts, not in tlda, so no commit here can settle it. Needs `math-historian` or a read of these threads. |
| 15d | done, unclosed | `doc-sync-pm` | owner hibernating | Reassigning from bhief-of-staff, who correctly stopped rathe | Title is a reassignment note. The work landed: `22fb6182b` "Make LaTeX membership the closure of the document's roots" — the implementation AGENTS.md §"A subsystem is Skip's decision" names as the correct one. |
| 16d | unestablished | `sync-autopsy` | owner hibernating | Independent root-cause report on document sync | No commit carries this subject. The nearest artifacts are `9a66b204`'s own; the sync root-cause work that did land came from other owners. |
| 18d | done, unclosed | `sync-wedge` | owner hibernating | The owner-only bootstrap action is already satisfied. | The row's own text says the owner-only action is already satisfied. |

## The app Skip uses day to day — 26, 26 with evidence

| age | status | owner | owner state | task | evidence |
|---|---|---|---|---|---|
| 2m | **live** | `backlog-triage` | — | Triage the 197 open tasks and mine chat for unrecorded todos | Owner `backlog-triage` is awake and this was notified 2m ago — in hand now. |
| 4d | superseded | `search-pm` | owner hibernating | Witness deployed search card interaction | `b5011fca1` (08-27) "Record the search integration disposition" is this owner's own filing. The card itself changed under it — expand deleted `3d4454abe`, one control landed `6a4c8acf4` — so what this row was to witness no longer exists in that form. |
| 5d | done, unclosed | `inbox-empty-diagnosis` | owner hibernating | Diagnose empty inbox shape | `3ab30571d` "Give the inbox its own subscription, like every other panel" + `1f11759f2` "Mark the inbox buffer server-fed, or the subscription delivers into a hole", both on main. |
| 5d | superseded | `search-card-expand` | owner hibernating | Exercise in-app search cards and expand | Expand deleted by `3d4454abe`; replaced by one control, `6a4c8acf4` on main. **Remnant:** never exercised in a browser — `search-pm` established a card with a second page may be unreachable on a preview by construction. |
| 5d | **live** | `features-pm` | owner hibernating | Remaining work only: verify search-card-one-control on its o | `6a4c8acf4` and `196dd5929` landed on main, so the change is shipped and **unverified on the surface**. `search-pm` established the obstacle: a card with a second page of results may be unreachable on a preview by construction — `--sandbox` gives a daemon but no real history, `--real-fleet` the reverse. That obstacle is the thing to settle, not the button. |
| 5d | unestablished | `project-targets-recovery` | owner hibernating | Recover projects missing layout targets | Lead: `0ce641013` on main, "Stop loading a document from a manifest entry, which has no targets". Fixes the cause; whether the already-broken projects were recovered is not stated. |
| 9d | done, unclosed | `chip-drag` | owner hibernating | Drag a markdown chip onto the canvas to open it | `f03f7f5cb` on main — "Keep Markdown chip drags on canvas pointer path". |
| 11d | unestablished | `chat-intermittency` | owner hibernating | Reproduce Skip's intermittent chat | Lead: `e7aede620` "Make activity card rendering idempotent". That is a fix, not the reproduction this row asks for. |
| 11d | unestablished | `duembgen-proof-sol` | owner hibernating | Snap guides match targets | `050f97837` (08-21) "Make every fleet snap guide actionable" postdates the row and may close it. Against that, Skip's `the-list.md` carries **"The guides do not say which line you will actually snap to"** at ○ — but that list was last written 08-13, *before* the commit, so it cannot settle this either way. Needs one look at the running app. |
| 12d | done, unclosed | `pdf-document-architecture` | owner hibernating | Refactor document formats and add PDF | `db61cefd4` on main — "Refactor document formats and add native PDF". |
| 12d | unestablished | `app-tester` | owner hibernating | Trace missing expanded-thread collapse | Leads `f8da9eb67` (08-12) and `7020b5117` (08-06) are in this exact area but **both predate the row**, so they are prior art, not its resolution. Blocked on `fleet:2b6f-mt2ko64i` (the white-spinner row) and never picked up. |
| 12d | unestablished | `app-tester` | owner hibernating | Trace 30-second project white spinner | Lead: `b6161bc45` (08-18) "Show the last good render while a rebuild runs" — masks the wait rather than explaining 30 seconds. `94ade5eed` warns in the same area about a monitor flagging designed behaviour as a fault. |
| 12d | done, unclosed | `snap-grid-visualization` | owner hibernating | Restore themed snap grid visualization | `1ecc7fd80` on main, plus test `4274f7a4a`. |
| 12d | done, unclosed | `whole-document-diff-ui` | owner hibernating | Implement whole-document history diff | `47eb7d8b8` on main — "Add stateful whole-document history diff". |
| 12d | unestablished | `project-document-ui` | owner hibernating | Acceptance addition from Skip, chat#3086828: finish the narr | Lead: `6719514a2` "Model project document roots by format". Row cites Skip chat#3086828 — read that message before disposing. |
| 12d | unestablished | `ui-artifact-release` | owner hibernating | Review pending UI artifacts | Lead: `000573cac` "Restore source editor panel controls". A review row; what it was reviewing is not named in the title. |
| 12d | unestablished | `app-librarian` | owner hibernating | Correction/addition from Skip, chat#3085884: generate the th | Row cites Skip chat#3085884 — read that message before disposing. |
| 12d | unestablished | `app-tester-codex` | owner hibernating | Citation correction: final scope authority is chat#3071535 a | **The title is a handoff/correction note, not the task.** What it transfers is only in the referenced thread or message id. Establishing it means reading that reference — the same defect as the 39 rows in §3, one at a time rather than in bulk. |
| 12d | **live** | `bhief-sol` | owner hibernating | Task remains intentionally unstarted under your chat#3067914 | **Intentionally unstarted** under Skip's chat#3067914 — a deliberate hold, not neglect. Read that message before anyone restarts it. |
| 16d | **live** | `history-fold-audit` | owner hibernating | Fix thread historical names and amend marking | Half landed: `aedd8f978` on main gives thread/search recipients the name they held at send time. **The amend half is not done** — Skip's own `the-list.md` carries `The agent read path does not fold amends` at 🔨, and that list postdates nothing that would have closed it. Do not close on the commit alone. |
| 16d | done, unclosed | `panel-model-row` | owner hibernating | Show an agent's model in the agents panel expansion | `4fac22085` (seat records resolved model) + `8687158d6` (backfill) + `2bbd70231` (also in the table), all on main. |
| 16d | **live** | `claude-scroll-drift-fix` | owner hibernating | URGENT, live, blocking Skip right now — he cannot view his B | Delegated 08-17 02:14 and the thread ends there — the agent never answered. Source-manifest rejection on one of his documents. |
| 16d | done, unclosed | `claude-scroll-drift-fix` | owner hibernating | New, urgent, separate bug — Skip just reported it live: "FUC | `53dccb7ac` on main — pinned annotation viewer wheel+touch. Chief: "Ship as-is — deploying now." **Carve-out below: the regression test Skip asked for was deferred and never built.** |
| 16d | done, unclosed | `claude-scroll-drift-fix` | owner hibernating | Second, different chat-scroll bug — live and urgent, Skip is | `d7e16c36f` on main — debounces the follow-off decision. `claude-chief` deployed it and said "released unless it recurs". Preceded by `fd55a2f72`. |
| 16d | unestablished | `claude-scroll-bottom-fix` | owner hibernating | Update before you start: Skip added detail and pointed you a | **The title is a handoff/correction note, not the task.** What it transfers is only in the referenced thread or message id. Establishing it means reading that reference — the same defect as the 39 rows in §3, one at a time rather than in bulk. |
| 16d | done, unclosed | `claude-ui-clutter-fix` | owner hibernating | Skip just reported (2026-08-16, ~4:45 PM EDT, verbatim): "I | `71c56104a` on main — "Remove recordings chrome from document view". |

## Infrastructure — daemon, mint, storage, tests — 21, 21 with evidence

| age | status | owner | owner state | task | evidence |
|---|---|---|---|---|---|
| 1d | done, unclosed | `daemon-suite-red` | owner hibernating | Make main's daemon suite come back clean | Owner `daemon-suite-red` is awake and landed the run on 08-31: `e5cdf8d4e` "Retire daemon tests asserting three replaced contracts", `cf5aa7e32`, `69b467bb0`, `8d634aae4`, `c4a9084fa` — five commits on main clearing stale assertions. |
| 7d | superseded | `sol-dev-advocate` | owner hibernating | Restore the advocate task to the newly minted `sol-dev-advoc | Restoring an advocate task to `sol-dev-advocate`, which has been hibernating 7d. `sol-dev` is awake and on-call; its advocacy now sits with the current chief advocates. |
| 10d | superseded | `symptom-gate-probe` | owner dead | Probe: does delegate refuse a dead seat | The question was closed from the other side: `203476dda` (08-23) "Close the delegate-notifies-a-live-recipient question with the missing control", and `770f3f375` (08-19) "Never infer death: a failed reanimate leaves a hibernating agent" settles what a dead seat even is. Owner is the one agent in the fleet **marked dead**. |
| 10d | unestablished | `versioning-check` | owner hibernating | Make in-app editing produce a build and a version | Six commits on main incl. `ec37d074e` "Record the root cause: WrongHead, rejected silently" and `94569675b`. Root cause recorded; whether an in-app edit now yields a build **and** a version is not asserted by any of them. |
| 11d | **live** | `mini-disk` | owner hibernating | Why supervised dev is not reclaiming | Skip's own `the-list.md` carries this at ○ — **"An inert `dev` reclaims no disk"**. Not currently biting: 75 GB free, load 17.6, measured tonight. But `dev` runs as `quiet-dev`, and per `96c35417d` that prefix has two causes and only one of them is a decision. |
| 12d | done, unclosed | `dev-noticer-release-codex` | owner hibernating | Repair current mint launch failure | `f5c044ea2` (08-20) on main, by this owner — "Make mint launch state durable before session discovery"; `39648f5b5` adds "Tell the requester when a mint launches and never answers". |
| 12d | **live** | `dev-noticer-release-codex` | owner hibernating | Make cleanup bots reliable | Blocked on `fleet:0f10-mt1swqpo`. Nothing on main carries it, and it is the same subject as Skip's own `the-list.md` row **"Bots that aren't all fucked up"** — *"that's a fucking item, right"*, his words. |
| 13d | superseded | `app-tester-codex` | owner hibernating | Serve as Codex app tester | A standing seat for a Codex tester, hibernating 13d. `app-tester` and `tlda-dev pw` cover this, and the chief issued a standing rule on the pooled browser tonight. |
| 13d | unestablished | `queue-paper-reader-sol` | owner hibernating | Read exact queue scheduling literature | Part of a mathematics cohort that all hibernated on 08-19/08-20. **Not establishable from this repository** — the work lives in paper checkouts, not in tlda, so no commit here can settle it. Needs `math-historian` or a read of these threads. |
| 13d | done, unclosed | `queue-theory` | owner hibernating | The build queue design, with the real case | `57e0616b4` on main — gives the build queue its second slot. |
| 14d | unestablished | `drain-probe` | owner hibernating | Mint probe after the outbox discard | Lead: `244732040` (08-20) "Bound daemon outbox receiver debt". The probe this row asks for is not asserted by any commit. |
| 14d | done, unclosed | `mint-attach` | owner hibernating | Delegate attaches tasks to the requested name, not the returned id | Same fix: `d1a7b4271` (08-18) on main attaches the task in the mint operation, so there is no returned-id/requested-name gap left to mis-attach across. |
| 14d | superseded | `pm-mint-comms` | owner hibernating | PM: mint/comms, Skip's priority 1 | Standing PM seat, owner hibernating 14d; the lane is now run by the current chief under `tlda-recovery-chief-opus`. |
| 14d | unestablished | `fleet-db-blocking` | owner hibernating | Prune the 3.82 GB of FTS nobody sweeps | `29e8474a7` put the vacuum runbook in place, but no commit prunes FTS. Per AGENTS.md `auto_vacuum` is `NONE`, so this needs the maintenance-window procedure run, not code. |
| 14d | **live** | `deploy-no-interrupt` | owner hibernating | Ship the front door — deploys stop hurting him | Partly landed — `fc7c58cc0`, `51574efd9` "Move the tailnet front door off the machine a deploy replaces". But the newest commit on the theme, `13d093cc0` (08-28), is *"Stage the cutover, and **stop documenting a front door that is not there**"*. By its own author the front door is not shipped. |
| 15d | unestablished | `he-is-not-the-monitor` | owner hibernating | Get dev running relevant tests against his live surfaces | `0271a378e`/`51f477b9f` "Share one bot-heartbeat survey, so a bot's death has a witness" are this owner's only landed work and are not the deliverable. |
| 15d | unestablished | `b2-taste` | owner hibernating | Taking this back off my queue — the next action is yours, so | **The title is a handoff/correction note, not the task.** What it transfers is only in the referenced thread or message id. Establishing it means reading that reference — the same defect as the 39 rows in §3, one at a time rather than in bulk. |
| 16d | unestablished | `history-wire-audit` | owner hibernating | Fix the missing read-file route | Lead: `cd2119ce0` (08-23) "Record that the markdown gate is shared and one branch of it is dead" — adjacent, and it *records* a dead branch rather than restoring a route. |
| 16d | done, unclosed | `mint-delegate-fix` | owner hibernating | Fix mint+delegate dropping the delegation | `d1a7b4271` (08-18) on main — "Attach a mint's task in the same operation that mints it". Postdates the row and is the deliverable. |
| 16d | done, unclosed | `mint-login-truth` | owner hibernating | Diagnose mint success-without-login and dropped delegation | Both halves landed: `4c10d8438` (08-23) "Give login the transport identity it just resolved" and `d1a7b4271` (08-18) "Attach a mint's task in the same operation that mints it". |
| 16d | done, unclosed | `claude-fleet-reliability` | owner hibernating | Urgent, live right now: Skip and other agents' mint attempts | `da1d76f0a` "Fix three false-failure/false-negative reliability bugs found tonight" + `217132a11` in-flight spawn guard against concurrent duplicate mints, both on main. |

## Writing and papers — 44, 44 with evidence

| age | status | owner | owner state | task | evidence |
|---|---|---|---|---|---|
| 15h | **live** | `intro-polish-process-advocate` | never picked up | Keep intro-polish on requested artifact | **Deliberately blocked on one bare question to Skip** — the referent of "second bullet" in his own instruction. Three agents have guessed; the advocate is holding rather than mutating. Subscription #92757 live. This is the one row in this bucket that genuinely needs him. |
| 2d | **live** | `intro-polish` | never picked up | Land remaining edits and clear advocate gate | Held now. `intro-polish-process-advocate` reports the artifact under an active gate, writer frozen, nothing accepted. |
| 9d | unestablished | `paper-safety-pm` | owner hibernating | Own paper-text integrity and the viewing bugs | This owner's `7cdc0cb90` "Make this file's shape cleanups able to delete, which they never could" was **reverted today** by `7b2d716cc`. Whichever way that row goes, it is not closed. |
| 9d | superseded | `appendix-math` | owner hibernating | Find and carry the outstanding appendix math work | Superseded by the current introduction lane: `intro-polish` (awake) with `intro-polish-process-advocate` (awake), which reported 09-01 04:52 that it holds the artifact under an active gate. That lane, not this 9-day-old cohort, is where the work is. |
| 9d | superseded | `term-sentence-writer` | owner hibernating | Write the title-term sentence | Superseded by the current introduction lane: `intro-polish` (awake) with `intro-polish-process-advocate` (awake), which reported 09-01 04:52 that it holds the artifact under an active gate. That lane, not this 9-day-old cohort, is where the work is. |
| 9d | superseded | `intro-sentence-advocate` | owner hibernating | Advocate on the term sentence | Advocacy seat for work that has moved on; owner `intro-sentence-advocate` hibernating 9d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 9d | superseded | `intro-sentence-writer` | owner hibernating | Finish one partially dictated sentence | Superseded by the current introduction lane: `intro-polish` (awake) with `intro-polish-process-advocate` (awake), which reported 09-01 04:52 that it holds the artifact under an active gate. That lane, not this 9-day-old cohort, is where the work is. |
| 9d | superseded | `intro-writer-advocate` | owner hibernating | Advocate on the intro writer | Advocacy seat for work that has moved on; owner `intro-writer-advocate` hibernating 9d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 9d | superseded | `intro-advocate-standing` | owner hibernating | Standing advocate for the introduction | Advocacy seat for work that has moved on; owner `intro-advocate-standing` hibernating 9d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 10d | superseded | `intro-writer-fresh` | owner hibernating | Fresh opus writer for the introduction | Superseded by the current introduction lane: `intro-polish` (awake) with `intro-polish-process-advocate` (awake), which reported 09-01 04:52 that it holds the artifact under an active gate. That lane, not this 9-day-old cohort, is where the work is. |
| 10d | superseded | `intro-opus-advocate` | owner hibernating | Advocate for synth-newintro-advocate on the introduction | Advocacy seat for work that has moved on; owner `intro-opus-advocate` hibernating 10d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 10d | superseded | `appendix-e-advocate-2` | owner hibernating | Advocate for appendix-synth-pushable on Appendix E | Advocacy seat for work that has moved on; owner `appendix-e-advocate-2` hibernating 10d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 10d | unestablished | `appendix-e-advocate-2` | owner hibernating | **This task is Skip's and it is now yours. | **The title is a handoff/correction note, not the task.** What it transfers is only in the referenced thread or message id. Establishing it means reading that reference — the same defect as the 39 rows in §3, one at a time rather than in bulk. |
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
| 12d | unestablished | `fixed-count-prefix-sol` | owner hibernating | Recovery trigger: resume this exact existing integration tas | Part of a mathematics cohort that all hibernated on 08-19/08-20. **Not establishable from this repository** — the work lives in paper checkouts, not in tlda, so no commit here can settle it. Needs `math-historian` or a read of these threads. |
| 12d | unestablished | `fixed-count-prefix-sol` | owner hibernating | Prove centered multiplier transfer | Part of a mathematics cohort that all hibernated on 08-19/08-20. **Not establishable from this repository** — the work lives in paper checkouts, not in tlda, so no commit here can settle it. Needs `math-historian` or a read of these threads. |
| 12d | unestablished | `fixed-count-prefix-sol` | owner hibernating | Prove fixed-count Gram transfer | Part of a mathematics cohort that all hibernated on 08-19/08-20. **Not establishable from this repository** — the work lives in paper checkouts, not in tlda, so no commit here can settle it. Needs `math-historian` or a read of these threads. |
| 12d | unestablished | `fixed-count-prefix-sol` | owner hibernating | Prove fixed-count small-ball transfer | Part of a mathematics cohort that all hibernated on 08-19/08-20. **Not establishable from this repository** — the work lives in paper checkouts, not in tlda, so no commit here can settle it. Needs `math-historian` or a read of these threads. |
| 12d | unestablished | `fixed-count-prefix-sol` | owner hibernating | Repair optimizer block-mass rate | Part of a mathematics cohort that all hibernated on 08-19/08-20. **Not establishable from this repository** — the work lives in paper checkouts, not in tlda, so no commit here can settle it. Needs `math-historian` or a read of these threads. |
| 12d | unestablished | `fixed-count-prefix-sol` | owner hibernating | Audit slow-diagonal absorption | Part of a mathematics cohort that all hibernated on 08-19/08-20. **Not establishable from this repository** — the work lives in paper checkouts, not in tlda, so no commit here can settle it. Needs `math-historian` or a read of these threads. |
| 13d | unestablished | `fixed-count-review-sol` | owner hibernating | Extract readable fixed-count proof outline | Part of a mathematics cohort that all hibernated on 08-19/08-20. **Not establishable from this repository** — the work lives in paper checkouts, not in tlda, so no commit here can settle it. Needs `math-historian` or a read of these threads. |
| 13d | unestablished | `fixed-count-review-sol` | owner hibernating | Re-review corrected fixed-count consumer | Part of a mathematics cohort that all hibernated on 08-19/08-20. **Not establishable from this repository** — the work lives in paper checkouts, not in tlda, so no commit here can settle it. Needs `math-historian` or a read of these threads. |
| 13d | unestablished | `asymptotic-rate-sol` | owner hibernating | Write realized-count proof repair | Part of a mathematics cohort that all hibernated on 08-19/08-20. **Not establishable from this repository** — the work lives in paper checkouts, not in tlda, so no commit here can settle it. Needs `math-historian` or a read of these threads. |
| 13d | unestablished | `asymptotic-rate-sol` | owner hibernating | Discharge diagonal repair gate | Part of a mathematics cohort that all hibernated on 08-19/08-20. **Not establishable from this repository** — the work lives in paper checkouts, not in tlda, so no commit here can settle it. Needs `math-historian` or a read of these threads. |
| 13d | unestablished | `perm-transfer` | owner hibernating | Can cor:vanishing-share carry a rate | Part of a mathematics cohort that all hibernated on 08-19/08-20. **Not establishable from this repository** — the work lives in paper checkouts, not in tlda, so no commit here can settle it. Needs `math-historian` or a read of these threads. |
| 13d | unestablished | `e2-specialist` | owner hibernating | Read appendix E2 and be ready to help | Part of a mathematics cohort that all hibernated on 08-19/08-20. **Not establishable from this repository** — the work lives in paper checkouts, not in tlda, so no commit here can settle it. Needs `math-historian` or a read of these threads. |
| 15d | superseded | `duality-fml2765` | owner hibernating | WITHDRAWN BY SKIP 2026-08-18 ~01:25 EDT. | The row's own text: **withdrawn by Skip, 2026-08-18 ~01:25 EDT.** |
| 15d | **live** | `duality-fml2765` | owner hibernating | Parked: garbage in the B.3 setting | Explicitly **parked**, not abandoned. Owner hibernating 14d; parking was a decision, resuming is one too. |
| 15d | **live** | `duality-fml2765` | owner hibernating | Parked: B.2's a.e. handling, deal properly | Explicitly **parked**, not abandoned. Owner hibernating 14d. |
| 15d | superseded | `eiv-advocate` | owner hibernating | Advocate for eiv-paper work | Advocacy seat for work that has moved on; owner `eiv-advocate` hibernating 15d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 16d | unestablished | `interviewer-c` | owner hibernating | Interview transcript lines 1201-1774 | Part of a mathematics cohort that all hibernated on 08-19/08-20. **Not establishable from this repository** — the work lives in paper checkouts, not in tlda, so no commit here can settle it. Needs `math-historian` or a read of these threads. |
| 16d | unestablished | `interviewer-b` | owner hibernating | Interview transcript lines 601-1200 | Part of a mathematics cohort that all hibernated on 08-19/08-20. **Not establishable from this repository** — the work lives in paper checkouts, not in tlda, so no commit here can settle it. Needs `math-historian` or a read of these threads. |
| 16d | unestablished | `synth-audit` | owner hibernating | Meant-vs-actual audit of tonight's paper edits | Part of a mathematics cohort that all hibernated on 08-19/08-20. **Not establishable from this repository** — the work lives in paper checkouts, not in tlda, so no commit here can settle it. Needs `math-historian` or a read of these threads. |

## Fleet process, ownership, audits — 50, 50 with evidence

| age | status | owner | owner state | task | evidence |
|---|---|---|---|---|---|
| 5h | **live** | `chief-advocate-fresh` | never picked up | Fresh advocate checking the chief | Owner `chief-advocate-fresh` is awake and holds this advocacy now. |
| 5h | **live** | `tlda-recovery-chief-opus` | never picked up | **Interval moved from 5 minutes to 30 while Skip is teaching | Owner `tlda-recovery-chief-opus` is awake and this was notified 5h ago — in hand now. |
| 5h | **live** | `tlda-recovery-chief-opus` | — | ## How I work — Skip, 09-01 13:0x EDT > YOU DO NOT HAVE THE | Owner `tlda-recovery-chief-opus` is awake and this was notified 5h ago — in hand now. |
| 5h | **live** | `tlda-recovery-chief-opus` | never picked up | **Carried list as of 15:57, and the interval goes 15m → 30m | Owner `tlda-recovery-chief-opus` is awake and this was notified 5h ago — in hand now. |
| 7h | **live** | `tlda-recovery-chief-opus` | never picked up | **Class is over — 17:50, his words: "im done with class dude. | Owner `tlda-recovery-chief-opus` is awake and this was notified 7h ago — in hand now. |
| 12h | **live** | `tlda-recovery-chief-advocate-4` | never picked up | Advocate tlda recovery chief | Owner `tlda-recovery-chief-advocate-4` is awake and holds this advocacy now. |
| 16h | **live** | `app-chief` | — | Index standing subscription queries | Blocked, 16h old, owner `app-chief` active. Note `35143d4e7` *deleted* "an index nobody queries" — worth reconciling against this before building one. |
| 16h | **live** | `tlda-recovery-chief-sol` | never picked up | Verify classroom and extension behavior | **Subject recovered** from the delegate line at 09-01 04:52 EDT — `classroom-ui-sol` → `tlda-recovery-chief-sol`, whose transfer note overwrote all five titles. All five were held on one measured blocker: **both cache-busted live HW−1 ZIP routes still served the old SHA-256 `4cb4a219…`**, with `shared-code.qmd` outside the `.support/` directory. A corrected ZIP `d1065039…` was built at 05:18 and `pic-release-opus` was told at 05:20 to publish it to both routes — **so check that landed before re-running any of these.** |
| 16h | unestablished | `bhief-of-getting-shit-done:Mendel` | owner hibernating | Next action is your independent PASS/BLOCK on exact held com | **The title is a handoff/correction note, not the task.** What it transfers is only in the referenced thread or message id. Establishing it means reading that reference — the same defect as the 39 rows in §3, one at a time rather than in bulk. |
| 17h | **live** | `app-chief` | — | Implement corrected handoff enforcement | Owner `app-chief` is awake and this was notified 17h ago — in hand now. |
| 21h | **live** | `tlda-recovery-chief-sol` | never picked up | Repair classroom microphone and icon | **Subject recovered** from the delegate line at 09-01 04:52 EDT — `classroom-ui-sol` → `tlda-recovery-chief-sol`, whose transfer note overwrote all five titles. All five were held on one measured blocker: **both cache-busted live HW−1 ZIP routes still served the old SHA-256 `4cb4a219…`**, with `shared-code.qmd` outside the `.support/` directory. A corrected ZIP `d1065039…` was built at 05:18 and `pic-release-opus` was told at 05:20 to publish it to both routes — **so check that landed before re-running any of these.** |
| 1d | **live** | `tlda-recovery-chief-sol` | never picked up | Carry this legacy layers record within the classroom lane | **Subject recovered** from the delegate line at 09-01 04:52 EDT — `classroom-ui-sol` → `tlda-recovery-chief-sol`, whose transfer note overwrote all five titles. All five were held on one measured blocker: **both cache-busted live HW−1 ZIP routes still served the old SHA-256 `4cb4a219…`**, with `shared-code.qmd` outside the `.support/` directory. A corrected ZIP `d1065039…` was built at 05:18 and `pic-release-opus` was told at 05:20 to publish it to both routes — **so check that landed before re-running any of these.** |
| 1d | **live** | `tlda-recovery-chief-sol` | never picked up | Carry this legacy visual-mode record in the exact-0.2.7 Positron chain | **Subject recovered** from the delegate line at 09-01 04:52 EDT — `classroom-ui-sol` → `tlda-recovery-chief-sol`, whose transfer note overwrote all five titles. All five were held on one measured blocker: **both cache-busted live HW−1 ZIP routes still served the old SHA-256 `4cb4a219…`**, with `shared-code.qmd` outside the `.support/` directory. A corrected ZIP `d1065039…` was built at 05:18 and `pic-release-opus` was told at 05:20 to publish it to both routes — **so check that landed before re-running any of these.** |
| 1d | **live** | `tlda-recovery-chief-sol` | never picked up | Carry this legacy Positron integration record in the fresh disposable 0.2.7 chain | **Subject recovered** from the delegate line at 09-01 04:52 EDT — `classroom-ui-sol` → `tlda-recovery-chief-sol`, whose transfer note overwrote all five titles. All five were held on one measured blocker: **both cache-busted live HW−1 ZIP routes still served the old SHA-256 `4cb4a219…`**, with `shared-code.qmd` outside the `.support/` directory. A corrected ZIP `d1065039…` was built at 05:18 and `pic-release-opus` was told at 05:20 to publish it to both routes — **so check that landed before re-running any of these.** |
| 2d | done, unclosed | `sol-dev` | never picked up | Integrated PIC-dev stage is complete and production is uncha | The row's own text: the integrated stage is complete and production unchanged. |
| 5d | unestablished | `existing-project-link` | owner hibernating | Fix existing-project link hang | Lead: `2e9ef9e91` on main, "Re-ask for the confirmation, do not rebuild the history that was already sent" — same area, but it does not say the hang is gone. |
| 6d | **live** | `sol-dev` | never picked up | Decide: 13GB unreproducible, remaining conditions need your call | **A decision row sitting with `sol-dev`, who is awake and on-call, for 6 days.** By its own title the next action is a call somebody has to make. |
| 7d | unestablished | `sol-dev` | never picked up | **Transferring because the next action is yours. | **The title is a handoff/correction note, not the task.** What it transfers is only in the referenced thread or message id. Establishing it means reading that reference — the same defect as the 39 rows in §3, one at a time rather than in bulk. |
| 9d | superseded | `sol-advocate` | owner hibernating | Watch chief work against Skip's ask | Advocacy seat for work that has moved on; owner `sol-advocate` hibernating 9d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 9d | superseded | `reliability-pm` | owner hibernating | Own whether the app works for Skip day to day | A standing ownership seat, owner hibernating 9d. That job is the chief's now, and `reliability-pm`'s 183 commits on main stop at 08-29. |
| 10d | done, unclosed | `model-default-probe` | owner hibernating | Verify the resolved model default | `4fac22085` (08-17) records the resolved model on a seat, `8687158d6` backfills the agents minted before it. The probe this row asks for is satisfied by the backfill existing. |
| 10d | superseded | `advocate-3-2` | owner hibernating | Advocate for chief-advocate-2 | Advocacy seat for work that has moved on; owner `advocate-3-2` hibernating 10d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 10d | superseded | `chief-opus-2` | owner hibernating | Take the chief of staff seat | Advocacy seat for work that has moved on; owner `chief-opus-2` hibernating 10d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 11d | superseded | `chief-advocate` | owner hibernating | Advocate for chief-opus | Advocacy seat for work that has moved on; owner `chief-advocate` hibernating 11d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 11d | superseded | `chief-opus-2` | owner hibernating | **Stood down from this seat by Skip, 2026-08-22 ~18:44 EDT** | The row's own text is the evidence: **Skip stood this seat down, 2026-08-22 ~18:44 EDT.** Four chiefs have held it since. |
| 11d | unestablished | `bhief-sol` | owner hibernating | Corrected candidate returned — transferring, since by your o | **The title is a handoff/correction note, not the task.** What it transfers is only in the referenced thread or message id. Establishing it means reading that reference — the same defect as the 39 rows in §3, one at a time rather than in bulk. |
| 11d | unestablished | `bhief-sol` | owner hibernating | Candidate ready for integrated current-main and advocate rev | **The title is a handoff/correction note, not the task.** What it transfers is only in the referenced thread or message id. Establishing it means reading that reference — the same defect as the 39 rows in §3, one at a time rather than in bulk. |
| 12d | unestablished | `bhief-sol` | owner hibernating | Take ownership and implement the task as assigned by the cur | **The title is a handoff/correction note, not the task.** What it transfers is only in the referenced thread or message id. Establishing it means reading that reference — the same defect as the 39 rows in §3, one at a time rather than in bulk. |
| 12d | done, unclosed | `chief-sol` | owner hibernating | Primitive-condition repair is complete and reported in messa | The row's own text: repair complete and reported. The cited message is the evidence to check if closing. |
| 12d | unestablished | `bhief-sol` | owner hibernating | Recovered canonical record and created `/Users/skip/worktree | **The title is a handoff/correction note, not the task.** What it transfers is only in the referenced thread or message id. Establishing it means reading that reference — the same defect as the 39 rows in §3, one at a time rather than in bulk. |
| 12d | superseded | `app-librarian` | owner hibernating | Retry retained document failures each sweep | The premise was retracted: `e7685664d` (09-01) **"CORRECTION: the detached SVG is collectable, not retained"**, reversing `bc1e20951`. There is no retained-document failure to retry. |
| 13d | done, unclosed | `lexical-me-owner` | owner hibernating | Canonical ownership transfer. | Title is a transfer note; the work is lexical `me`, landed as `cdada954c` "Fix lexical me in thread cards" on main. Matches the standing ruling in AGENTS.md §"`me` IS LEXICALLY SCOPED". |
| 13d | superseded | `appchief-sol-successor-3` | owner hibernating | Manage tlda app priorities | `app-chief` holds this (awake, 95 commits on main, most recent today). |
| 13d | superseded | `sol-lead` | owner hibernating | Manage tlda app priorities | `app-chief` holds this (awake, 95 commits on main, most recent today). |
| 14d | superseded | `chief-night` | owner hibernating | Take the chief of staff seat | Advocacy seat for work that has moved on; owner `chief-night` hibernating 14d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 14d | superseded | `advocate-chief-night` | owner hibernating | Advocate watching chief-night tonight | Advocacy seat for work that has moved on; owner `advocate-chief-night` hibernating 14d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 14d | unestablished | `audit-s6` | owner hibernating | Audit slice S6: Aug 13 commits | One slice of the August keep/cut audit. `c1e83aa62` preserved that audit's output before scratch/ was swept; whether S6 was ever run is not established. |
| 14d | superseded | `pm-audit` | owner hibernating | PM: the August keep/cut audit | Standing PM seat, owner hibernating 14d; the lane is now run by the current chief under `tlda-recovery-chief-opus`. |
| 14d | unestablished | `audit-two-weeks` | owner hibernating | Audit the two-week window under the last two chiefs | Same audit family. The window it names is now three weeks past and two further chiefs have held the seat. |
| 14d | unestablished | `chief-night-handed-off` | owner hibernating | **Item 8, final piece of the design, from Skip. | **The title is a handoff/correction note, not the task.** What it transfers is only in the referenced thread or message id. Establishing it means reading that reference — the same defect as the 39 rows in §3, one at a time rather than in bulk. |
| 15d | superseded | `chief-aug18` | owner hibernating | **This is the seat's recurring obligation and the seat is yo | A seat's recurring obligation; `chief-aug18` hibernating 15d. The obligation travels with the seat, which the current chief holds. |
| 15d | unestablished | `solved-non-problems` | — | # handback **Handing this back because every remaining acti | **The title is a handoff/correction note, not the task.** What it transfers is only in the referenced thread or message id. Establishing it means reading that reference — the same defect as the 39 rows in §3, one at a time rather than in bulk. |
| 15d | unestablished | `solved-non-problems` | owner hibernating | Transferring per your ruling — nothing on this list is mine | **The title is a handoff/correction note, not the task.** What it transfers is only in the referenced thread or message id. Establishing it means reading that reference — the same defect as the 39 rows in §3, one at a time rather than in bulk. |
| 15d | superseded | `tlda-autopsy-fml` | owner hibernating | Chief-of-staff live coordination checkpoint | A chief-of-staff checkpoint whose owner is hibernating with the task still marked `working`, stale 371h. The seat is held by `tlda-recovery-chief-opus`. |
| 16d | done, unclosed | `history-wire-audit` | owner hibernating | Give task transitions a record | `b18d29862` on main — "Record the task transitions that left no trace". |
| 16d | unestablished | `history-fold-audit` | owner hibernating | Audit history table folds | Lead: `b5e6ce08a` "Document the identity and labeling system" — but that is 07-31, **two weeks before this row**, so it is the thing being audited, not the audit. |
| 16d | superseded | `bhief-advocate` | owner hibernating | Advocate for the chief-of-staff seat | Advocacy seat for work that has moved on; owner `bhief-advocate` hibernating 16d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 16d | unestablished | `bregman-architect` | owner hibernating | URGENT, live, blocking Skip right now — he cannot view his B | The defect *class* has landed fixes on main — `a9074bc8e` "Scope external-sync deletions to what the remote itself introduced" and `f08b95238` "Resolve a closure member that points through a committed symlink". **Whether this row is closed is a statement about one of his own documents, which is not mine to make or to check.** Him or the chief. |
| 17d | superseded | `claude-chief-advocate` | owner hibernating | You are the independent Claude advocate for the tlda chief-o | Advocacy seat for work that has moved on; owner `claude-chief-advocate` hibernating 17d. Current advocacy is `tlda-recovery-chief-advocate-4` / `chief-advocate-fresh`, both awake. |
| 41d | unestablished | `pin` | owner hibernating | Integrate approved freshness resilience manifest | **The oldest open row in the fleet at 41 days**, blocked on `fleet:d8fa-mrwq97vb`, owner `pin` hibernating. Nothing on main carries the subject. |

---

## Totals

| mark | rows |
|---|---|
| **live** | 52 |
| done, unclosed | 34 |
| superseded | 53 |
| unestablished | 106 |
| **all** | 245 |
