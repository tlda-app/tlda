# Hosting a Collaborative Paper Review

How to set up and run a collaborative annotation session for your coauthors.

## Prerequisites

**On your machine:**
- **Node.js** 20+ (`node --version`)
- **TeX Live** with `latexmk`, `pdflatex`, `dvisvgm` (`brew install --cask mactex` on macOS, or `sudo apt install texlive-full` on Linux)
- **Tailscale** for remote access (`brew install --cask tailscale` on macOS, or [tailscale.com/download](https://tailscale.com/download))

## Setup

```bash
git clone https://github.com/qtm285/claude-tldraw.git
cd claude-tldraw
npm install
```

## Add your paper

```bash
./build-svg.sh /path/to/your-paper.tex my-paper "My Paper Title"
```

This compiles your LaTeX to SVG pages, extracts math macros for KaTeX rendering, and registers the document. Takes a minute or two on first run.

Verify it works locally:

```bash
npm run start
# Open http://localhost:5173/?doc=my-paper
```

## Set up Tailscale

1. Install Tailscale and sign in
2. Note your Tailscale IP: `tailscale ip` (a `100.x.y.z` address)
3. Invite collaborators to your tailnet (Tailscale admin console → Users → Invite)

## Start a session

```bash
# Start everything: viewer, sync server, MCP, and file watcher
npm run collab -- --watch /path/to/your-paper.tex my-paper
```

This prints your Tailscale and LAN URLs. Collaborators open:

```
http://YOUR_TAILSCALE_IP:5173/?doc=my-paper
```

### What's running

| Service | Port | Purpose |
|---------|------|---------|
| Vite dev server | 5173 | Serves the viewer app |
| Yjs sync server | 5176 | Real-time annotation sync |
| MCP HTTP | 5174 | Agent integration (highlights, notes) |
| MCP WebSocket | 5175 | Forward sync (agent → viewer) |
| File watcher | — | Auto-rebuilds on .tex changes |

### Without the file watcher

If you don't need auto-rebuild (e.g. the paper isn't changing):

```bash
npm run collab
```

Or start services individually:

```bash
npm run sync    # Just the annotation sync server
npm run dev     # Just the viewer
```

## Collaborative editing

For real-time LaTeX editing, use [Zed](https://zed.dev/)'s built-in collaboration. One person hosts the project, others join. Edits hit the host's filesystem, the watcher picks them up, and viewers update automatically.

The rebuild loop: edit saved → latexmk (~5s) → priority pages converted → partial reload → remaining pages → full reload. Synctex lookup updates after 30s of quiet.

## Agent integration (optional)

Each collaborator can run their own Claude (or other agent) with the MCP server. Point the MCP at the host's Tailscale IP:

```json
{
  "mcpServers": {
    "tldraw-feedback": {
      "command": "node",
      "args": ["/path/to/claude-tldraw/mcp-server/index.mjs"],
      "env": {
        "SYNC_SERVER": "ws://HOST_TAILSCALE_IP:5176"
      }
    }
  }
}
```

This gives the agent access to annotations, highlighting, math notes, and pen stroke interpretation.

## Publish a snapshot

After a review session, bake the current annotations into a static site and deploy to GitHub Pages:

```bash
npm run publish-snapshot -- my-paper
```

This exports annotations from the sync server, builds the viewer, and deploys. Anyone with the GitHub Pages URL can see the annotated paper (read-only, no sync server needed).

## Data and persistence

- **Annotations** persist in `server/data/*.yjs` on the host machine. They survive server restarts and browser reloads.
- **Rooms** are isolated annotation spaces. Default is `doc-{paper-name}`. Use `?room=custom-name` for separate sessions.
- **SVG pages** are in `public/docs/{paper-name}/`. Rebuilt by the watcher or `build-svg.sh`.

## Troubleshooting

### Collaborator can't connect
- Both of you need Tailscale running and on the same tailnet
- Check firewall isn't blocking ports 5173/5176
- Verify with: `curl http://YOUR_TAILSCALE_IP:5173/`

### Watcher triggers but nothing updates
- Check the watcher output for build errors
- LaTeX errors won't stop the watcher, but the SVGs won't update
- Run `./build-svg.sh` manually to see full error output

### Slow rebuilds
- First build is slow (full latexmk + all auxiliary files)
- Subsequent builds reuse aux files — typically one latex pass (~5s)
- Synctex extraction is debounced (30s default, set `SYNCTEX_DEBOUNCE_MS`)

### Moving to a server
The whole setup runs fine on a VPS. Install Node + TeX Live, clone the repo, set up Tailscale on the server, and run `npm run collab`. Your laptop can sleep while coauthors keep annotating.
