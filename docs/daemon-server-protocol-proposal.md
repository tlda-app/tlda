# The daemon–server protocol: what it should be {#proposal}

**This is a proposal, not a description.** What the protocol currently *is* — including six
states where one end can do something the other has no answer for — is
[the protocol document](daemon-server-protocol.md). This is the argument for changing its
shape, written to be said no to.

Skip, 2026-08-18, on being shown a fix for one message type at a time:

> you guys are trying to coalesce atuff thay necer shluldve been split in the first place

> stop taking such a like, low level look at how to fix things

> write up the protocol and ask

## The one sentence

**The daemon splits facts it holds whole into thousands of per-entity messages, and then
treats every one of them as though losing it would matter.** Both halves are wrong, and
they are wrong together: the splitting creates the volume, and the durability makes the
volume expensive.

## What that costs, measured 2026-08-18

| | |
|---|---|
| route publications in 5h40m | **8,532** (~36,000/day) |
| what Skip says it should be | **~200/day, one per mint** |
| re-offers of those in the same window | **237,158** |
| queue at one point | **60,970 rows**, ~47,000 of them telemetry |
| agents actually alive | ~30 |

The mechanism for the routes: **every daemon start republishes one message per known agent.**
355 of them inside 375 milliseconds, one per agent, no duplicates. There are ~2,500 agents in
the ledger.

## Why splitting is the error, not the volume

A daemon knows its agent set **as one fact**. Splitting it into N messages does three things,
all bad:

1. **It multiplies cost by N** — N disk writes, N delivery slots, N acks, N retries.
2. **It destroys the information that matters.** A per-agent message can only *add*: "this
   agent is here." It cannot say **"and nobody else is."** So the server's picture can gain
   entries and never lose them, and nothing in the protocol can correct it. That is why
   stale routes exist at all.
3. **It makes a restart look like news.** Re-announcing an unchanged fact 2,500 times is the
   protocol having no way to say "nothing has changed."

**Coalescing these back into one message is treating the symptom.** The design error is that
they were ever separate.

## Why uniform durability is the other half

Every message on this wire gets the same contract: persisted to SQLite, offered, acked,
retried until it lands. **That is correct for a route and absurd for a heartbeat.**

- **A route publication** is a durable fact. Losing it makes an agent unreachable — that is
  what a husk is.
- **An `activity-health` beat** is a claim about a moment. One that arrives four minutes late
  is worthless, and it currently occupies a disk write, a delivery slot and a retry budget
  exactly as if it were a source edit. There were **26,744** of them queued.

**So the protocol has one tier where it needs at least two**, and the cheap tier is most of
the traffic.

## The shape being proposed

**State, not events, for anything the daemon holds whole.**

- The daemon says **"here is my current state"** — its identity, and its full agent set — as
  one message, on start and on change.
- The server **replaces** its picture of that daemon rather than merging into it. Replacement
  is what makes stale entries disappear; a merge cannot.
- **Deltas afterwards** for individual changes: one mint, one delta. Skip's ~200/day, which
  he has said is unproblematic.

This is the ordinary reconciliation pattern — the receiver converges on the sender's declared
state rather than replaying its history — and it is **idempotent by construction**, which is
the property he asked us to design for: *"the key to having ok behavior is a messy
environment."* Re-sending the state is free. Missing one is self-correcting. A crash mid-way
costs a resend rather than a permanently wrong picture.

**And two tiers of delivery:**

- **durable** — must arrive, retried, acked: routes, RPC replies, source changes.
- **disposable** — latest-wins, not persisted, not retried, dropped under pressure:
  health, status, thinking, context.

## What is his to decide

1. **Is state-replacement right for the agent set**, or is there a reason the server must
   never be told "these and no others"?
2. **Which types are disposable?** The proposal says health, status, thinking, context. That
   list is a product judgement about what is worth surviving a crash, not a technical one.
3. **Should a disposable message be dropped under pressure, or just not retried?** Dropping
   is cheaper and means his activity cards can skip rather than queue.
4. **What does "I cannot tell you" look like?** This is the gap under every failure tonight —
   a mint reporting success with no process, an ack refused with no error recorded, a grep
   returning zero from the wrong branch. **Nothing in the contract says what a surface should
   say when it does not know.** Every one of them said "fine."

## What is not being proposed

- **No new subsystem.** This deletes message volume and one delivery tier; it does not add a
  journal, a registry or a control plane.
- **No batching.** Batching would make the split cheaper to deliver. The point is not to
  split.
- **No compression.** The messages are 502 bytes.
