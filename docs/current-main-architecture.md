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

`tlda project link` is the create/relink command. The CLI first proves the
current directory is a Git repository with `git rev-parse --show-toplevel`,
resolves positional arguments as document roots, creates or updates the project
through the server API, and calls the local daemon with `project-source-link`.

The daemon seeds existing project history by configuring a `tlda` Git remote for
the server's `/git/<project>` endpoint and pushing the chosen revision to the
history seed ref. After the server adopts that ref, the daemon writes the local
binding, sends `source-bindings-set` to the server, starts the Git manager, moves
the checkout onto `refs/heads/tlda/<project>` when Git can do that without
forcing local state, and submits the current tree. If the branch move is refused,
the link remains in place and the daemon reports which branch to check out.

Each settle from that branch creates two commits with ordinary Git plumbing. A
temporary index stages tracked changes with `git add -u`, `git write-tree` and
`git commit-tree -m "tlda settled edit cluster"` create the author's branch
commit, then the document-root dependency closure is written as
`git commit-tree -m "tlda project revision"` on `refs/tlda/project/<project>`.
The daemon updates `refs/heads/tlda/<project>`, resets the real index mixed to
that branch, and pushes the revision to
`refs/tlda/proposals/<daemon>/<branch>/<revision>` on the server.

`tlda project add <file...>` widens an existing binding rather than replacing
it. The CLI resolves each argument against `git rev-parse --show-toplevel` and
refuses a path outside it; with `--from <branch>` it runs
`git checkout <branch> -- <path>` for a file the working tree does not have, and
refuses rather than overwriting one it does; it runs `git add -- <path>` when
`git ls-files --error-unmatch` says the file is untracked; then it
read-modify-writes the record through `PATCH /api/projects/:name/document-roots`
with the existing roots followed by the new ones, and calls the daemon with
`project-source-link` for the same `sourceDir` — no unlink, no `seedBranch` or
`seedRevision`, so `refs/heads/tlda/<project>` and the revision chain are
untouched. A file that is already a root writes nothing.

**Staging and declaring do two different jobs, and both are needed.** The settle
stages tracked changes only, so an untracked file is not in the settled tree —
and the roots the revision is built from are **computed from that tree** by the
include graph in `documentRootsIn`, not read from the stored declaration. The
stored declaration is what the server renders from: `latexDocumentRootPaths` in
`build-runner.mjs` takes it as the render entry points, and `/:name/files` builds
its document list from it. So `git add` is what puts the file in the revision,
and the `PATCH` is what makes the server treat it as a document of the project.
The order matters in the other direction too: `filteredProjectCommit` throws
`configured document root is absent` for a declared root that is not in the
settled tree, and that throw is caught at warn, so declaring before staging stops
the project syncing silently.

When the server reports a different accepted head, the daemon fetches or records
that head and runs Git's merge machinery against the local revision. A clean
merge is committed and pushed as a combined proposal. Conflicted paths,
unresolved files from `git diff --name-only --diff-filter=U`, or an existing
`MERGE_HEAD` stop submission and leave the checkout for ordinary Git resolution.
The server does not silently overwrite a linked local checkout with a browser
edit.

### What the sync path currently logs

Read from the code and quoted as it is written, 2026-09-02. **The sync path logs
failures and is silent on success**, so the log answers "did something go wrong"
and does not answer "did my edit get picked up".

The daemon writes to `~/.config/tlda/fleet-daemon<env-suffix>.log`, which
`tlda daemon log` tails. (`tlda logs` is listed in `TOP_LEVEL_COMMANDS` and has
no case in the dispatch switch, so it falls through to the general help — it
reads nothing.) On the settle path the daemon emits, all prefixed with the
project name:

| line | level | when |
| --- | --- | --- |
| `proposal not accepted: <status>` | warn | `settle()` returned `ok: false` — `WrongHead`, `conflict-held`, `merge-in-progress`, `empty-checkout` |
| `proposal failed: <message>` | warn | `settle()` threw |
| `holding — the accepted source and this checkout both changed <paths>` | warn | the local revision and the accepted head conflict; both sides are kept |
| `not in the revision — tracked, but no document root reaches them: <paths>` | warn | a tracked file no root's closure includes |
| `<root> references <path>, which is present but untracked — it joins the revision once it is staged` | info | a closure member that is in the tree but not in the index |
| `<root> references <path>, which is not in the project — leaving it out of the revision` | info | a closure member that is not there at all |
| `announced <a>, fetched <b>` | info | the fetched revision is not the announced one |
| `this checkout has a branch named "tlda", which blocks the branch tlda/<project>` | warn | the work branch cannot be created |
| `could not adopt the work branch <ref>: <message>` | warn | the branch move failed |
| `source watcher failed` / `remote Git poll failed` | warn | the watcher or the remote bridge errored |

**A settle that works writes no line at all.** `settleEditCluster` in
`git-sync-manager.mjs` is the one settle path — the watcher reaches it through
the debouncer and the startup sweep reaches it directly — and on `result.ok` it
clears its dedup marker and reports dropped documents without logging. So a
successful submission is visible in the refs and in the server's record, and
nowhere in the daemon log.

