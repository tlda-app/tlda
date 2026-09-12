# Carry-forward from `chief-night`, 2026-08-18 evening {#carry}

**Re-check every row of this against the machine before acting on it.** A disposition frozen
at the moment someone wrote it is history, not state, and this repo has twice paid hours for
that. Times are EDT.

## Open, and mine rather than a PM's

**1. Six ack fixes exist only in a daemon's clone and are not on `main`.** The daemon runs
`~/worktrees/daemon-testing`, a **separate clone** (not a worktree) on branch `deploy7` at
`fb985dd4`. It has **29 commits `main` does not have**, including *"Stop one un-ackable
envelope from stopping every other envelope"*, *"Export the ack gate and stop refusing an ack
in silence"*, *"Reproduce the acked row that never leaves the outbox"*. Disposition
established: **never picked, not reverted.**

**Do not "bring the daemon up to date" by moving that clone to `main` — it is a 29-commit
revert of ack work on the live daemon.** Deliver anything to that clone by cherry-pick onto
its own branch. Checked by message with a positive control, because `main` is cherry-picked
and ancestry lies.

**What is undone:** deciding whether those 29 should land on `main`. That is a release-path
decision, it needs someone awake who knows what they do, and it was deliberately not done at
midnight.

**2. `pm-mint-comms`'s daemon flush fix is written, tested and unlanded** — branch
`daemon-flush-claim`, worktree `~/worktrees/daemon-flush-claim`. Byte-bounded claim step;
counterfactual run (reverting one line turns exactly two guard tests red). **Delivery is held
on purpose:** the queue currently drains, so measuring a rate change against it proves
nothing. It is a correct efficiency fix and **it is not the throughput answer** — do not let
it be reported as the thing that fixed minting.

**3. Debris I made and did not clean.** Probe agents `mint-probe-clear`,
`mint-probe-recheck`; husk rows `wire-ack`, `activity-outbox`, `advocate-for-skip` (three
CLI mints that returned `ABANDONED` with live local processes and no seat). **I left them
running deliberately** — killing the process leaves a row with no process, which is the husk
shape Skip has spent the day angry about. They want a real retirement path, not an improvised
kill.

## State of the two workstreams

**The strip (`pm-sync`, has the whole fleet).** Skip's ruling: *"sync is the new design / stip
the old design the fuck out NOPW"*, and *"this is all anyone will do until there is no sync
code to fix"*. Both blocking gates closed. Scratch cut landed. JSON carrier, callable accept,
working copy + manifest, journal, blob upload all landed on `accept-path-daemon-push`. The
**deletion commit has not landed** and must not while any guarantee it would drop is missing
from the new path.

**Standing gate I hold: any change whose effect is to make the old sync path behave gets
rejected, including a good one, including mine.**

**Mint/comms (`pm-mint-comms`).** Minting **works** as of 17:00, verified twice with no
intervention. The queue pins when `source-change` rows hit the ack gate; the strip removes
the path that makes them. If minting stalls, clearing the outbox takes ninety seconds and
Skip has authorised it — *"absolutely nothing in the outbox needs to be retained"*.

**Layout for the 1pm meeting (`pm-audit`).** Hard deadline **before noon 2026-08-19**. Spec is
`scratch/skip-asks-2026-08-18-evening.md#layout-13-inch`, his words.

## What actually made tonight work, and it is not the fixes

**Every serious error was caught by the agent that made it, within minutes, before it
travelled.** Four framings of the ack problem, each retracted by its author. Three claimed
greens that turned out not to exist. Two of my own instructions — a withdrawn hazard I
re-issued with my authority, and a route I described from its comment without reading its
body — corrected by PMs who checked rather than executed.

**Two data-loss defects were found in code that *survives* the cut**, neither in the strip's
scope, neither findable by reviewing the deletion: an accept that recorded a revision and
never wrote the file to disk, and a bootstrap whose ref moved before its record was written,
leaving a project reading uninitialised over a real commit so the next push overwrote its
history. **Both were found by test agents refusing an easy green** — one would not read from a
different surface to make a red test pass, the other would not wrap a known defect to get
past it.

**So the standard to keep is not a process. It is: check your own claim before relaying it,
run the positive control, and say the correction faster than you said the claim.**
