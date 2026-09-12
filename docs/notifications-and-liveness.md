# Notifications and liveness

This document describes how fleet messages reach agents and how machine-local
liveness recovery stays separate from message delivery.

## Vocabulary

The system uses two distinct operations:

| operation | meaning |
| --- | --- |
| **notify** | Surface a notice to an agent that already has a running process. |
| **wake** | Start a process for an agent that has no running process on its assigned machine. |

An inbox row proves that the server accepted a message. It does not by itself
prove that the recipient was notified or read it. The delivery states are:

- **accepted**: the server stored the message;
- **delivered**: the recipient's MCP acknowledged the notification;
- **read**: the recipient fetched the message from its inbox.

## Notification path

There is one notification path:

```text
server -> agent MCP -> harness channel -> agent
```

The MCP adapts the notice to the channel supported by its harness. The daemon is
not a notification transport and never carries message text.

Only authenticated MCP channel sockets are notification targets. Other fleet
clients, including bots with a fleet WebSocket, are not treated as MCPs merely
because they have an open socket.

For each notice, the server:

1. sends a `channel-notification` with an acknowledgement identifier;
2. waits for `channel-notification-ack`;
3. reports the observed channel symptom to the agent's daemon if delivery does
   not complete.

An MCP may explicitly refuse a notice. Refusal is distinct from silence: it
proves the MCP responded and therefore is not a liveness failure.

### Login and return notices

After a daemon starts an agent process, the agent calls `login()`. The server
then returns the pending notification summary. The wake request itself carries
no mail.

## Server and daemon responsibilities

The server reports only what it observed on its channel. It does not infer
process state or choose a lifecycle remedy.

| server symptom | observation |
| --- | --- |
| `no-channel` | No open MCP channel exists. |
| `channel-closed` | An MCP channel closed or every send failed. |
| `channel-silent` | No acknowledgement arrived before the configured deadline. |
| `channel-refused` | The MCP explicitly declined to surface the notice. |

If the agent has no daemon route, the server records `no-daemon-route` and
stops. It does not deliver through a local fallback.

The daemon owns machine-local process state and maps symptoms to actions:

| symptom | daemon action |
| --- | --- |
| `no-channel` | Ensure a process exists. |
| `channel-closed` | Ensure a process exists. |
| `channel-silent` | Suggest a restart through the existing session. |
| `channel-refused` | Record the refusal; take no lifecycle action. |

Unknown symptom names are recorded without an inferred action. Ensuring a
process is idempotent: it starts a missing process and is a no-op when one is
already alive.

The server reports symptoms on a best-effort basis and does not wait for the
daemon's remedy. This keeps one slow daemon from blocking notifications for the
rest of the fleet.

## Acknowledgement timeout

The acknowledgement deadline is configured in each deployment's `server.yaml`:

```yaml
notifications:
  ackTimeout: 5s
```

The value is a duration with an explicit unit. It must exceed the MCP's serial
budget for surfacing a notice and sending its acknowledgement. Invalid or
missing values fail during configuration loading rather than becoming an
implicit source-code default.

## Notification policies

Subscriptions choose when matching notices are surfaced:

- `immediate` surfaces each eligible notice immediately;
- `batch(<duration>)` groups notices for a configured interval;
- `hold` retains readable inbox state without surfacing notices.

Policy changes affect notification timing, not whether messages are stored or
readable.

## Expected races

Inbox reads and notification delivery are not serialized. An agent may poll its
inbox after a message is stored but before the notice arrives. The later notice
can therefore point to an inbox that is already empty. That sequence alone is
not evidence of duplicate delivery or message loss.

## Invariants

- The daemon does not deliver notifications.
- The server does not select process remedies.
- A failed channel notification is not retried through another delivery path.
- Wake requests contain no message text.
- Missing daemon routes fail explicitly; they do not authorize local fallback.
- Timeout values live in deployment configuration and include units.
- `accepted`, `delivered`, and `read` are separate claims.

## Verification

The notification wire tests cover acknowledged delivery, explicit refusal,
closed and silent channels, non-MCP sockets, hibernating agents, and missing
daemon routes. The daemon action tests cover every symptom-to-action mapping and
the safe handling of unknown symptoms. Configuration tests require every
deployment to declare a valid timeout that exceeds the MCP delivery budget.
