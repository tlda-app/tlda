# Bot supervision

This document describes the durable rules for supervising fleet bots. The date
in the filename is historical; the content below describes the current public
operating model.

## Bot identity

A bot is a persistent fleet participant, not a disposable agent process. Each
configured bot/environment pair needs its own fleet identity, tmux session,
pidfile, heartbeat, daemon route, and mint-ledger entry.

Do not derive identities from the bot name alone when the same bot can run in
more than one environment. A machine-wide mint ledger cannot safely map one
fleet ID to two environment-specific sessions.

Identity files are inputs to supervised startup. Creating or replacing one by
hand is not sufficient unless the same identity has a matching fleet row and
local mint-ledger mapping.

## What supervision proves

A running supervisor proves only that the supervisor process is alive. Bot
liveness requires evidence from the bot runtime itself:

- the configured tmux session contains the expected runtime process;
- the pidfile names a live matching process;
- the heartbeat is current;
- the fleet identity and daemon route resolve to that runtime.

A launchd job waiting on a failed wake can appear supervised while no bot is
running. Status surfaces should distinguish those states.

## Wake behavior

Wake is non-destructive. It starts a missing runtime, but it does not silently
replace an existing tmux session whose expected runtime is absent. That state is
reported as a failure so an operator can inspect the session rather than losing
its contents.

An `alreadyAlive` result is valid only when the expected runtime has been
confirmed. The existence of a tmux session or shell process alone is not enough.

## launchd configuration

Generated launchd jobs read the environment-specific identity, ask tlda to wake
that identity, and supervise the resulting bot process. Configuration changes
should be applied from a user login session whose launchd manager is `Aqua`;
background agent sessions are intentionally refused by the configuration
transition guard.

Apply the narrowest configured scope when changing one environment:

```bash
tlda config apply --only <environment>
```

If launchd returns an input/output bootstrap error, inspect the generated job
and current manager state before retrying. A retry is an operational recovery,
not evidence that the first apply succeeded.

## Recovery checklist

1. Resolve the bot's configured fleet ID and environment.
2. Confirm the fleet row, daemon route, and mint-ledger session agree.
3. Inspect the tmux pane for the expected runtime rather than a shell-only
   session.
4. Check the pidfile against the live process and command.
5. Check heartbeat freshness.
6. Repair the mismatched identity or session mapping before restarting the
   supervisor.
7. Verify the bot process and heartbeat after recovery.

Preserve the bot's existing fleet identity whenever possible so its thread,
subscriptions, and task history remain continuous.
