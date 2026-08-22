# The instrument, or the code

**A measurement that comes back empty, slow, or failed is a claim about two
things at once — the subject, and the thing doing the measuring.** Most of the
time the instrument is fine and the reading is about the subject. When it is
not, the reading still looks exactly like a finding, and it is usually a
*serious* finding: an outage, a hang, a regression, a feature that was never
built.

**Nine of these happened in one night — 2026-08-18 into 2026-08-19 — across at
least three agents.** Every one reported a defect in a path that was working.
Two were minutes from being relayed to Skip. This page is the shapes they take
and the checks that separate them, written down because the cost is not the
wasted hour: it is that a false finding sends somebody to *fix* a working path.

**This is the same disease as [Naming errata](naming-errata.md) one level up.**
There, a name lies about what code does. Here, a measurement lies about what the
system did — and unlike a name, it lies in a form that looks like evidence.

## The shapes

### 1. A bound set against a quiet box

**A timeout is a claim about how long something should take, and it was written
on a machine that was not this machine.** Under load it fires, and it does not
report *"my patience ran out"* — it reports whatever the caller says when it
gives up, which is almost always the language of a defect.

| measured | bound | actual | would have been reported as |
|---|---|---|---|
| `a-source-change-that-proposes-instead-of-pushing` | 10s | 7.3–8.8s, five runs, load avg 52 | *the daemon's proposal path does not reach the server* |
| the "~50% hang" in the build path (`pm-sync`) | 10s | 8–9s; at a 60s bound, **0 of 6** timed out | *the accept hangs half the time* — a fleet-wide stop-the-line |

**The tell is a pass rate that moves with the box rather than with the code.**
Green alone and red in a sequential suite is not flakiness to be re-run; it is a
bound with no headroom.

**The check:** time five green runs and compare the spread to the bound. If the
slowest is within ~2× of it, the instrument is measuring the machine. Widen the
bound; never touch the assertion.

### 2. A true number about the wrong subject

**The measurement is correct and it is about something else.** This is the most
convincing of the four, because nothing about the number looks wrong.

- **2026-08-18** — the gate for restoring a bot to supervision was *"`ps eww` shows
  four `TLDA_DEV_BOT_*` matches, not zero"*. It read as **met** the whole time.
  The four matches were on a **hand-launched** process with `PPID 1`, started
  before any supervised attempt. The measurement was accurate and it was about
  the workaround.
- **the same night** — both bots reported up to Skip on the strength of `.log`
  files last written in July. A file that exists and parses is not a file that is
  current. (See [Naming errata](naming-errata.md) §`~/.config/tlda/<bot>.<env>.log`,
  which is a different lie about the same files.)

**The check:** before reading a process's environment, establish *which process*.
A workaround usually runs alongside the thing being fixed and will happily answer
the question you meant to ask about the other one. Discriminate by parentage or
start time — a supervised process is a fresh pid whose parent is the supervisor,
not `init`. For a file, read its mtime before its contents.

### 3. A zero from a query that cannot return anything else

**An empty result from a broken query and an empty result from an empty world are
the same characters.** Neither errors. Both answer.

- **2026-08-18** — a search for an agent's recent session rows returned nothing,
  and the conclusion nearly drawn was *the session ingester has stopped fleet-wide*.
  One query without the role filter returned rows immediately: the filter meant
  something other than assumed and nothing was stalled.
- **2026-08-19** — a spawn-count probe monkeypatched `child_process.spawn` and
  measured **0 spawns**, which would have meant the blob writes were already
  batched. Named imports bind at module load, so the patch could not have been
  observed. The real count was one per file.

- **2026-08-22** — a raw `login` sent over `/ws/fleet` to prove the server was
  hanging got **no reply in 25 seconds**, while the socket streamed broadcasts
  the whole time. That reads as *the server accepts logins and never answers
  them*, which was about to be reported. The correlation field is `id`; the
  probe used `request_id`. Re-sent with `id`, the same server answered the same
  login in **322ms**. The field is set in `_sendWSOnce` — find it there rather
  than guessing, and note that a request with an unknown correlation key is not
  rejected, it is simply never matched, so the socket stays healthy and silent.

