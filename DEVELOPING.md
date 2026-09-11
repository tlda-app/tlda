# Developing tlda

This is for someone who wants to change the code. If you just want to use tlda
on your own papers, the [README](README.md) is the right document — installing
from Homebrew is much less work than what follows.

Bugs, questions and proposed changes all go to
[GitHub issues](https://github.com/tlda-app/tlda/issues).

## What you need

- **Node 20 or newer.** The native dependencies won't build on anything older.
  Node 22 is the safe choice; 20 and 23 are what the release and deploy pipelines
  use, so they're the best tested.
- **Git.**
- **A TeX distribution** with `latexmk` and `dvisvgm`, if you want to build LaTeX
  papers. On macOS, `brew install --cask mactex-no-gui` gets both. You can skip
  this and still work on everything else — the viewer, the canvas, chat, the
  agent tooling — using a Markdown document instead, which needs no TeX at all.
- **macOS or Linux.** Windows isn't supported: services are supervised through
  `launchd`, agent sessions run in `tmux`, and both assume Unix paths.

Optional, depending on what you're touching: [Quarto](https://quarto.org/) for
slide and HTML documents, and a Chromium for the browser-driven tests.

## Getting it running

```bash
git clone https://github.com/tlda-app/tlda
cd tlda
npm install
```

**`npm install` takes a long time — around fifty minutes on a laptop, and about
620 MB.** It is not stuck. Two things make it slow:

- `@tldraw/editor` is not an npm package here. It is a fork, pinned to one
  immutable commit of the public `tlda-app/tldraw-fork` repository, so npm
  clones and builds it rather than downloading a tarball. The wrapper `tldraw`
  and the editor's sibling packages are the ordinary published 5.2.0 releases,
  and one of them carries a local patch that `postinstall` applies — a context
  mismatch there is an installation failure, not a skipped patch. See
  [the forked tldraw editor](docs/vendored-tldraw-editor.md).
- Several dependencies are native and compile from source, and one of them —
  `better-sqlite3` — will print an "unsupported engine" warning on very new Node
  versions and then build anyway.

There's also a `prepare` script, so `npm install` doesn't only install: it builds
the viewer bundle and copies it into `server/public/`. The last several minutes
of a quiet install are that build.

### Pointing it at something

tlda reads its settings from `~/.config/tlda/`, and a fresh machine has nothing
there. Create the starter files:

```bash
tlda config init
```

```
✓ created /Users/you/.config/tlda/daemon.yaml
✓ created /Users/you/.config/tlda/server.yaml

Environments:
  * local (active)
```

That gives you one environment called `local`, with both of its axes pointed at
`http://localhost:5176` and no tldraw licence key — which is what you want for
development, since the viewer is unrestricted on `localhost`. See
[Environments](docs/environments.md) for what the fields mean and how to add a
second one.

It only writes files that are missing. Running it again over a config you've
edited tells you so and changes nothing:

```
· /Users/you/.config/tlda/daemon.yaml already exists — unchanged
```

Nothing runs it for you. If you see `daemon.yaml not found`, that error names
this command.

Then start the server and the daemon. Both detach and keep running, so you get
your shell back; `tlda daemon run` is the foreground form if you want to watch
it:

```bash
tlda server start
tlda daemon start
```

`tlda doctor` will tell you what's missing if either doesn't come up.

### Seeing a document

The quickest way to have something on screen is a Markdown file, which skips the
whole LaTeX toolchain:

```bash
mkdir -p /tmp/notes && cd /tmp/notes
printf '# Hello\n\nSome math: $e^{i\\pi} + 1 = 0$\n' > main.md
git init -q && git add -A && git commit -qm "first"

tlda project link notes /tmp/notes/main.md --format markdown --title "Notes"
tlda project open notes
```

Two things worth noticing about that. **You link a file, and tlda takes the Git
repository containing it** — that repository is the source of truth, which is why
the `git init` isn't decorative. And the page you're now looking at already has a
version recorded, because the build that produced it committed the sources that
made it; that's true from the very first build of the smallest possible document.

Start the daemon (`tlda daemon start`) and editing `main.md` rebuilds the page
and reloads what's on screen.

## How the pieces fit

Seven things, and it helps to know which one you're in before you start reading.

| Where | What it is |
|---|---|
| `src/` | The viewer — React and tldraw. `SvgDocument.tsx` lays out the document's pages; `src/shapes/` is every custom canvas object (sticky notes, chat panels, the reference viewer); `src/fleet/` is the client half of chat and presence. |
| `server/` | One process. `unified-server.mjs` is the HTTP API, the WebSocket endpoints, and the static host for the viewer, all on one origin. `server/lib/` holds the pieces it coordinates — the build pipeline, the canvas sync rooms, project storage, the per-project version history. |
| `cli/` | `tlda`, the command you type. `cli/tlda-dev.mjs` is the separate developer command, deliberately kept out of the user-facing one. |
| `bin/fleet-daemon.mjs` + `daemon/` | The per-machine bridge. It watches source directories and agent sessions and pushes what it sees to the server, and it handles requests that need access to *this* machine's files and processes. It exists because the server is frequently not on the same machine as the person or the agents. |
| `mcp-server/` | What agents talk to. Every tool an agent has — reading annotations, dropping a note, chatting, subscribing — is defined here. |
| `packages/` | `@tlda/client` and `@tlda/bot`, the two libraries a bot is built on, consumed by path rather than from npm; and `tldraw-wm`, the window manager the canvas lays its panes out with. |
| `shared/` | Code both sides need, most importantly `config.mjs`, which is the only thing that decides what any process talks to. |

One more you'll see: `docs/` is largely a historical record — its own index says
a file's presence there doesn't make it current guidance.

### One thing to know before you trust what you read

The README says it and it matters most here: nearly all of this code was written
by AI agents. So the comments are less reliable than you're used to — most were
written by whichever agent believed it was building that thing, and a fair number
describe an intention rather than what shipped. **When a comment and the code
disagree, believe the code.** When the code and the running application disagree,
believe the application and keep reading, because something you haven't found yet
is producing the behaviour.

Authorship is no better a guide. Most commits are authored under an agent's name
and a large minority carry the repository owner's name for work he didn't write,
so `git blame` tells you who typed a line and nothing about whether a human chose
it.

## Making a change and seeing it

Which loop you want depends on which half you touched.

**Viewer code (`src/`).** Run Vite and get hot reload:

```bash
npm run dev
```

Vite serves the app and proxies the API and WebSockets to a server on
`localhost:5176`, so one has to be running for anything to load — the dev server
replaces the bundle, not the backend. Set `VITE_SERVER_PORT` if yours is
elsewhere.

**Server, CLI, daemon or MCP code.** Nothing hot-reloads; restart the thing you
changed. For the server that's `tlda server stop && tlda server start`. For the
MCP server, an agent picks up your change when its connection is reloaded, not
when you save.

**Anything that risks the data.** Don't develop server or canvas-schema changes
against a store you care about. Stand up an isolated one — its own backend, its
own database, its own projects, its own Vite server, reachable from your phone or
tablet as well as your laptop:

```bash
tlda-dev serve --sandbox
```

It prints a URL and a QR code. `tlda-dev serve stop` when you're done.

A change to a **custom canvas shape** needs care: a shape's properties are
declared in two places, once on the client in `src/shapes/` and once on the
server in `server/lib/sync-rooms.mjs`, and they must match exactly. Adding or
renaming a property on one side only breaks canvas sync for everyone in that
document, so change both together.

## Bots

A bot is a separate program in its own repository — see the README's
[Bots](README.md#bots) section for what they are and how one gets registered.

Two things to know before you edit one.

**Nothing compiles.** A bot is a Node script, and the file on disk is the program
that runs. There is an install step (it depends on `@tlda/bot`, by path, from a
checkout of tlda sitting alongside it) but no build output — so a working copy
*is* a deployment. An edit you think of as a draft is live the moment the process
restarts. Commit before you walk away, or don't leave it edited.

**They're supervised as ordinary services**, not by the app. Nothing starts a bot
implicitly, and stopping the tlda server doesn't stop one.

## Tests

This will look wrong if you've worked elsewhere, so here it is plainly: **nothing
here gates a merge on a test suite.** A push to `main` triggers a build and
nothing else; the release workflow does run the suite on a tag, but it is marked
`continue-on-error`, so a red suite reports and does not stop the release. What
counts as evidence is that you *ran it* — started the app, drove the thing you
changed, watched it behave.

Tests earn their place for one kind of failure: the kind that is both **silent
and damaging**. History that can be lost without anyone noticing; stored state
drifting out of agreement with what's on screen; the collaboration channel going
deaf while still looking fine. A visible annoyance doesn't need one — you'll see
it.

If you fix a bug and an existing test goes red, look hard at the test before you
touch your fix. A test written against buggy behaviour was pinning the bug in
place, and deleting it is the right move.

Mechanically: the checks live in `test/`, `tests/` and a large number of
single-purpose scripts under `bin/`, and each is a plain Node script you run
directly — `node tests/whatever.test.mjs` works, since they use Node's built-in
test runner and there's no harness to install.

`npm run lint` runs a handful of repo-specific guards and then ESLint. **The
guards are the part that means anything**; ESLint currently reports a few
thousand pre-existing problems across the tree, so a clean run is not something
you can get to and a failure is not something you caused. Read its output for
the files you touched and ignore the rest.

## Releasing

A release is a tag, and `bin/release.sh` is the whole procedure:

```bash
./bin/release.sh v0.4.0 --dry-run   # preflight only, changes nothing
./bin/release.sh v0.4.0
```

The dry run is worth doing first, because the preflight is where a release
normally stops. It refuses unless the tag matches the version in `package.json`,
the checkout is clean, you are on `main`, `origin` is `tlda-app/tlda`, the tag is
unused both locally and on the remote, and your `HEAD` is exactly what
`origin/main` points at.

Past the preflight it tags and pushes, and the tag triggers the release workflow:
build the viewer, run a short verification suite, pack a source tarball with the
built bundle in it, and create the GitHub release with
`.github/release-notes-v0.4.0.md` as the body. The script waits for that release
to carry its tarball — up to five minutes — then downloads it, computes the
sha256, writes the URL and checksum into the Homebrew formula in the tap
checkout at `~/work/homebrew-tlda`, and pushes the tap.

So the tarball asset is load-bearing twice over: it is what the formula points
at, and its arrival is the signal the script waits on. A release that publishes
without one leaves the script polling until it times out, and leaves Homebrew on
the previous version. `homebrew/tlda.rb` in this repository is the formula's
source; the tap repository is what `brew` actually reads.

Releasing needs the `gh` CLI, authenticated, and the tap checked out beside this
one.

Deploying the project's own hosted instances is separate from cutting a release,
and is documented in [`docs/live-deploy.md`](docs/live-deploy.md).