A refusal is also reported off the machine, through `onSyncRefused`, but only
under two conditions that are easy to mistake for the report being broken: it is
**deduplicated** on `status`/`head`/`reason`, so a project refusing on every
settle reports once; and it fires **only when a person's edit triggered the
settle**, never from the startup sweep, because a binding parked on the wrong
branch with nobody editing is an inventory question rather than lost work. That
narrowing is deliberate — reporting from the sweep put 42 messages in one chat in
90 seconds.

Server-side, build output is relayed to the server process log as
`[build:<project>] <line>`, and the browser-editor leg logs under
`[source-room] <project>`, again on failure paths. **The durable per-revision
record is not a log**: `recordRevisionPhase` writes each revision's phases and
states into the project's `.source-lifecycle` store, which is what
`projectRevisionStatus` reads. A question about what happened to one revision is
answered from there, not from the log.

**Not established here:** whether the revision the viewer actually served is
recorded anywhere. It is not in the lines above, and this section does not claim
either way.

`tlda project remote add`, `delete`, `pull`, `push`, and `checkout` are literal
Git remote operations from the daemon checkout. `add` runs `git remote add`;
`pull` fetches the named branch into `refs/remotes/<remote>/<branch>` and merges
it; `push` pushes the selected commit to `refs/heads/<branch>`; `checkout`
fetches, checks for a dirty checkout, checks out the tracking branch, and then
submits through the same project path. The automatic bridge uses the same Git
remote path: it polls the remote branch, records it at
`refs/tlda/remote/observed`, merges it locally when it moved, and pushes accepted
revisions only when the remote head is an ancestor.

`tlda project merge` is the route out. `GET /api/projects/:name/shadow/bundle`
answers `git bundle create --all` over the project's shadow repository, resolved
through `shadowRepoDir` — which is `liveProjectDir`, not the build-instance
`projectDir` override — and the CLI clones that bundle into a temporary
directory. `server/lib/merge-replay.mjs` then does the replay, and it is one
module the CLI and the server both call rather than two implementations.

The shadow is built by `git clone` plus `git-filter-repo --path`, which rewrites
every commit, so it shares no commit identity with the author's repository and
nothing in it can merge by Git identity. The replay is scoped to the paper with
the pathspec `-- . :(exclude,top).gitignore :(exclude,top)CLAUDE.md`, applied to
the pairing and to `format-patch` on both sides, because `writeShadowGuardFiles`
commits those two files into every shadow and the first `Build at …` commit then
deletes the `CLAUDE.md` — see
[Source authority](source-authority-state-machine.md) §"The shadow's own
bookkeeping is not the paper". The replay pairs commits by
`git patch-id --stable` over `git log -p` on both sides in one pipe, and what is
still owed is exactly the source commits whose patch-id is not already on the
target branch — the same computation on the second run as on the first, with no
base recorded anywhere. Each owed commit is written out with
`git format-patch -1 --stdout --no-signature --keep-subject --binary` (plus
`--root` for a root commit), the source objects are fetched into the target
under `refs/tlda/merge-source/<oldTip>` so `--3way` has the preimage blobs, and
`git worktree add --detach` creates a scratch worktree at the target branch's
current tip. Patches are applied there one at a time with `git am -k --3way`.

The real branch moves only after the whole sequence lands: `git merge --ff-only`
when the target branch is the checked-out one, `git update-ref refs/heads/<branch>
<new> <old>` — a compare-and-swap — when it is not. `git am` is not atomic, so
without the scratch worktree a failure on patch five would leave patches one
through four on the branch. On a conflict in the default mode the state file
`tlda-merge.json` and the patch directory are left in the target's git directory
for `--continue`, `--status` and `--abort`; with `--ff-only` the `am` is aborted,
the scratch worktree removed, and the branch is left exactly where it was.

The server-side call site is specified but not written; the CLI is the only
caller today. See
[Source authority](source-authority-state-machine.md) §"The two that block the
server call site".

## Machine daemon

`bin/fleet-daemon.mjs` is the machine boundary. At most one daemon per named
environment on a machine watches that machine's linked source trees and agent
sessions. Its address is `<machine>:<environment>`.

The daemon connects outward to the unified server and executes machine-local
operations such as source synchronization, agent lifecycle, terminal access,
and artifact materialization. If the owning daemon route is unavailable, the
operation fails. The server does not fall back to processing a local lookalike.

### A deployed sha says nothing about the code a daemon is running

Each environment's daemon runs whatever `bin/fleet-daemon.mjs` its own service
definition points at, and different environments may point at different
checkouts. Read the active service definition rather than assuming the shared
checkout is the code a daemon loaded.

So a daemon runs **whatever the working tree held when its process started**. It
does not track `main`, it is not shipped by a deploy, and a commit's presence in
a deployed server tree is not corroboration for anything a daemon does. Restart
is the only thing that changes daemon-loaded code.

This is `AGENTS.md` §"Verify the relevant surface" pointing the other way: a
deployed sha is not a loaded module, and here the mismatch is invisible from any
sha at all. One daemon carried 34 hours of staleness that nothing could reveal.

