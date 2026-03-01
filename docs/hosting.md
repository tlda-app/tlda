# Hosting a Collaborative Paper Review

How to set up and run a collaborative annotation session for your coauthors.

## Prerequisites

**On your machine:**
- **Node.js** 18+ (`node --version`)
- **TeX Live** with `latexmk`, `pdflatex`, `biber`, `dvisvgm` (`brew install --cask mactex` on macOS, or `sudo apt install texlive-full` on Linux)
- **Tailscale** for remote access (`brew install --cask tailscale` on macOS, or [tailscale.com/download](https://tailscale.com/download))

## Setup

```bash
git clone https://github.com/qtm285/tlda.git
cd tlda
npm install
npm link   # installs the `ctd` CLI globally
```

## Add your paper

```bash
ctd create my-paper --title "My Paper Title" --source /path/to/paper/directory --main my-paper.tex
```

This registers the project. The watcher handles compilation automatically.

Verify it works locally:

```bash
ctd server start
ctd watch-all start
ctd open my-paper
```

## Set up Tailscale

1. Install Tailscale and sign in
2. Note your Tailscale IP: `tailscale ip` (a `100.x.y.z` address)
3. Invite collaborators to your tailnet (Tailscale admin console → Users → Invite)

## Start a session

```bash
ctd server start        # unified server on port 5176
ctd watch-all start     # watches all projects for file changes
```

Collaborators open:

```
http://YOUR_TAILSCALE_IP:5176/?doc=my-paper
```

Everything runs on a single port (5176): the viewer, real-time sync, and API.

## Authentication (optional)

By default, auth is disabled — anyone who can reach port 5176 can view and annotate. For remote hosting over Tailscale or a VPS, you probably want tokens.

Two token levels:
- **Read token** — view the paper, connect to sync
- **RW token** — everything: create/edit/delete annotations, trigger builds

Configure via environment variables or `~/.config/ctd/config.json`:

```bash
# Environment variables
export CTD_TOKEN_READ="some-read-token"
export CTD_TOKEN_RW="some-rw-token"
ctd server start
```

```json
// ~/.config/ctd/config.json
{
  "server": "http://localhost:5176",
  "tokenRead": "some-read-token",
  "tokenRw": "some-rw-token"
}
```

When auth is enabled, collaborators pass the token in the URL: `http://HOST:5176/?doc=my-paper&token=TOKEN`. The viewer automatically injects it into all subsequent requests.

To disable auth explicitly (e.g. for local-only use): `CTD_NO_AUTH=1`.

## Collaborative editing

For real-time LaTeX editing, use any editor with live collaboration (e.g. VS Code Live Share, Zed's built-in collab). One person hosts the project, others join. Edits hit the host's filesystem, the watcher picks them up, and viewers update automatically.

The rebuild loop: edit saved → watcher pushes files → server builds (latexmk → dvisvgm → synctex → proof pairing) → signal:reload → viewers hot-swap updated pages.

## Agent integration (optional)

Each collaborator can run their own Claude Code with the MCP server. Point the MCP at the host's Tailscale IP:

```json
{
  "mcpServers": {
    "tldraw-feedback": {
      "command": "node",
      "args": ["/path/to/tlda/mcp-server/index.mjs"],
      "env": {
        "CTD_SERVER": "http://HOST_TAILSCALE_IP:5176"
      }
    }
  }
}
```

This gives the agent access to annotations, highlighting, math notes, pen stroke interpretation, and the review loop. See [docs/ipad-review.md](ipad-review.md) for the full review workflow.

## Share with collaborators

Send this to anyone joining your session:

---

### Joining a review session

1. **Install Tailscale** — [tailscale.com/download](https://tailscale.com/download). Sign in and ask the host to approve you on the tailnet.
2. **Open the viewer** — the host will give you a URL like `http://100.x.y.z:5176/?doc=paper-name`. Open it in any browser.

That's it. You can now:

| Action | How |
|--------|-----|
| Pan | Scroll or drag with hand tool |
| Zoom | Pinch or Cmd+scroll |
| Draw | Select pen tool (or press `d`) |
| Highlight | Select highlighter tool |
| Math note | Press `m`, then click to place |
| Erase | Select eraser tool (or press `e`) |
| Ping | Click the ping button (bottom-right) |
| Proof reader | Press `r` to toggle |

All annotations sync in real time across everyone connected.

**Troubleshooting:**
- Can't connect? Make sure Tailscale is running and you're on the same tailnet.
- Annotations not appearing? Check the browser console for WebSocket errors.
- Page looks stale? The viewer auto-reloads when the paper rebuilds. Try a browser refresh if something seems stuck.

---

## Publish a snapshot

After a review session, bake the current annotations into a static snapshot:

```bash
npm run publish-snapshot -- my-paper
```

This exports annotations and builds a read-only viewer. Anyone with the URL can see the annotated paper without a sync server.

## Data and persistence

- **Annotations** persist in `server/projects/{name}/sync-snapshot.json` on the host. They survive server restarts and browser reloads.
- **Project files** live in `server/projects/{name}/` — source, build output, and metadata.
- **Build output** (SVGs, lookup tables, proof info) is in `server/projects/{name}/output/`.

## Troubleshooting

### Collaborator can't connect
- Both of you need Tailscale running and on the same tailnet
- Check firewall isn't blocking port 5176
- Verify with: `curl http://YOUR_TAILSCALE_IP:5176/health`

### Watcher triggers but nothing updates
- Check `ctd errors my-paper` for build errors
- LaTeX errors won't stop the watcher, but SVGs won't update for pages with errors

### Moving to a server
The whole setup should run fine on a VPS. Install Node + TeX Live, clone the repo, set up Tailscale on the server, and run `ctd server start` + `ctd watch-all start`. Your laptop can sleep while coauthors keep annotating.
