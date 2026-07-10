# Agent Runtime

Shared runtime support for fleet agents and the daemon.

This is not a CLI entrypoint. It holds reusable machinery for:

- session identity records and transcript resolution
- JSONL and rollout parsing
- activity-card extraction and delivery helpers
- agent status and liveness classifiers
- daemon singleton/session-reader locks
- small fleet-message classifiers used by MCP tools

Executable commands stay in `bin/`. Daemon orchestration stays in `daemon/`.
Launch/spawn orchestration stays in `agent-launch/`.
