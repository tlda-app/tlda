# Documentation map

This directory contains current, code-checked guidance. Finished plans, specs,
incident notes, review packets, and other point-in-time working records were
removed; Git history remains their archive.

## Current guidance

- `../README.md` — product overview and user setup
- `current-main-architecture.md` — current developer architecture
- `project-linking.md` — local checkout and remote/Overleaf source workflows
- `livekit.md` — implemented voice/video path and server configuration
- `live-deploy.md` — current live deployment runbook
- `hosting.md` — serving privately and deploying the live Fly application
- `local-configuration.md` — named configs, daemon profiles, and managed bots
- `permissions-implementation-contract.md` — current permission object and
  resolution contract
- `fleet-chat-artifacts.md` — current cross-machine chat artifact contract
- `voice-path-known-defects.md` — current verified voice defects

The project `AGENTS.md` remains the authoritative project operating contract.
The schemas exposed by the running CLI and MCP server remain authoritative for
exact command/tool arguments.
