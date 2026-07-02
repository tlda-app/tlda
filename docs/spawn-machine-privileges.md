# Machine-local spawn privileges

Spawn authority is decided by the daemon on the machine that will launch the
child process. The server routes the request, identifies the requester, and
records the daemon's reported outcome; it does not decide the local filesystem
privilege grant.

The full target model is `docs/fence-privilege-model.md`. This page records the
daemon-permissions implementation surface.

## Authority clamp

For daemon-routed spawn, the granted child privilege is:

```text
spawner-row ∩ requested ∩ model-cap
```

- `spawner-row` is the spawning agent's current daemon-local grant, loaded from
  the daemon privilege ledger.
- `requested` is the explicit spawn request, or the project/shipped default when
  no explicit request is supplied.
- `model-cap` is the per-box model ceiling from daemon config.

Project files and shipped defaults fill only the `requested` slot. They are
convenience defaults, not authority. Old `machineGrant` and local ACL config are
not authority clamps for daemon-routed spawn.

## Daemon ledger

The daemon persists current grants in `daemon-privileges.yaml` under the active
tlda config directory. Rows are keyed by fleet ID and survive hibernation.

Root rows are seeded from daemon config (`spawnPolicy.rootCeilings` or
`spawnPolicy.rootGrants`) and written on first use. Unknown fleet IDs resolve to
`none` unless a row or root config entry exists.

Every successful spawn writes the child's granted policy and privilege set to
the ledger. A later child spawn uses that row as the child's spawner authority.

Ledger writes use a temp file followed by rename.

## Shipped default

The shipped default request is deliberately local:

```yaml
write_roots: ["."]
read_roots: ["."]
```

The fence materializer also includes the local plumbing needed for agents to
function: temp directories, git metadata, worktree metadata, and existing
scratch/browser caches. It does not include credentials, Fly, deploy, or other
off-box access; those require user config.

Worktrees are first-class: a write-capable worktree grant includes the worktree
path and the actual git metadata paths required for worktree operations.

## Spawn interface

Agents and humans request child privileges at spawn time. The request can be a
named profile or an explicit operation-plus-zone privilege set:

```sh
tlda agent spawn mini:app-fixer --privileges app-dev
tlda agent spawn app-fixer --privileges app-dev
```

`spawn-direct` is the local primitive and operator escape hatch. It bypasses the
server route, but it still uses the same privilege/profile compiler where
applicable:

```sh
tlda agent spawn-direct app-fixer --privileges app-dev
```

The legacy `--capability none|read|write|tlda-write|full` field is a shorthand
request. New callers should use `--privileges` so requests can carry explicit
operation-zone sets.
