# Documentation map

This directory contains current, code-checked guidance. Finished plans, specs,
incident notes, review packets, and other point-in-time working records were
removed; Git history remains their archive.

## User documentation

- [README](../README.md) — product overview and short setup path
- [Using tlda](using-tlda.md) — canonical user behavior: project linking and history,
  identity, Markdown, search, agents, permissions, and local configuration
- [Hosting tlda](hosting.md) — serving privately and deploying the live Fly application

## Developer reference

- [Current architecture](current-main-architecture.md) — current developer architecture
- [The window manager](window-manager.md) — layers, the fleet HUD's second viewport, and
  where the current implementation does not match the design
- [LiveKit](livekit.md) — implemented voice/video path and server configuration
- [Permissions implementation contract](permissions-implementation-contract.md) — current permission object and
  resolution contract
- [Fleet chat artifacts](fleet-chat-artifacts.md) — current cross-machine chat artifact contract
- [Source authority state machine](source-authority-state-machine.md) — source revision and synchronization authority
- [Voice-path known defects](voice-path-known-defects.md) — current verified voice defects

## Development process

- [Fleet agent guide](fleet-agents.md) — using the fleet tools and managing agent obligations
- [Live deployment](live-deploy.md) — current live deployment runbook

The project `AGENTS.md` remains the authoritative project operating contract.
The schemas exposed by the running CLI and MCP server remain authoritative for
exact command/tool arguments.
