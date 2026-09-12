# The shared canvas as hub

tlda's browser canvas is the primary human collaboration surface. Documents,
fleet chat, agent state, tasks, source editing, and annotations share one
application rather than being split between a passive dashboard and terminal
tabs.

## Current architecture

```text
browser canvas
  |-- document and source views
  |-- fleet chat and inbox
  |-- agent directory and lifecycle controls
  |-- annotations and shared canvas shapes
  `-- activity and result cards
             |
             v
      unified tlda server
             |
       fleet WebSockets
             |
      MCPs and daemons
```

The server stores durable fleet and project state. Browser clients receive live
updates over WebSockets and synchronized document state through Yjs. Agents use
MCP tools for the same conversations, tasks, documents, and lifecycle actions.

## Terminals

A terminal is an agent workspace and recovery surface, not the message store or
notification authority. Agents may run in tmux so their processes can be
inspected, interrupted, hibernated, and resumed without replacing their fleet
identity.

Notification delivery goes from the server to the agent's MCP channel. The
daemon owns machine-local process recovery and terminal operations; it does not
act as a second message-delivery path.

## Human attention surface

The canvas should make fleet state legible without requiring terminal
inspection:

- stable agent identities and names;
- current runtime and activity state;
- unread conversations and task changes;
- visible delegation and completion cards;
- inspectable tool results and bounded reads;
- explicit error and refusal states.

Terminal inspection remains available when the terminal itself is the subject,
but ordinary collaboration does not depend on scanning process panes.

## Agent surface

Agents use `login()`, `inbox()`, `chat()`, `thread()`, `search()`, delegation,
lifecycle, and document tools. Their durable identity and history are independent
of any one process or tmux pane.

The agent-facing surface must expose the same distinctions the browser relies
on: queued versus accepted work, notification delivery versus read state,
current versus historical status, and complete versus paginated reads.

## Design invariants

- The browser is bidirectional, not a passive observer.
- Human and agent messages share one durable conversation record.
- A terminal's presence does not determine whether an agent can receive tasks
  or send messages.
- Human-visible actions report their actual result.
- Agent-visible tools return enough context to identify the same project,
  document version, message, and participant shown in the browser.
- Failures remain inspectable; they are not replaced by optimistic status.
- The hub supports pointer, touch, and voice interaction without requiring a
  keyboard for core workflows.

See [The mirror principle](mirror-principle.md),
[The fleet agent experience](agent-experience.md), and
[Notifications and liveness](../docs/notifications-and-liveness.md).
