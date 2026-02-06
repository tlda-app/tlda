# Collaborator Setup Guide

This gets you into a shared paper review session where you can annotate a LaTeX paper together in real time. Skip hosts the server; you just need Tailscale and a browser.

## 1. Install Tailscale (2 minutes)

Tailscale is a lightweight mesh VPN. It only routes traffic between our devices — your regular internet is unaffected.

**Mac:**
```bash
brew install --cask tailscale
```
Or download from [tailscale.com/download](https://tailscale.com/download).

**Linux:**
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

**Windows:**
Download from [tailscale.com/download](https://tailscale.com/download).

After installing, open Tailscale and sign in. Ask Skip to approve you on the tailnet.

## 2. Open the viewer

Once you're on the tailnet, open this in your browser:

```
http://100.78.98.69:5173/?doc=bregman
```

That's it. You can now:
- **Pan/zoom** the paper
- **Draw** annotations (pen, highlighter)
- **Drop math notes** (press `m`, type `$\LaTeX$`)
- **Ping** to get attention (button in bottom-right panel)

All annotations sync in real time across everyone connected.

## 3. Edit the source (optional)

If you want to edit the LaTeX together, install [Zed](https://zed.dev/) and join a shared editing session. Edits to the `.tex` files trigger an automatic rebuild — updated pages appear in the viewer within ~20 seconds.

## Quick reference

| Action | How |
|--------|-----|
| Pan | Scroll or drag with hand tool |
| Zoom | Pinch or Cmd+scroll |
| Draw | Select pen tool (or press `d`) |
| Highlight | Select highlighter tool |
| Math note | Press `m`, then click to place |
| Erase | Select eraser tool (or press `e`) |
| Ping | Click the ping button (bottom-right) |

## Troubleshooting

**Can't connect?**
- Make sure Tailscale is running (check the menu bar icon)
- Ask Skip if the server is up

**Annotations not appearing?**
- Check the browser console for WebSocket errors
- Make sure you're on the same `?room=` as everyone else (default is fine)

**Page looks stale?**
- Reload the browser — if the paper was just rebuilt, you'll get fresh pages automatically
