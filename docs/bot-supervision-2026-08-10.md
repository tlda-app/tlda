# Bot Supervision Findings, 2026-08-10

This records the bot supervision state found during the launchd waiter rollout.

## Confirmed live-process count

At 2026-08-10 03:48 EDT, direct checks of each bot's own identity/pid files and
the process table found 6 of 11 configured bot jobs with a live bot process.
`tlda bot status`, launchd, and the roster were not sufficient evidence because
they could report a stranded launchd waiter as healthy.

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
terminal. Treat this as a known launchd bootout/bootstrap race unless a retry in
the same session also fails.
