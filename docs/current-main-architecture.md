# Current architecture

This is the short developer entry point to the current system. It names source
boundaries rather than intended future components.

## Browser application

`src/main.tsx` starts the React application. The document surface uses the
repository's `tldraw` fork; `src/SvgDocument.tsx` renders server-produced SVG
pages and the custom shapes under `src/shapes/` supply notes, chat, references,
video, and other HUD objects. Browser code reaches the server through
same-origin HTTP and WebSocket routes.

## Unified server

`server/unified-server.mjs` is the running application server. It owns the
viewer, authentication, project and fleet APIs, WebSocket upgrades, and
machine-daemon connections. Larger HTTP surfaces are split into
`server/routes/`; persistent project/build behavior is under `server/lib/`.

The server is the authority for fleet state and for its replica of each
project. It does not treat a same-named local path as a substitute when the
daemon that owns that path is unavailable.

## Document build and history

Project source enters through `server/routes/projects.mjs`.
`server/lib/build-runner.mjs` runs the LaTeX build and records SyncTeX/build
artifacts. SVG pages are produced on demand through `server/lib/ensure.mjs`.
`server/lib/shadow-repo.mjs` owns server-side build history and the optional
mirror-back transaction to connected source daemons.

## Machine daemon

`bin/fleet-daemon.mjs` is the machine boundary. One daemon per named
environment watches that machine's linked source trees and agent sessions,
connects to the unified server, and executes machine-local RPC. The server
routes a machine-local operation to the owning daemon; an unavailable route is
an error, not permission to execute against a server-local lookalike path.

## CLI and agent tools

`cli/tlda.mjs` is the operator CLI. `mcp-server/fleet-tools.mjs` exposes the
agent-facing fleet tools and sends their operations through the same server.
Named environments select the complete database/store target used by both.

For the setup paths around these boundaries, see
[project linking](project-linking.md), [local configuration](local-configuration.md),
and [hosting](hosting.md).
