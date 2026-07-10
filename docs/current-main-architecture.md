# Current Main Architecture

Scope: `main` after the June 21/22 cutover. This document describes the current
code paths, not the old `best-version-5176`/`bv5176` architecture.

## Runtime Topology

- Live server: Fly app `tldraw-sync-skip`, configured by `fly.live.toml`.
- Tailnet URL used by agents and bots: `https://tlda-fly.cormorant-matrix.ts.net`.
- Browser and fleet clients connect to `/ws/fleet`.
- Per-machine daemons connect to `/ws/fleet-daemon`.
- The server owns fleet persistence, chat/task/event fanout, spawn routing,
  build orchestration, and Yjs room state.
- Each daemon owns its local machine: tmux RPC, JSONL watching, liveness/status
  scans, source watches, spawn execution, and managed background bots.

## Spawn Routing

Primary modules:

- `server/unified-server.mjs`
- `server/routes/fleet.mjs`
- `server/lib/spawn-routing.mjs`
- `shared/spawn-librarian.ts`
- `server/lib/spawn-policy.mjs`
- `bin/fleet-daemon.mjs`
- `agent-launch/agent-launch.mjs`
- `agent-launch/index.mjs`
- `bin/fleet-spawn.py`

Spawn is routed by identity and machine ownership.

1. A caller sends a spawn request on `/ws/fleet`. The HTTP `/api/spawn` path
   fails closed unless it has an authenticated fleet caller identity.
2. `resolveSpawnMachine()` chooses the daemon:
   - respawn/refresh route to the target agent's `machine_id`;
   - a configured `fleet_prefs.spawn_machine_id` is honored for fresh spawns;
   - a non-human caller can default to its own `machine_id`;
   - a sole connected daemon may be used as a bootstrap default;
   - multiple connected daemons with no preference fail loudly.
3. `resolveSpawnCollision()` and `SpawnLibrarian.awaitRegister()` in
   `shared/spawn-librarian.ts` handle name collisions and register readiness.
4. The server sends exactly one `spawn` RPC to the selected daemon.
5. The daemon's agent-launch module invokes the spawn launcher and reports the result.

There is no silent fallback to server-local spawn or another daemon. If the
selected daemon is unavailable, the spawn path returns failure.

## Liveness, Thinking, and Turn End

Primary modules:

- `bin/fleet-daemon.mjs`
- `bin/lib/status-classifier.mjs`
- `shared/spawn-librarian.ts`
- `server/unified-server.mjs`
- `bots/todd.mjs` (executed through `bin/bots/todd.mjs`)
- `bots/self-check/scheduler.mjs`
- `bots/self-check/poke.mjs`

The daemon is the source of process/status truth. It scans tmux panes, JSONL
activity, and harness-specific status surfaces, then emits liveness and
`agent-thinking` / `agent-compacting` edges. The shared status state machine is
harness-independent; only the classifier inputs vary by harness.

The server stores thinking/compacting state and emits a synthetic persisted
`turn_ended` event on the `agent-thinking: true -> false` edge for non-human
agents. Todd can optionally use those events for a turn-end self-check lane:
wait the configured self-check countdown, cancel if Skip responds, and send the
self-check poke if the agent went idle without closing the loop. That lane is
off by default; the routine automatic watchdog is Todd's longer idle-task kick.

Live verification on June 22, 2026:

- disposable Fly agent `fleet:e2e-live-thinking-987fa2fa`;
- `agent-thinking: true` was browser-visible in `test-fleet`;
- `agent-thinking: false` cleared the browser row;
- server event `584387` persisted `turn_ended`;
- the self-check lane sent chat `584400` to the same agent about 30 seconds
  later.

## Daemon-Owned Bots

Primary modules:

- `bin/lib/managed-bots.mjs`
- `bin/fleet-daemon.mjs`
- `shared/config.mjs`

Managed bots are daemon-owned. The daemon reads `getManagedBots(config)`, filters
optional `machine_id`, owns bot pid/log files in `~/.config/tlda`, starts bots
detached, and applies rapid-crash backoff. The server does not supervise bot
pidfiles.

Current live config includes:

- `todd`
- `teacher`

Current intended daemon-owned bot set is `todd` plus any explicitly configured
auxiliary bot such as `teacher`. Todd owns the self-check lane; a separate
`disposition` daemon is no longer part of the intended default/runtime shape.

## Daemon Start Hardening

Primary modules:

- `shared/daemon-identity.mjs`
- `bin/fleet-daemon.mjs`
- `server/unified-server.mjs`
- `test/daemon-identity.test.mjs`

The daemon has two guards against worktree daemons claiming the live machine:

- startup guard: a daemon running from `.worktrees/` or `.claude/worktrees/`
  refuses to start unless isolated by `TLDA_DAEMON_CONFIG_DIR` or `TLDA_SERVER`;
- server backstop: `daemonHelloDecision()` refuses a live `machine_id` takeover
  from a different `install_path`; same-install newer boots may replace stale
  connections.

Verification on June 22, 2026:

- `node test/daemon-identity.test.mjs` passed 11/11;
- `node test/daemon-guards.test.mjs` passed 14/14;
- executing `.worktrees/status-e2e/bin/fleet-daemon.mjs` with no isolation
  exited `1` with `REFUSING TO START`, while the real daemon pidfile stayed
  `523`.

## Live Store

Primary module:

- `shared/live-store.ts`

`createLiveStore()` is the shared incremental collection primitive. It maintains
by-id records, insertion order, secondary indexes, filtered views, listener
notifications, and bulk update batching. It is used by `SpawnLibrarian` for
pending spawn state and by the client fleet data adapter for fleet roster/event
views.

## Sentinel and Stable Build State

Primary modules:

- `server/lib/sentinel.mjs`
- `server/lib/build-runner.mjs`
- `src/pills/BuildErrorPill.tsx`
- `src/pills/BuildWarningPill.tsx`
- `src/pills/SyncErrorPill.tsx`

The doc-version sentinel shape is the convergent Yjs state for build identity
and stable build status. `writeSentinel()` is the single writer surface. It
preserves status fields unless a patch explicitly changes them, and refuses stale
writes using `sourceVersion` / `buildReadyAt`.

Fire-and-forget build signals still drive transient UI progress and reload, but
stable correctness comes from the sentinel.

## Current Live State

Observed June 22, 2026:

- `fly status -c fly.live.toml` reports app `tldraw-sync-skip`, machine
  `6e823217b03718`, version `134`, image
  `tldraw-sync-skip:deployment-01KVPHM603J5W6FGHQ5WM1XE7G`, state `started`.
- `tlda daemon status` reports local daemon pid `523`, config target
  `https://tlda-fly.cormorant-matrix.ts.net`, last WS target
  `wss://tlda-fly.cormorant-matrix.ts.net/ws/fleet-daemon`.
