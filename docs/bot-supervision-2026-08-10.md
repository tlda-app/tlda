# Bot Supervision Findings, 2026-08-10

This records the bot supervision state found during the launchd waiter rollout.

## Confirmed live-process count

At 2026-08-10 03:48 EDT, direct checks of each bot's own identity/pid files and
the process table found 6 of 11 configured bot jobs with a live bot process.
`tlda bot status`, launchd, and the roster were not sufficient evidence because
they could report a stranded launchd waiter as healthy.

The transferable rule is that bot liveness must be read from the bot process,
not from the supervisor. The sharpest example in this survey was
`chat-lint.stable`: `tlda bot status` reported `running + supervised` while the
job had no identity file or pidfile and launchd was only supervising a stranded
waiter.

Dead at that check:

- `chat-lint.stable`
- `grammar.stable`
- `nobody.stable`
- `teacher.stable`
- `todd.testing`

## Dead stable jobs

- `chat-lint.stable`: missing `~/.config/tlda/chat-lint.stable.fleet-id` and
  missing pidfile. The launch command cannot start because its first operation
  reads the identity file.
- `nobody.stable`: missing `~/.config/tlda/nobody.stable.fleet-id` and missing
  pidfile. The launch command cannot start because its first operation reads the
  identity file.
- `grammar.stable`: has identity `fleet:grammar` and pidfile `45874`, but its
  plist is the old direct tmux form and points at missing
  `/Users/skip/work/tlda/bin/bots/grammar-bot.mjs`.
- `teacher.stable`: has identity `fleet:d0722d34` and pidfile `801`, but that
  process is not live. Its plist uses the current `tlda agent wake` form.

These are repair items, not rollout steps. The four stable jobs do not share one
cause.

## Launchd apply note

During this rollout, `tlda config apply` sometimes failed with:

```text
Bootstrap failed: 5: Input/output error
```

The same command later succeeded for `nobody.testing` when run again from Skip's
terminal, and five more jobs applied cleanly from that terminal without hitting
the error. The source of the flakiness is unexplained; the working operational
rule is to retry once rather than treating the first failure as evidence that
the generated plist is bad.

## Wake false success on shell-only sessions

`todd.testing` exposed a second false-success path after the launchd waiter fix
landed. Its launchd job moved to the new pane-pid waiter, but todd still did not
write a fresh heartbeat. The blocking state was:

- `fleet-bot-todd_testing` existed.
- Its pane process was a bare `zsh`, not a bot runtime.
- `~/.config/tlda/todd.testing.pid` pointed at a dead process.
- `~/.config/tlda/todd.testing.heartbeat` was still stale.

The wake path reported success because `spawnTmux()` treats an existing
shell-only session as a non-destructive no-op:

- `agent-launch/tmux.mjs:132`: `spawnTmux()` tries `tmux respawn-pane`; when
  that fails and the tmux session exists, it returns `false`.
- `agent-launch/index.mjs:910`: `spawnRespawn()` treats that as success:
  `if (!launched) return { ok: true, fleetId, tmuxSession, harness: requestedKind, model, alreadyAlive: true }`

So `tlda agent wake fleet:f1e9c0be` printed `Woke ...` even though no todd bot
process started.

The control was `nobody.testing`: during the pilot, its tmux session was killed
before wake. With no shell-only session blocking launch, the same wake command
shape started the bot and produced a fresh heartbeat.

Proposed fix shape, not applied here: a shell-only existing session should be a
wake failure, not `alreadyAlive: true`. `alreadyAlive` should require a confirmed
runtime process.
