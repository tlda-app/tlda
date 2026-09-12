# The daemon–server durable message protocol

Skip, 2026-08-18 15:42 EDT, marking this **high priority**:

> it seems like we don't have protocols for these interactions
>
> the result being surprising shit happens that one end is not prepared to deal with
>
> somoene needs to write this shit down

This document is that. **It records the protocol as it actually is, and names every state
where one end can do something the other end has no defined answer for.** Where a state is
unspecified it says so rather than inventing a rule — an invented protocol written down is
worse than an admitted gap, because the next person builds on it.

## Why this exists, in one concrete failure

On 2026-08-18 a single unspecified state took the whole fleet down for a day, and every
surface reported health throughout.

A `source-change` row was delivered to the server. The server processed it and sent an ack.
**The daemon refused its own ack** — `daemon/delivery-runtime.mjs:77` returns `false` before
`outbox.ack(outboxId)` when a gate on the row fails — and **recorded nothing**. The row
stayed pending with `last_error = (none)`.

Ten hours later it was still there: **281 attempts, created 09:36:54Z, no error anywhere in
the system.** It sat at the head of a FIFO delivery window of 100, alongside 61 others in
the same state, so 62% of every flush cycle re-offered rows that could never be acked.

Behind them, **60,970 rows starved**: 10,479 `agent-route`, 10,872 `activity-event`, 1,061
`rpc-reply`. The visible consequences were that agents could not be minted (`rpc-reply`
never returns, so a seat reservation never completes), agents could not be woken
(`agent-route` never publishes), and Skip's activity cards stopped appearing. Two rows —
`terminal-chat` and `agent-compacting` — had **0 attempts**: queued and never offered at
all.

**No end of this was lying. Every end was doing what it was told.** The gap is that
"recipient refuses an ack" is not a state the protocol has an answer for.

## The participants and the transport

- **The daemon** owns machine-local state and a durable outbox
  (`~/.config/tlda/daemon-outbox.<env>.sqlite`). It is the sender for its own facts and the
  replier for server RPCs.
- **The server** receives daemon facts, reports failures back, and issues RPCs. It does not
  own daemon state and must not model it — see
  [Current architecture](current-main-architecture.md).
- **The transport** is one websocket per daemon at `/ws/fleet-daemon`. Messages on a single
  connection are processed through **one serialized promise chain, declared per connection**
  in `server/unified-server.mjs` inside the upgrade handler. A new connection gets a fresh
  chain; a hung handler stalls only that connection.

## The vocabulary is mail, and the words are not interchangeable

From `AGENTS.md`, and it is load-bearing here:

- **accepted** — the server has taken the message. Real, must be reliable, **not delivery**.
- **delivered** — the recipient was notified through the path that actually surfaces it.
- **read** — the recipient fetched it. Never proves delivery.

A row sitting in the outbox is **not yet accepted**. A row the server has stored is
**accepted**. Neither is delivered.

## The happy path

1. Daemon enqueues a row in the outbox with a type and payload.
2. Daemon offers up to 100 oldest pending rows per flush cycle
   (`daemon/delivery-runtime.mjs`), each occupying a delivery slot.
3. Server receives, dispatches by type, and on success acks by outbox id
   (`handleDaemonOutboxEnvelope`, `server/lib/daemon-ws-control-plane.mjs`); on a throw it
   sends an error instead.
4. Daemon receives the ack and clears the row.

## The states that are unspecified, and what happens today

Each of these is a real reachable state. **"Today" is observed behaviour, not a
specification.** None of them is a decision anyone has recorded making.

### 1. The recipient refuses an ack

**Today:** `handleAck` returns `false` before clearing the row and records no error. The row
stays pending forever, retried indefinitely, `last_error` empty. This is the failure above.

**Unspecified:** whether a refusal may be silent; whether it must record a reason; whether a
row that has been refused N times is still eligible for a delivery slot; whether refusal is
even a legitimate move for a receiver that has already been acked by its peer.

### 2. A row can never satisfy its own gate

**Today:** the gate at `bin/fleet-daemon.mjs:1360` requires `retry_enqueued === 1`. Rows
exist with `retry_enqueued = 0` and no path that will ever set it, so the gate is
permanently false and the row is permanently unackable.

**Unspecified:** whether a gate that cannot pass is a bug in the row or a bug in the gate;
what a row does when its precondition is unreachable; whether anything is responsible for
noticing.

### 3. Head-of-line blocking with no bound

**Today:** the delivery window is the 100 oldest pending rows. Unackable rows are always the
oldest, so they hold their slots permanently and newer rows of every other type starve. There
is no per-row attempt cap, no dead-letter, no priority, and no fairness across types.

**Unspecified:** whether one type may starve another; whether an attempt count has a
ceiling; where a row goes when it exceeds one. **Note the counterexample already in the
tree:** an earlier fix bounded `inflight` so no single message could pin the queue. That
bound does not cover this case, because these rows are not in flight — they are refused after
a completed round trip.

### 4. Attempts without errors

**Today:** `attempts` climbs and `last_error` stays `(none)`, because the failure is a
refusal rather than an exception. Every operator instrument reads healthy.

**Unspecified:** whether `attempts > 0` with no error is a legal state at all. It is the
state that made this invisible for ten hours.

### 5. A hung handler on a shared chain

**Today:** the per-connection chain has a `.catch`, so a *rejected* handler logs and the
chain continues. A handler that **never settles** stops every later message on that
connection with no error anywhere.

**Unspecified:** whether handlers must be time-bounded; whether the chain should have a
watchdog. *(This was investigated as a cause of the 2026-08-18 outage and ruled out — the
server's event loop was measured healthy at 20 ms mean lag and it was acking normally. It
remains an unspecified state.)*

### 6. Success is reported by things that cannot know it

**Today:** `tlda agent mint` prints `Route published` when the daemon has *enqueued* the
route, not when the server has stored it. `chat()` to an agent with no route answers
`Accepted … [available]`. `delegate(mint:)` returns an `agent_id` for a process that was
never launched. `git`-style exit codes are lost through pipes, so a mint that printed
`ABANDONED` exits 0.

**Unspecified:** which word each surface is entitled to use, and at which point in the
protocol it becomes entitled to it. **This is the rule that would have prevented most of the
day**: no surface may report *delivered* on the strength of *accepted*, and none may report
either on the strength of *enqueued*.

## What must be decided rather than discovered

These are open and they are Skip's or an owner's to settle, not an implementer's to infer:

1. **Is a silent refusal ever legal?** If not, the refusal path records a reason and the row
   becomes visible immediately.
2. **What is the attempt ceiling, and where does a row go past it?** A dead-letter that
   preserves the payload is the only version compatible with *never delete his data*. These
   rows carried the full text of `bregman-lower-bound.tex`.
3. **May one message type starve another?** If not, the delivery window needs fairness
   across types rather than pure oldest-first.
4. **Which surfaces may say delivered?** See the mail vocabulary above.

## Standing rules that already apply here

- **Prove the wire, not the two ends.** Calling the sender's function and the receiver's
  function from one process proves both functions and nothing about the connection, and the
  connection is the only part that can be missing.
- **A severed wire reports health.** An unrecognised type returns normally, so the message is
  marked processed and positively acknowledged to a sender with no other signal.
- **The server reports daemon facts; it does not own daemon state.**
- **Never delete his data to clear a queue.** The rows are the work.
