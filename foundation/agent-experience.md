# The fleet agent experience

tlda gives an agent a persistent identity, a running session, durable history,
and the same project context that human collaborators use in the browser.

## Identity and continuity

Each fleet agent has:

- a stable fleet ID and optional friendly name;
- a harness process, commonly in a tmux session;
- a durable message thread that survives context compaction and process restarts;
- an inbox containing current tasks and unread messages;
- a daemon route identifying the machine that owns its process and files.

The current context window is only a view onto that durable identity. Agents
recover prior context through `thread()`, locate specific events with `search()`,
and recover current obligations with `inbox()`.

## Programmatic surface

Fleet MCP tools provide the agent-facing interface:

- `login()` joins an existing fleet identity and returns pending notices;
- `chat()` sends rendered messages to people or other agents;
- `inbox()` shows current tasks and unread messages;
- `thread()` reads complete bounded conversations or task histories;
- `search()` locates events before a bounded thread read;
- `delegate()` assigns durable tasks to existing or newly minted fleet agents;
- lifecycle tools wake, hibernate, interrupt, or reanimate sessions;
- document tools read sources and annotations, capture document views, and make
  source-aware edits.

Chat messages support Markdown, math, code blocks, lifecycle cards, tool-result
cards, and document-region attachments.

## Human-visible presence

Agents appear in the same fleet chat and project surfaces as human
collaborators. Names, activity, task cards, and messages are shared application
state rather than a separate operator console.

The terminal is a process surface, not the durable record. A session can be
restarted while its fleet identity, thread, tasks, and project bindings remain.

## Delivery and liveness

Messages are stored before notifications are attempted. An inbox row therefore
proves acceptance, while MCP acknowledgement proves notification delivery. Read
state is separate from both.

The server notifies an agent through its MCP channel. If that channel is absent
or unhealthy, the server reports the observed symptom to the machine-local
daemon. The daemon owns process recovery; it does not carry message text. See
[Notifications and liveness](../docs/notifications-and-liveness.md).

## Operating expectations

- Call `login()` and `inbox()` when joining or recovering a session.
- Read paginated results to the end before drawing conclusions.
- Treat visible application state as authoritative for user-visible behavior.
- Verify work on the surface it changes before reporting completion.
- Preserve the existing fleet identity when recovering a failed session.
- Keep task state in fleet tools rather than private filesystem notes.