### A field on the daemon wire is removed in three deploys, or it is removed in production

The section above says a daemon runs whatever its working tree held when it
started, and that restart is the only thing that changes that. The consequence
nobody had written down: **the server and the daemon are never at the same commit
at the same moment**, they skew on every deploy in an order nobody chooses, and
both orders have shipped here.

So a field in a `source-change` — or any message either half sends the other —
cannot be removed in one change. It comes out in three, each its own deploy:

1. the **receiver stops requiring** it, and does the right thing when it is absent;
2. the **sender stops sending** it;
3. the **receiver stops reading** it, and the parameter, its validation and its
   stored form are deleted.

Doing (3) first, or all three at once, breaks whichever half deploys second, for
however long the window between them lasts.

**This is not a compatibility shim and it must not be argued down as one.**
`AGENTS.md` says this project does not preserve deprecated aliases, and says our
client/server line is ours to move because both processes are ours. Neither of
those says the two processes restart together, and this one does not: a server
deploy replaces a machine, and a daemon changes code only when someone restarts
it. Step 1 is not kept around — it exists for one deploy window and is deleted by
step 3.

The rule earned itself on `sourceManifest`. Removing it looked like one deletion
until the same question was asked of the *sender*, at which point it was three
changes across two processes and a design dependency — the daemon proposing a
commit — that did not exist yet.

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

#### The other direction fails differently, and neither direction reports it

`handleServerMessage` in `bin/fleet-daemon.mjs` ends its dispatch chain with
`// Unknown message — ignore for forward compatibility.` (`:1713`), and the daemon
acks a server-originated outbox message only from inside a matched handler
(`:1673`, `:1688`). So the two directions of the same namespace fail in opposite
ways, and knowing which one you are looking at decides what evidence exists:

- **daemon→server:** an unhandled type is positively acked and marked processed.
  False success, no trace anywhere.
- **server→daemon:** an unhandled type is never acked, so its
  `server_daemon_outbox` row never clears and `pendingForDaemon` keeps returning
  it — every flush re-sends it. No false success, but an unbounded redelivery
  with no attempt cap and no dead-letter path in
  `server/lib/server-daemon-outbox.mjs`.

**Tolerating an unknown type is correct and must stay.** §"A deploy ships the
server. It does not ship the daemons" in [Fly deployment](live-deploy.md) is why:
the two halves version-skew on every deploy, in an order nobody chooses, and both
directions of skew have shipped. A dispatcher that rejected an unrecognised type
would turn each deploy window into an outage. The comment is original to the
first daemon-WS commit (`1d0bc5afd`, 2026-04-10) and the reason it gives is the
right one.

**What is wrong is the silence, not the tolerance** — and the same repository
already contains the alternative. An unknown *RPC verb* is tolerated and still
answered: `daemon/machine-rpc.mjs:148` replies `unknown op: ${op}` without
crashing. The RPC namespace is therefore the shape to copy — report the
unmatched name, keep accepting the connection. Until then the cost is the one
[Fly deployment](live-deploy.md) already names for the half-live case: *"the pair
reads as working while being half-live."*

Four types in this namespace are currently one-sided: `prompt-auto-accepted`
(three senders in `daemon/`, no handler — and it is in `DURABLE_TYPES`, so it is
persisted, retried across reconnects, and positively acked by a server that
cannot act on it), `daemon-sync-ok`, `reaper-status`, and `agent-activity`
(handlers with no sender).

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
It provides a recoverable export when unsynchronized annotations are stranded in
the browser.

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

Two things follow that are easy to get wrong in opposite directions.

**The remedy on offer is destructive and the problem is not.** A stranded tab is
running older code than the server. Nothing is broken and nothing needs clearing,
yet the error surface carries a "Clear broken shapes" action. A version mismatch
is the one case where deleting the user's shapes cannot be the answer, because
their work is intact on both sides of the wire.

**And the fix is not to reload the tab.** An open tab must never reload under
someone — see the deploy runbook and the ruling behind it. What a stranded tab can
honestly do is say what happened, keep the work readable, and leave the timing to
the person: this tab is running code older than the server, nothing is lost, open
a new one when it suits you.

The other half is prevention, and it is already in place: a shape's props are
defined once in `shared/shapes/` and imported by both the client utility and the
server schema, so the two cannot drift apart by being edited separately. A new
custom shape that defines its props twice reintroduces this class.

## Projects, documents, and navigation

A project is the shared world. A document is a place within that project.
References, chat, search, history, and document views identify both the place
and the relevant version.

Navigation between places is an application operation rather than browser
history. The workspace follows the reader to the destination. Side-by-side
columns are explicit comparison space; ordinary documents are not laid out as
one horizontally pannable sheet.

**The map is the canvas, zoomed out. It is not a separate component.** The
Project tab carries an always-present picture-in-picture of the canvas at a
zoomed-out level. Go zooms the main canvas out to it; a return arrow restores
the prior view. There is no separate map document or parallel representation
of the project.

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
