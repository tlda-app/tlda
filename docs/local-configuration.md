# Local daemon and bot configuration

Local runtime configuration lives under `~/.config/tlda/`. The repository ships
example daemon configurations in `config/`; the operator-owned file is
`~/.config/tlda/daemon.yaml`.

## Named server selection

`~/.config/tlda/server.yaml` contains named complete server configs. Select one
for a process with `TLDA_CONFIG=<name>` or for a CLI run with
`--config <name>`. `tlda daemon start --config <name>` carries that selection
through the daemon to agents it spawns. Do not edit the shared `defaultServer`
just to test another deployment.

## `daemon.yaml`

The active daemon file defines:

- `regions`: named filesystem regions used by permission profiles;
- `profiles`: read/write allow and deny sets;
- `grants`: identities with durable profile grants;
- `models`: harness model aliases, required launch flags, preferences, and
  whether the daemon may control that harness;
- `tmuxSocket` and task-document settings.

The daemon reads `~/.config/tlda/daemon.yaml` by default. Spawn-time model and
profile resolution is re-read for the next spawn, with keep-last-good behavior
for malformed edits. Use the CLI's advertised profiles (`tlda agent`) rather
than hard-coding a list in documentation; help is derived from the active daemon
configuration.

`TLDA_DAEMON_CONFIG_DIR` selects an isolated daemon configuration directory for
tests and previews. It is how a sandbox daemon gets its own machine identity,
pidfile, database, and config without colliding with the real environment. It is
not permission to start a second daemon against the same environment.

## `daemon-fenced.yaml`

`config/daemon-fenced.yaml` is a shipped fenced configuration variant. It defines
the path regions and profiles used to constrain spawned agents. It is not merged
automatically with `daemon.yaml`: choose/copy the intended configuration into
the daemon's config directory, then inspect `tlda agent` help to confirm the
profiles the running CLI sees.

The repository's `config/daemon.yaml` is the broad launch-harness/default
example; the operator's `~/.config/tlda/daemon.yaml` is the live source of truth.
Do not infer live grants from the repository examples.

## Bots

Managed bots are configured in `~/.config/tlda/bots.yaml`:

```yaml
bots:
  - name: todd
    script: bin/bots/todd.mjs
  - name: teacher
    script: /absolute/path/to/teacher-bot.mjs
    machine_id: mini
```

Each entry has `name`, `script`, and an optional `machine_id`; optional `env`
values are passed to the bot process. With no `bots` array, the code defaults to
Todd. Relative scripts resolve from the installed tlda root.

## CLI preferences

Ordinary CLI preferences such as browser selection live in
`~/.config/tlda/cli.yaml`.

Manage configured bots with:

```bash
tlda bot list
tlda bot install [name]
tlda bot start [name]
tlda bot stop [name]
tlda bot status [name]
tlda bot log [name]
tlda bot uninstall [name]
```

On macOS these commands manage per-bot launchd services and their tmux/log/pid
paths. A bot logs in to the fleet like an agent. Current CLI code explicitly
states that the daemon does not start configured bots; use `tlda bot ...` for
their service lifecycle.

## Checks before changing local configuration

- Confirm the active named config with `tlda system`.
- Confirm daemon status before starting another daemon.
- Confirm effective permission profile names from `tlda agent` help.
- Confirm bot resolution with `tlda bot list` before installing or starting.
- Keep secrets out of daemon profiles and bot entries; use environment/secret
  stores appropriate to the process.
