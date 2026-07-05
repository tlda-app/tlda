# set_delivery_channel - consolidated delivery API

Owner: release-train (coordination) -> msg-threading (implement).
Origin: Skip, 2026-07-05 - simplifying the broken-push workaround into one clean command.

## Goal

Replace the two-command awkwardness (`nudge_agent` one-off ping plus an ad-hoc
delivery setting) with a single command: `set_delivery_channel`. Setting an
agent's channel to `tmux` persistently routes their incoming chat through the
tmux-nudge path, so normal chat reaches them without a per-message nudge.
Remove `nudge_agent`.

## Command

`set_delivery_channel(agent?, channel)`

- `agent` - target agent (UUID, name, or friendly name). Defaults to self if
  omitted.
- `channel` - `channel` (default: normal push) or `tmux` (route delivery via
  tmux nudge).

## Behavior

- When a message is delivered to an agent whose channel is `tmux`, the server
  routes the wake through the tmux-nudge path: the existing daemon tmux RPC that
  `nudge_agent` used. The recipient gets a tmux ping to check inbox.
- Chat content still lands in the inbox as normal. The channel only controls how
  the recipient is woken.
- `channel` is the default current push behavior.

## Permission Barrier

- An agent may set its own delivery channel freely.
- An agent may set another agent's delivery channel only if it is that agent's
  manager: the agent that delegated an active task to the target.
- Otherwise the command refuses with an actionable error explaining that the
  caller can delegate a task first if they mean to take responsibility.

Rationale: changing someone's delivery is an act by whoever is responsible for
them. It also doubles as the recovery path: an agent whose channel broke cannot
easily self-fix, so its manager sets delivery to `tmux` to rescue it.

## Remove

- `nudge_agent` public tool. The underlying tmux-nudge machinery remains
  internal and is used by the delivery router.

## Implementation Notes

- Plug into the existing delivery logic in `shared/inbox-attention.mjs`,
  `mcp-server/fleet-tools.mjs`, and the daemon tmux RPC.
- Reuse the existing task-owner relation: active task `agent` is the target, and
  `delegated_by` is the manager/delegator.
- Persist the channel as per-agent metadata: `metadata.deliveryChannel`.
- No backward-compat shim for `nudge_agent`.

## Tests

- Self-set allowed.
- Manager sets a delegatee's channel -> allowed.
- Non-manager sets another agent's channel -> refused with the recovery path.
- `nudge_agent` is not exposed.
- A chat delivered to a `tmux` channel agent keeps normal inbox delivery and uses
  the internal tmux nudge path for the wake.
