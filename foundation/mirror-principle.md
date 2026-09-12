# The mirror principle

> Humans and agents collaborate on documents. Each side's experience surfaces
> in the other's view. Where the mirror is broken, collaboration breaks.

tlda has two first-class interfaces:

- the human interface: canvas, documents, annotations, chat, source editing,
  touch, pointer, and voice controls;
- the agent interface: MCP tools, durable threads and tasks, daemon events,
  source operations, and lifecycle state.

They use different interaction modes but share the same project, conversation,
history, and collaboration state.

## Agent state in the human interface

The browser shows the state needed to understand an agent's work: identity,
messages, delegations, task results, activity, lifecycle state, and bounded tool
reads. Failures and partial reads must remain visible rather than collapsing
into a success-shaped card.

## Human state in the agent interface

Agents receive document/version context, source locations, annotations, and
messages as structured data. A person can point at a passage or canvas object
without translating it into a separate textual coordinate system.

## Design test

For any new state or action, ask:

1. Can the participant who initiated it see whether it succeeded?
2. Can collaborators see the resulting state through their own interface?
3. Does a failure remain visible and attributable?
4. Can both sides identify the same document, version, message, and agent?

A feature is incomplete when one participant can change collaboration state
that the other participant cannot discover. Removing a status, label, card, or
reference is a regression if that element was the only surface carrying the
shared fact.

The goal is not identical interfaces. It is mutual visibility with each side
using the interface natural to it.

See also [The fleet agent experience](agent-experience.md) and
[tlda as a collaboration medium](tlda-as-medium.md).
