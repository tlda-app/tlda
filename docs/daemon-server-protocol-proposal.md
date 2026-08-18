# The daemon–server protocol {#proposal}

**A proposal, written to be said no to.** What the protocol currently *is* — including six
states where one end can do something the other has no answer for — is
[the protocol document](daemon-server-protocol.md).

## The problem in one sentence

**One durable, ordered, acknowledged queue carries every kind of fact the daemon has**, so
the cheapest and most disposable traffic gets the same guarantees as a paper edit, and
anything stuck at the head stops everything behind it.

On 2026-08-18 that queue reached **60,970 rows**. A single `source-change` for one project
held the head while **10,479 route publications and 1,061 RPC replies** waited behind it —
messages with no ordering relationship to it whatsoever. Nobody could mint an agent for
most of a day.

## Three kinds of fact, needing three different things

The current protocol treats these identically. They are not alike.

**1. A record — activity events.** Tool calls, status changes. **These are evidence.**
Losing one is data loss even though nothing breaks at the time: something happened and
there is no trace of it. Skip, 2026-08-18: *"mostly ifnorable but if its the wrong event
not good"* — you cannot know at write time which one you will need at 3am.

**2. A current value — roster, liveness.** Which agents live on this machine; whether one
is alive. **Losing one is free**, because the next one says the same thing. These are
self-healing by nature and we currently spend disk, retries and delivery slots defending
them.

**3. A question — RPC, and an accept.** "Run this." "Take this commit." **These need an
answer**, and an unanswered question is not recoverable by resending state.

## What each should use

### Records: batch over HTTP, with a cursor

The daemon POSTs whatever activity it has accumulated, on a short interval. Each event
carries its own **stable id** and its own **timestamp**. The server stores them and orders
by timestamp on read.

**No outbox, no per-message ack, no retry ledger, no delivery window.** If a POST fails,
the next one carries the same batch plus whatever is new. The daemon tracks **one cursor** —
what the server has confirmed — instead of sixty thousand rows.

**Why this loses nothing, and it is the load-bearing part: the daemon is tailing files that
already persist.** The agent JSONL on disk *is* the durable record. The outbox is a second
copy of something already durable, and the cursor makes the copy unnecessary rather than
unreliable.

**Requirement this creates:** events need **stable ids**, so a resent batch is idempotent
and the server can discard what it already has. Without that, a retry duplicates.

**Ordering:** within one agent, the batch preserves it and the timestamps make it explicit.
Across agents there is no ordering relationship, and the current arrival order is an
artifact of tailer scheduling rather than of when anything happened — so the transport is
already not delivering the order it appears to.

### Current values: declare the whole thing, no acknowledgement

The daemon sends its **entire** roster — daemon key plus the agent set — on start and on
change. The server **replaces** its picture rather than merging.

**Replacement is the point.** A per-agent message can only add; it has no way to say *"and
nobody else."* That is why stale routes exist and why nothing can clear them. This is
already built and shipped tonight (`3f69ce005`) and took `agent-route` from ~36,000/day to
~200/day.

**No cursor and no ack here** — the next declaration supersedes the last, so a lost one
repairs itself.

### Questions: HTTP request and response

The answer is the response. This is already how the new source accept works, and the reason
is measured rather than aesthetic — `cfc1cdb43`: *"A 33 MB file becoming 44 MB of body is
what took a box down; a third of that inflation was encoding."*

## What the socket is for afterwards

**Only the direction that genuinely needs it: the server reaching the daemon.** Restart your
MCP, resolve this route, run this. The daemon does not need a socket to talk to the server —
HTTP is sufficient and it has no head-of-line blocking, because each request is independent.

**So the socket stops carrying a queue.** No durable outbox, no ack gate, no in-flight
window, no re-offer loop, no dead-letter path. **Those exist to make delivery reliable on a
channel that would no longer need reliability.**

## The redundancy this exposes, which is the immediate win

`activity-health` is emitted **per JSONL line** — `bin/fleet-daemon.mjs:432`, comment *"A
JSONL line is a per-turn heartbeat"*, reason `activity extracted from harness stream`.

**So every turn produces two messages: the activity event, and a separate assertion that the
agent is alive, derived from the same line.** The event already proves liveness. Measured
tonight: heartbeats returned from 0 to 119 within 90 seconds of being wiped — about 70 a
minute, from roughly 30 agents.

**This is not a change in what we send. It is that the rate scales with how much the fleet
talks, and tonight is the first night with this many agents working this hard.**

## What is his to decide

1. **Is a one-second batch acceptable for activity cards**, or do they need to feel live?
2. **Should the server pull state rather than the daemon pushing it?** Pull is simpler still —
   nothing to buffer — but the server has to know when to ask.
3. **Does anything else genuinely need the socket** from daemon to server, or can it become
   server-to-daemon only?

## What this is not

- **Not a new subsystem.** It deletes an outbox, an ack gate, a retry ledger and a delivery
  window. It adds a cursor and an id.
- **Not batching as an optimisation.** Batching here is a consequence of dropping
  per-message delivery, not a way to make per-message delivery cheaper.
