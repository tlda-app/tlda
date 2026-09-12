# Backlog triage — working file

Owner: `backlog-triage` fleet:4955eae2. Task fleet:4955-mtj7rgmf from
`tlda-recovery-chief-opus` fleet:3535c3ce.

**Buckets:** live · done-but-unclosed · superseded · unestablished.
**Constraint:** nothing gets deleted. Mark and report only.

---

## Finding 1 — the 197-row list is one page. 245 tasks are open.

`tasks({limit:200})` reports **245 open**, returns 200, and hands back a cursor.
`scratch/open-tasks-by-topic.md` totals 197 (8+13+19+15+13+18+29+39+43) and
contains **none** of the page-2 tail. Checked by grep against that file:

| probe | hits in open-tasks-by-topic.md |
|---|---|
| `Parking stale` | 0 |
| `Review Part` | 0 |
| `Bootstrap managed` | 0 |
| `Zach` | 0 |

So 48 open tasks were never triaged, and "nothing dropped" does not hold.

**Skip owns 15, not 8.** 6 on page 1, 9 on page 2. The seven not on the chief's
list: Review Part 1 course sequence; Review Part 2 course sequence; Review
enrichment breather; Bootstrap managed testing daemon; Supply Zach estimator
specification (`every:900s`); Drop-test complete — no task work was performed;
Check chat transition resistance after revert (blocked).

## Finding 2 — 34 of the missing 48 are a parked bucket owned by `nobody`

`nobody` fleet:9307b38c holds ~34 open tasks in two batches. `tasks()` truncates
every one of their titles to the *parking note*, so the list reads as 34 copies
of "Parking stale backlog task during fleet cleanup" and the actual subjects are
invisible. `thread(task_id: fleet:35ad-msb52r3a)` returns the delegation lines
and exposes them.

**Batch A — `fall-class` fleet:ce8b5239, 2026-08-13 15:22 EDT, "Transferred from
an Opus agent to the nobody bot at Skip's request":**

1. Triage the 26 stale fleet tasks
2. A bounded search refuses results it holds
3. Independent check on the chief, per Skip's ask
4. Hold Enter until the voice transcript finalizes
5. Fix and run worktree cleanup safely
6. Own sync as a domain, working directly with Skip
7. Advocate seat for app recovery
8. Build document place-stack navigation
9. Runaway/echoing voice on testing

**Batch B — `claude-chief` fleet:18367b21, 2026-08-16 17:51–17:52 EDT, "Parking
stale backlog task during fleet cleanup — owner hibernating, no live progress":**

1. Gate late-alpha release preparation
2. Gate stray upload refusal
3. Gate docs and Overleaf onboarding
4. Gate short image references
5. Take this preserved independent layout/obligation gate after…
6. The task's bounded capture and generic delayed-touch diagnos…
7. The fresh manager handoff was received and executed.
8. Carry accepted WM outputs forward
9. Gate shared highlighter repair
10. Transferred because your hold `2830652`, relayed in wm-follo…
11. Watch post-revert chat telemetry
12. Work with Skip on the tlda README
13. Task expiry notifications and timer path
14. Interleaved two-writer editing session test
15. Restore lifecycle authority and Reanimate
16. Fix invisible math-agent messages
17. Split metadata.source into via and source
18. Build the gesture classifier in the tldraw fork
19. CLI command for an agent to restart its own MCP
20. Stop tlda daemon stop from unloading the launchd job
21. Delete wiretaps
22. Build gesture transitions in the tldraw fork
23. Recover and build the index page columns
24. Make composer slider salient on touch
25. Rebuild index page to Skip's spec

**Why this matters and is not just bookkeeping.** Batch B was parked by an agent
on the stated ground "owner hibernating, no live progress" — a fact about the
*owner*, not about whether Skip still wants the thing. Several rows are product
work in his own words: *Rebuild index page to Skip's spec*, *Make composer slider
salient on touch*, *Work with Skip on the tlda README*, *Hold Enter until the
voice transcript finalizes*, *Build document place-stack navigation*. Each needs
its own disposition; none can inherit one from the parking note.

Batch A is different: `fall-class` says the transfer was "at Skip's request",
which is a citation to check before treating it the same way.

---

## Method note — `thread(task_id:)` is not task-scoped for a multi-task owner

The call above returned 126 messages spanning that agent's whole life, including
every unrelated delegation and ~90 `nobody logged in` lines. Useful once, per
owner; useless as a per-row instrument. Per-row evidence comes from the owner
thread read once, not from one call per task.
