# Collaborator Setup Guide

Join a shared annotation session where you can review documents together in real time. The host runs the server; you just need a way to reach it and a browser.

## Connecting

The host will give you a URL. It looks like one of:

- **Local/Tailscale**: `http://100.x.y.z:5176/?doc=paper-name`
- **Hosted (Fly)**: `https://tldraw-sync-skip.fly.dev/?doc=paper-name`

If the host uses Tailscale, you'll need to install it first:

**Mac:** `brew install --cask tailscale`
**Linux:** `curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`
**Windows:** [tailscale.com/download](https://tailscale.com/download)

Sign in and ask the host to approve you on their tailnet. Then open the URL in any browser (Safari, Chrome, Firefox — all work, iPad included).

## What you can do

| Action | How |
|--------|-----|
| Pan | Scroll or drag with hand tool |
| Zoom | Pinch or Cmd+scroll |
| Draw | Select pen tool (or press `d`) |
| Highlight | Select highlighter tool |
| Math note | Press `m`, then click to place. Type `$\LaTeX$` for math. |
| Erase | Select eraser tool (or press `e`) |
| Text select | Press `t`, drag over text |
| Ping | Click the ping button (bottom-right) — gets agent attention |
| Proof reader | Press `r` to toggle (LaTeX docs) |

All annotations sync in real time across everyone connected.

## Hosting your own

To run the server yourself with your own documents:

```bash
# Install
npm install -g github:qtm285/tlda

# Add your paper
tlda server start
tlda create my-paper --dir /path/to/tex/project --main paper.tex

# Or other formats
tlda create notes --dir ./notes/ --format markdown
tlda create deck --dir ./slides/ --format slides

# Start watching for changes
tlda watch-all start

# Open in browser
tlda open my-paper
```

For remote access, use Tailscale or similar (Wireguard, Cloudflare Tunnel, etc.) to make port 5176 reachable. See [hosting.md](hosting.md) for auth tokens, agent integration, and deployment details.

## Troubleshooting

**Can't connect?**
- If using Tailscale: make sure it's running and you're on the host's tailnet
- Try `curl http://HOST:5176/health` to check server is reachable

**Annotations not appearing?**
- Check the browser console for WebSocket errors
- Try opening in a new tab

**Page looks stale?**
- The viewer auto-reloads when the document rebuilds. A full browser refresh shouldn't be needed, but try it if something seems stuck.
