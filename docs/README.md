# Documentation map

This directory contains both current guidance and historical engineering
records. A file's presence under `docs/` does not make it current operating
instruction.

## Current guidance

- `../README.md` — product overview and user setup
- `live-deploy.md` — current live deployment runbook
- `hosting.md` — serving privately and deploying the live Fly application
- `local-configuration.md` — named configs, daemon profiles, and managed bots
- `skill-lanes.md` — current skill distribution and project-lane mechanism
- `permissions.md` — current agent permission model
- `fleet-chat-artifacts.md` — current cross-machine chat artifact contract
- `fleet-query-language.md` — current public fleet query language
- `spawn-machine-privileges.md` — current machine-local spawn privilege model
- `source-ownership-manifest-transaction.md` — accepted under-review source
  ownership and complete-manifest transaction contract
- `testing-fleet-shapes.md` — current browser-testing and cleanup contract
- `fleet/agent-guide.md` — current agent fleet workflow
- `fleet/managing-agents.md` — current manager fleet workflow

The project `AGENTS.md` remains the authoritative project operating contract.
The schemas exposed by the running CLI and MCP server remain authoritative for
exact command/tool arguments.

## Historical records

All other files in this directory are evidence of a proposal, audit, incident,
implementation packet, handoff, release state, or observed snapshot unless
their header explicitly says otherwise. They may explain why current code looks
the way it does, but they are not a task queue and must not override current
code, current fleet state, or a later correction.

When preserving a historical record, do not mechanically update its old command
names or architecture into present tense. Add a visible historical banner and a
pointer to the current replacement instead.
