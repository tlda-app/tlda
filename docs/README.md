# Documentation map

This directory contains current, code-checked guidance. Finished plans, specs,
incident notes, review packets, and other point-in-time working records were
removed; Git history remains their archive.

## Current guidance

- [README](../README.md) — product overview and user setup
- [Using tlda](using-tlda.md) — identity, project linking, Markdown, search, agents,
  permissions, and local configuration
- [Current architecture](current-main-architecture.md) — current developer architecture
- [LiveKit](livekit.md) — implemented voice/video path and server configuration
- [Live deployment](live-deploy.md) — current live deployment runbook
- [Hosting tlda](hosting.md) — serving privately and deploying the live Fly application
- [Permissions implementation contract](permissions-implementation-contract.md) — current permission object and
  resolution contract
- [Fleet agent guide](fleet-agents.md) — using the fleet tools and managing agent obligations
- [Fleet chat artifacts](fleet-chat-artifacts.md) — current cross-machine chat artifact contract
- [Source authority state machine](source-authority-state-machine.md) — source revision and synchronization authority
- [Voice-path known defects](voice-path-known-defects.md) — current verified voice defects

The project `AGENTS.md` remains the authoritative project operating contract.
The schemas exposed by the running CLI and MCP server remain authoritative for
exact command/tool arguments.
