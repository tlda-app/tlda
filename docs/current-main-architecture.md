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

Format-specific builders share the same project record and output manifest:

- LaTeX builds to SVG pages and SyncTeX source positions.
- Markdown source is rendered to HTML on the server.
- Quarto source is rendered on the server; the rendered HTML determines whether
  it is served as a scrolling document or split into RevealJS slides.
- Pre-rendered HTML and RevealJS projects arrive with their assets. The server
  copies and indexes them without running their source renderer.
- A book is a navigation grouping over existing projects. Its members retain
  separate source, history, sync rooms, and annotations.

`page-info.json` is the common page manifest consumed by the browser's HTML and
slide loaders. A Quarto render produces it after inspecting the output;
pre-rendered HTML may supply it, while the server otherwise derives it from the
top-level HTML files.

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

### A deployed sha says nothing about the code a daemon is running

Every environment's daemon executes the same file out of Skip's shared checkout.
All three LaunchAgents — `com.tlda.fleet-daemon.testing`, `.stable`, and `.pic` —
run `/Users/skip/work/tlda/bin/fleet-daemon.mjs`.

So a daemon runs **whatever the working tree held when its process started**. It
does not track `main`, it is not shipped by a deploy, and a commit's presence in
a deployed server tree is not corroboration for anything a daemon does. Restart
is the only thing that changes daemon-loaded code.

This is `AGENTS.md` §"Verify the relevant surface" pointing the other way: a
deployed sha is not a loaded module, and here the mismatch is invisible from any
sha at all. One daemon carried 34 hours of staleness that nothing could reveal.

### Which environment owns a checkout is decided by the binding files

