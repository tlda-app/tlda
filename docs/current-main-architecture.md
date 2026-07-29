# Current architecture

This is the developer entry point to the running system. It describes current
source and authority boundaries. Product direction that is not yet implemented
does not belong here.

## Browser application

`src/main.tsx` starts the React application. `src/SvgDocument.tsx` loads the
document into the repository's tldraw fork. Custom shapes under `src/shapes/`
provide notes, chat, search, source editing, document views, terminals, and
other heads-up-display surfaces.

The browser reaches the server through same-origin HTTP and WebSocket routes.
It does not read a local project checkout directly.

## Unified server

`server/unified-server.mjs` owns the viewer, authentication, project and fleet
APIs, WebSocket upgrades, and daemon connections. Larger HTTP surfaces live
under `server/routes/`; persistent project, build, fleet, and transport behavior
lives under `server/lib/`.

The server is authoritative for fleet state and for its replica of each
project. A path on the server is never a substitute for a same-named path owned
by another machine.

## Project source, builds, and history

Project source enters through `server/routes/projects.mjs`.
`server/lib/project-store.mjs` owns the server replica and source transaction
boundary. `server/lib/build-runner.mjs` runs LaTeX builds and records SyncTeX
and build artifacts. `server/lib/ensure.mjs` produces SVG pages on demand.
`server/lib/shadow-repo.mjs` owns server-side document history.

Interactive source edits submit through the same revision-checked transaction:

- a local checkout submits through its machine daemon;
- the browser source editor submits through the server;

Each submission is a checkpoint of source state, not a continuously shared
filesystem. A peer submits when it writes through its source-editing path.

A linked Markdown project uses the same transaction boundary. Its source
manifest contains the main Markdown file, the local Markdown documents it links
to, and their referenced assets. Those files remain ordinary versioned project
source rather than detached chat artifacts.

An Overleaf or Git remote is polled and pushed through a server-owned clone.
That path uses ordinary Git fetch, reset, commit, and push behavior rather than
the symmetric stale-peer contract of an interactive edit. Concurrent remote
edits may therefore require ordinary Git conflict resolution.

The server does not currently push a successful browser edit into an already
linked local checkout. That checkout discovers the newer server revision when
it next submits, then receives a merge conflict to resolve locally.

## Machine daemon

`bin/fleet-daemon.mjs` is the machine boundary. At most one daemon per named
environment on a machine watches that machine's linked source trees and agent
sessions. Its address is `<machine>:<environment>`.

The daemon connects outward to the unified server and executes machine-local
operations such as source synchronization, agent lifecycle, terminal access,
and artifact materialization. If the owning daemon route is unavailable, the
operation fails. The server does not fall back to processing a local lookalike.

## Persistent state and transient signals

Document shapes use Yjs. State that must still be correct after a disconnect
belongs in Yjs, including annotations and the document-version sentinel.

Signals sent over the document WebSocket are transient. They are appropriate
only when missing one is self-correcting, such as an intermediate build-status
update or presenter camera movement. `signal:reload` is transient, but the
persistent document-version sentinel lets a reconnecting viewer detect a
missed reload.

Custom shape schemas are shared protocol. A shape's client props in
`src/shapes/` and its server schema in `server/lib/sync-rooms.mjs` must match
exactly.

## Projects, documents, and navigation

A project is the shared world. A document is a place within that project.
References, chat, search, history, and document views identify both the place
and the relevant version.

Navigation between places is an application operation rather than browser
history. The workspace follows the reader to the destination. Side-by-side
columns are explicit comparison space; ordinary documents are not laid out as
one horizontally pannable sheet.

## Fleet and agent tools

Fleet state lives on the server. `mcp-server/fleet-tools.mjs` exposes
agent-facing collaboration tools. `cli/tlda.mjs` exposes operator commands.
Both resolve the complete named environment selected by configuration.

Agents may run on different machines. Their durable identity and current daemon
route are separate facts. Chat to a hibernating agent is the normal wake path;
hibernation is not a special communication state.

An agent's harness session and transcript persist independently of tlda's
registry pointer to them. A missing resume handle means the registry lost that
pointer; it does not mean the underlying session or transcript was deleted.

## Configuration

`~/.config/tlda/daemon.yaml` selects complete named environments and configures
machine, model, permission, tmux, and task behavior. `server.yaml` contains
server and build settings. `bots.yaml` contains managed bots. `cli.yaml`
contains ordinary CLI preferences. Tokens and other secrets do not belong in
those YAML files.

See [Using tlda](using-tlda.md) for user configuration,
[Hosting tlda](hosting.md) for serving and network boundaries, and the
[permissions implementation contract](permissions-implementation-contract.md)
for internal grant resolution and persistence.
