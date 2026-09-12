# Documentation map

This directory contains user, operator, and developer documentation for the
public repository.

## User documentation

- [README](../README.md) — product overview and short setup path
- [Using tlda](using-tlda.md) — canonical user behavior: project linking and history,
  identity, Markdown, search, agents, permissions, and local configuration
- [Hosting tlda](hosting.md) — serving privately and deploying the live Fly application

## Developer and operator reference

- [Developing tlda](../DEVELOPING.md) — getting the code running, the layout of the
  tree, the change/verify loop, and cutting a release
- [Document formats](document-formats.md) — LaTeX, Markdown, Quarto, and PDF inputs
- [LiveKit](livekit.md) — voice/video setup
- [Muse Code](muse-code.md) — experimental native adapter and fleet-readiness limitation
- [Current architecture](current-main-architecture.md) — running components and authority boundaries
- [Window manager](window-manager.md) — canvas layers, the fleet HUD, and layout ownership
- [Chat rendering](chat-rendering.md) — chat rows, scrolling, and reader mode
- [Identity and labeling](identity-and-labeling.md) — the shared name and label namespace
- [Notifications and liveness](notifications-and-liveness.md) — notification delivery and daemon liveness
- [Permissions](permissions-implementation-contract.md) — permission resolution and persistence
- [Fleet chat artifacts](fleet-chat-artifacts.md) — shared file materialization and rendering
- [Live deployment](live-deploy.md) — Fly deployment operations

The schemas exposed by the running CLI and MCP server remain authoritative for
exact command/tool arguments.
