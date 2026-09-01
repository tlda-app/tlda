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