`~/.config/tlda/source-bindings.<environment>.json` is the authority. A daemon
watches the checkouts bound in its own environment's file, so `tlda --env
<name> project link` and `tlda --env <name> project unlink` are the operations
that move a project between environments.

`~/.config/tlda/project-worlds.json` maps a checkout path to one environment
name and looks like it decides the same thing. **It does not. It is inert**,
and editing it to unstick a move accomplishes nothing:

- `writeProjectWorld` in `shared/project-worlds.mjs` is exported and has no
  caller in the repository, so nothing maintains the file.
- `projectBelongsToWorld` returns `true` whenever `project.sourceDir` is falsy.
  The projects it filters come from `loadLocallyBoundProjects`, which builds
  them from the server's `/api/projects/<name>`, and that payload carries no
  `sourceDir`.
- The daemon logs the filter's result on every application, and it is always
  N/N — `project ownership applied (daemon-welcome): 16/16 projects in
  testing`. It has never excluded a project.

What the file still does is raise `invalid-project-source-environment-owner`
when it names an environment that `daemon.yaml` does not configure. That
warning is real; the ownership filter behind it is not.

### A daemon message is acknowledged when the dispatcher returns, not when it is handled

`handleDaemonOutboxEnvelope` in `server/lib/daemon-ws-control-plane.mjs:187`
awaits the message handler, and if that call returns without throwing it marks
the message processed and sends a positive ACK. **A message whose type nothing
matches returns normally**, so it is acknowledged exactly like one that was
acted on. Only a thrown error produces an error ACK.

This is the vocabulary collapse `AGENTS.md` §"Fleet communication uses mail
words" warns about, in the daemon transport: the ACK reports that the dispatcher
did not fail, and it is read as evidence the work happened. **Adding a message
type without adding its handler is therefore silent in both directions.**

**The instance that proved it, and the shape of its fix.** From 2026-08-10 the
daemon sent `adopt-shadow-history` on every source link and no server received
it: the wire name occurred once in the whole tree, at the send site, and
`adoptShadowHistory` had no caller. Every moved project lost its history, and
the transport reported success throughout.

`9983c2cd8` fixed it, and **how** is the part worth keeping. The confirmation
could not be an ACK — the outbox ACK travels its own path keyed by `outbox_id`
and would acknowledge a message the handler never saw, which is exactly what
shipped the defect. So the link's gate is a reply that **only the handler can
send**, carrying the version count the server read back off its own disk after
adopting (`server/unified-server.mjs:9146`). The binding is written after the
history lands, so a failed link leaves no row rather than needing a rollback path
that can itself fail.

**The general rule above is unchanged and still live:** the transport still
acknowledges every envelope it accepts, including one whose type no handler
claims. Anything that needs to know the work happened must carry an answer from
the handler.

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

### An unsynced edit exists only in memory

The client calls `useSync` (`src/SvgDocument.tsx`) with no `persistenceKey`, and
there is no IndexedDB and no `localStorage` copy of document content anywhere in
the client. While sync is down, an edit lives in the tab's heap and nowhere else:
a refresh loses it, and so does closing the tab.

`EmergencyDumpButton` in the table-of-contents panel is the exit — it reads
`editor.store` locally and downloads a Markdown file with no network in the path.
It exists because Skip spent fifteen minutes hand-copying stranded iPad notes on
2026-08-12, screenshots being the only alternative he could find.

**It is inside the canvas UI, so it is absent from the fatal-error screen**
(`src/SvgDocument.tsx`, `storeWithStatus.status === 'error'`), which replaces the
editor entirely while the unsynced shapes are still in the store.

### A schema change on deploy stops a long-lived tab forever

`@tldraw/sync` retries a lost connection indefinitely — 500 ms to 2 s while the tab
is visible, 1 s to **5 minutes** while it is hidden, reset to the minimum by
`online`, `visibilitychange`, and `navigator.connection` change.

There is one exception and it is permanent. On a close with code 4099
(`TLSyncErrorCloseEventCode`), `useSync` sets an error state and calls
`socket.close()`, disposing the reconnect manager. Nothing retries, ever, short of
a page reload. `TLSyncRoom` sends that code for `CLIENT_TOO_OLD`, `SERVER_TOO_OLD`,
and `INVALID_RECORD`, all of which a shape-schema change on deploy can produce.

We deploy several times a night and tabs stay open for days, so this is a standing
hazard rather than a hypothetical: **changing a custom shape's props is also a
change that can permanently disconnect every tab already open.**

## Projects, documents, and navigation

A project is the shared world. A document is a place within that project.
References, chat, search, history, and document views identify both the place
and the relevant version.

Navigation between places is an application operation rather than browser
history. The workspace follows the reader to the destination. Side-by-side
columns are explicit comparison space; ordinary documents are not laid out as
one horizontally pannable sheet.

**The map is the canvas, zoomed out. It is not a component.** Skip has specified
this repeatedly and it has been reimplemented as a custom widget each time, which
is why it keeps being wrong. His words:

> the fucking map is just the fucking entire canvas or zo[omed out] … That's the
> fucking map. The inset is just a fucking picture in picture view of the canvas
> at that fucking Zoom level,

> Not complicated,

> Not a custom component. Just that,

And when he first specified it, 7/29 21:44 → `chief13`, verified against the
event record:

> Oh, also, obviously, we don't want a map button. In the project tab. Come on,
> guy. I mean, you know me better than that. What we want is a picture in picture
> viewer. Of the fucking map.

> Like, right now, we have this sort of go return notion So I guess go on the
> picture in picture viewer that is the map … zooms the fuck out. … And then gives
> you an arrow to return.

> I thought the map was just gonna be the canvas zoomed out.

So: the Project tab carries an always-present picture-in-picture of the canvas at
a zoomed-out level. Go zooms the main canvas out to it; a return arrow restores
the prior view. There is no separate map document, no boxes with titles, and
nothing to build that renders a project some other way.

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

## Addressing and subscribing are orthogonal

Two independent questions, and conflating them corrupts the app's behaviour.

**Addressing** is who a message is for. The sender writes an expression —
`helm`, `awake`, `a & !b` — and that expression is a fact about the message.
It is the same for every reader, it does not change afterwards, and it is what
the interface means by "to".

**Subscribing** is who hears it. Anyone can hear anything here; there is no
permission attached to reading. Hearing is therefore a relation between a
message and a reader, computed per reader, and it changes as labels and
subscriptions change. It is not a property of the message and it must not be
stored as one.

That you hear what is addressed to you is a **convention**, not a necessity —
it is the default subscription every agent is given, and an agent may remove
it and go silent deliberately. Nothing about being addressed forces delivery;
the addressing is the fact, the delivery is a consequence of a subscription
that happens to match it.

So an event records the address. Who heard it is answered by evaluating
subscriptions, per reader, at read time. An observer's subscription matching
must never write that observer into the message's address, and a list that
merges the two answers neither question.

Because the two are orthogonal, the combinations that look strange are all
representable, and the system does not forbid them:

An agent may **unsubscribe from messages addressed to it** while subscribing to
messages addressed to some other agent — to watch what is happening to that
agent instead of to itself. It is still addressed by everything that names it;
it simply hears none of it. That is a weird choice, and it puts the agent
somewhere its behaviour cannot be corrected, because it will not hear the
correction. It is not forbidden. Silence you chose is allowed.

The more natural version of the same intent is not to unsubscribe at all, but
to change the **notification policy** on the subscription to its own messages,
and its inbox view: the messages are still received, just backgrounded. Whether
something interrupts you is a property of the subscription, not of the
addressing — which is why the two must stay separable.

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
