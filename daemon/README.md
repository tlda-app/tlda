# Daemon Modules

This directory holds daemon-side behavior modules. `bin/fleet-daemon.mjs` is the
process entrypoint and wiring layer: config, singleton lock, WebSocket
lifecycle, module construction, and RPC/event routing.

- `source-sync.mjs`: project/source watcher. Owns source bindings, dependency
  scans, chokidar source watchers, connect pushes, and source-change messages.
- `jsonl-ingestor.mjs`: transcript/session ingestion. Owns cursor persistence,
  session identity, owner harvesting, live JSONL tails, search backfill jobs,
  qualification/edit tracking, and edit attribution for source-sync.
- `machine-rpc.mjs`: daemon RPC dispatch and daemon-originated request/reply
  bookkeeping.
- `terminal-rpc.mjs`: tmux session validation/control, terminal capture/input,
  interrupt/soft-interrupt, terminal-card PTY streaming, terminal resize, and
  check-alive/list-sessions RPCs.
- `local-artifacts.mjs`: machine-local file upload/rechat materialization,
  inbox attachment materialization, and playwright orphan cleanup handlers.
- `prompt-plan.mjs`: permission prompt detection, auto-accept cooldown/sweep
  state, surfaced prompt state, and plan-mode prompt extraction/deduping.
- `agent-status.mjs`: armed status scanning, pane classification state,
  thinking/compacting/status edges, terminal attention edges, and disarm
  cleanup.
- `goose-supervisor.mjs`: goose sqlite activity polling, turn-end kick state,
  freeze tracking, and idle/stuck/pending goose nudges.
- `agent-liveness.mjs`: daemon liveness cache, activity heartbeat updates,
  hibernation probe state, crash capture, liveness messages, and the currently
  disabled liveness sweep.
- `activity-events.mjs`: Claude JSONL turn parsing, activity noise filtering,
  pretty-result matching, and activity-event extraction.
- `harness-runtime.mjs`: harness adapter definitions, live pane process
  classification, and Codex transcript resolution.
- `shadow-mirror.mjs`: shadow bundle verification/fetch/update-ref handling for
  the `mirror-shadow-ref` daemon RPC.
- `dead-letters.mjs`: local dead-letter persistence and replay for daemon-originated
  messages that could not be sent while the WebSocket was disconnected.

Agent launch / spawn wiring lives in `agent-launch/agent-launch.mjs`; the
daemon only registers its RPC handlers.
