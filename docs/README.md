# Documentation map

This directory contains the public user and operator documentation included in
the release archive.

## User documentation

- [README](../README.md) — product overview and short setup path
- [Using tlda](using-tlda.md) — canonical user behavior: project linking and history,
  identity, Markdown, search, agents, permissions, and local configuration
- [Hosting tlda](hosting.md) — serving privately and deploying the live Fly application

## Operator reference

- [Document formats](document-formats.md) — LaTeX, Markdown, Quarto, and PDF inputs
- [LiveKit](livekit.md) — voice/video setup
- [What the promote endpoint does](promote-endpoint-what-it-does.md) — preconditions
  and effects of `POST /api/projects/:name/promote`
- [`serve --sandbox` and the project verbs](serve-sandbox-does-not-reach-the-project-verbs.md)
  — the sandbox isolates the server; the `project` verbs do not follow it

The schemas exposed by the running CLI and MCP server remain authoritative for
exact command/tool arguments.
