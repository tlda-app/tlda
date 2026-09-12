# Daemon–server message delivery

The daemon and server exchange machine-local facts, activity, terminal data,
and RPCs over a fleet-daemon WebSocket. Delivery policy follows the semantics of
each message type rather than treating all traffic as equally durable.

## Delivery classes

| class | behavior | examples |
| --- | --- | --- |
| durable FIFO | Persist in SQLite until the receiver acknowledges or permanently rejects the row. | activity events, agent routes and context, task events, warnings, terminal chat, RPC replies |
| ephemeral FIFO | Buffer briefly while disconnected, with a bounded queue. | terminal output |
| latest wins | Retain only the newest value for each message/agent key. | terminal size, activity health |
| direct | Attempt delivery on the current socket without persistence. | daemon hello, correlated requests governed by their caller's timeout |

RPC replies are durable because work can finish after the request socket closes.
Heartbeat-style state is latest-wins because a newer value supersedes an older
one. Activity records remain durable because losing one removes evidence.

The authoritative type mapping is in `daemon/delivery-policy.mjs`.

## Durable daemon-to-server path

1. The daemon writes the message and stable outbox ID to its SQLite outbox.
2. A flush claims pending rows in outbox order, subject to inflight and byte
   budgets.
3. The server processes the envelope and records the outbox ID as processed.
4. The server acknowledges the ID; the daemon removes the row.

If a connection closes before acknowledgement, the daemon offers the same row
again. The server's processed-ID ledger makes that replay idempotent and returns
the acknowledgement without repeating the handler.

The runtime limits inflight work per lane and releases unanswered inflight slots
after a configured deadline. A byte budget prevents large payloads from making
each flush monopolize the daemon event loop. The first pending row may exceed
the budget so an oversized message is still deliverable.

## Errors and dead letters

The server returns a structured error when a handler rejects a durable row.
Transient transport errors leave the row pending for retry. A permanent receiver
rejection moves it to the dead-letter state with its payload and reason intact.

Dead-lettered rows remain inspectable and do not occupy the pending delivery
window. The default daemon outbox attempt ceiling is five for errors eligible
for dead-lettering; transient socket failures do not consume that terminal
budget.

## Server-to-daemon path

The server has its own durable outbox for commands that must reach a particular
daemon. Enqueueing and socket delivery are separate: the caller may continue
after the row is stored, while the server flushes it when the daemon connection
can accept more data.

Flushes are serialized per daemon key. The server marks a row inflight before
sending, records receiver errors, and retries non-terminal failures. Disconnect
cleanup releases inflight claims so pending rows can be offered on the next
connection.

## Ordering

Durable rows use the outbox's declared order. Ordering is local to an outbox; it
does not create a global order across daemons or unrelated transports.

## Claims exposed to callers

- **queued** means the sender persisted an outbound row.
- **accepted** means the receiving server stored or processed it.
- **delivered** requires acknowledgement through the recipient-facing channel.
- **read** means the recipient fetched the corresponding inbox state.

No earlier state implies a later one.

## Verification

The delivery tests exercise policy classification, reconnect replay,
processed-ID deduplication, inflight deadlines, byte budgets, lane bounds,
dead-letter handling, error classification, and per-daemon server-outbox
serialization. Wire-level tests are required where the behavior depends on the
actual WebSocket boundary.