**The check — a positive control, and it is one command.** Run the same query
against something you *know* is there. If that also comes back empty, the
instrument is broken rather than the world.

### 4. A control that could not have failed

**Shape 3's own remedy has this failure mode, which is why it gets its own
entry.** A control only controls if it would have produced a different answer.

- **2026-08-19** — a doc was checked for a figure by grepping for `1492` as the
  positive control. It returned 0. The number was in a *commit message*, not the
  document — the control had been chosen from memory of writing it, so its
  absence proved nothing about the instrument.
- **2026-08-19** — `git merge-tree --write-tree <branch> <its own ancestor>`
  returned exit 0 and was nearly reported as *"the branches merge clean"*.
  Merging an ancestor **cannot** conflict. Rebuilt as two branches editing the
  same line, the command returned exit 1 — only then did the exit 0 on the real
  pair mean anything.

**The check:** state what the control would look like if it *failed*, before
running it. If you cannot, it is not a control.

### 5. A failure after the verdict was already in

**The subject passed and the harness failed anyway**, and what the runner reports
is the harness.

- **2026-08-19** — `a-fanout-that-carries-the-words` exited non-zero on
  `ENOTEMPTY`. **Every assertion had already passed**; post-accept effects were
  still writing into the temp directory while `rmSync` walked it. In a suite it
  reads as *the fan-out corrupts state* — a data-loss finding, in the one path
  where data loss is the thing being guarded.

**The tell is that the error is in the vocabulary of the harness — a filesystem
errno, a port in use, a cleanup — rather than of the thing under test.**

**The check:** read *which* assertion failed before believing the exit code. If
none did, the finding is about teardown and belongs nowhere near the subject.

### 6. A true number that cannot see the thing you are asking about

**`%CPU` cannot detect a blocked event loop, because the most common way to block
one costs no CPU at all.**

- **2026-08-22** — chasing multi-minute `login()` and `chat()` hangs, I measured
  the MCP process at **4.5 seconds of CPU across 30 minutes** and concluded it
  was not compute-bound but waiting on I/O. The measurement was correct and the
  inference was wrong. The process was blocked in `execFileSync` — **96
  synchronous `git` spawns**, each costing 0.3–2.7s of *wall* time for ~0.01s of
  CPU. The event loop was fully blocked the entire time and the process looked
  idle, because **spawn latency is not computation.**

**The tell: "not compute-bound" and "not blocked" are different claims, and only
the first one `%CPU` can support.** Anything that blocks on a syscall — a
synchronous spawn, `readFileSync` on a slow volume, a sync SQLite write — is
invisible to it and produces exactly the reading a genuinely idle process does.

**The check:** `sample <pid>` and read the stack. `notify-ship` got the answer in
one shot that way — 179 of 179 samples showing `Builtins_ArrayFilter →
SyncProcessRunner::Spawn → uv__io_poll`, which names both the blocking call *and*
the loop it sits in. `%CPU` was never going to say that, however many times it
was read.

**This is the same failure as shape 2 one level down** — a true number about the
wrong subject — with the extra trap that here the number *is* about the right
process. It answers "is it computing", and the question was "is it stuck".

## The standing check, in one line

**Before reporting an absence, a hang, or a failure, ask what this instrument
would show if the system were healthy — and confirm it can show that.**

Every one of the nine passes that question trivially in hindsight and none of
them were asked it at the time. The reason is worth naming: **an instrument
failure and a serious defect produce the same reading, and the serious defect is
more interesting.** Attention goes to the finding, not to the ruler.

## Why this is not a testing-discipline note

**Skip does not read this code and cannot arbitrate a claim about it** — see
`AGENTS.md` §"He designs. He does not read the code either". Every measurement
reaches him through an agent, so a false finding is not a wasted hour of ours; it
is a wrong belief he has no way to check except by contradicting it from his own
screen, which costs him the thing agents exist to save.

**And a false finding does not sit still.** It becomes a task, a task becomes an
agent, and the agent is sent to repair a path that works — which is how a
measurement error turns into a regression.
