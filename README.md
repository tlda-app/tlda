# tlda

Collaborative annotation system for reviewing LaTeX papers. Renders LaTeX as SVGs on a TLDraw canvas with KaTeX math in notes, real-time sync, and source-anchored annotations that survive document rebuilds.

Built for iPad-first review workflows. Works standalone as a paper viewer and annotation tool — no AI needed. Optionally integrates with Claude Code via MCP for an agent-assisted review loop.

> **Fair warning:** This entire codebase was vibe-coded with Claude Code. The author has not read the source. Caveat emptor.

**[Live demo](https://qtm285.github.io/tlda/?doc=spinoff3)** — this is a live collaborative canvas. You can draw on it, leave notes, and everyone sees each other's annotations in real time. Please be cool.

## Why this exists

When an AI agent produces content faster than you can review it, the standard text-editor-plus-PDF setup stops working. You need to stay oriented in a document that changes faster than you can re-read it, verify cross-page dependencies without flipping back and forth, and communicate with the agent on the document rather than in a separate chat window.

CTD puts everything on the canvas: source-anchored annotations that survive rebuilds, cross-page proof and definition viewers, structured diff review, and an MCP integration so the agent sees what you're pointing at. It works just as well for human collaborators or for reading any paper — most papers on arXiv have TeX source available.

## What it does

- Converts LaTeX documents to SVG pages via `latexmk` + `dvisvgm`
- Displays them on a TLDraw canvas with pan/zoom and multi-page layout
- Math notes with KaTeX rendering (paper macros automatically available)
- Source-anchored annotations via synctex — annotations track source lines, not page coordinates
- Real-time sync between iPad viewer and Claude Code via MCP
- Reference viewer: double-click any `\ref` or `\eqref` in the rendered text and a panel shows the referenced definition, equation, or lemma inline — no scrolling away from where you are. Arrow buttons step through refs on the same line; go-there (↗) jumps to the target; go-back (↩) returns.
- Proof statement overlay: when you scroll into a proof, a pill appears with the theorem name. Click to expand into a panel showing the theorem statement — no need to flip back to where it was stated.
- Build error overlay: when LaTeX fails, errors appear as text shapes anchored to the source line where they occur, with a navigation panel to cycle through them. Clickable to open in your editor.
- Build warning pill: small warning count badge; click to expand the list, click a warning to jump to it in the editor
- Editor integration (`texsync://`): Cmd-click rendered text to open the source file at that line in your editor. Errors and warnings are clickable too. Run `./scripts/install-texsync.sh` to set up the URL handler (macOS; defaults to Zed, `--editor code` for VS Code)
- Magic highlighter: freehand highlight strokes that extract the underlying text and attach it as metadata, so agents can read what you highlighted without a screenshot. Glows on hover.
- File watcher for live rebuild on save

## Architecture

```
cli/          — `ctd` CLI: project management, file watching, builds
server/       — Express + @tldraw/sync: API, real-time sync, build pipeline
src/          — React + TLDraw viewer SPA
mcp-server/   — MCP tools for Claude Code integration
```

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- A TeX distribution with `pdflatex`, `latexmk`, `biber`, and `dvisvgm` — [TeX Live](https://tug.org/texlive/) or [MacTeX](https://tug.org/mactex/) on macOS

## Setup

**Install from GitHub:**

```bash
npm install -g github:qtm285/tlda
```

This installs the `ctd` command globally, builds the viewer, and you're ready to go.

**Or clone and link:**

```bash
git clone https://github.com/qtm285/tlda.git
cd tlda
npm install
npm link
```

**Then:**

```bash
ctd server start      # start the server on port 5176
ctd create my-paper --dir /path/to/paper --main paper.tex
ctd watch-all start   # watch all projects for changes
```

## Figures

The build pipeline doesn't use PDF figures. LaTeX runs in DVI mode with `graphicx` draft option, so `\includegraphics` produces placeholder boxes that get patched with actual images afterward.

**Supported formats:** `.svg`, `.png`, `.jpg`, `.eps`

**For PDF figures:** provide an SVG with the same basename and dimensions. If your LaTeX says `\includegraphics{plot.pdf}`, the pipeline looks for `plot.svg` in the source directory and uses that instead. The SVG should match the PDF's bounding box (same width and height in points).

**SVG is preferred** — it inlines as vector graphics with full quality. Raster formats (PNG/JPG) get base64-embedded, which works but bloats the page SVGs.

**R helper** for producing figures in both formats with matching dimensions:

```r
library(svglite)

savefig = function(path, plot = last_plot(), width = 3.5, height = 3) {
  svglite(paste0(path, ".svg"), width = width, height = height, bg = "transparent")
  print(plot)
  dev.off()
  cairo_pdf(paste0(path, ".pdf"), width = width, height = height, bg = "transparent")
  print(plot)
  dev.off()
}

# Usage: savefig("figures/my-plot", p, width = 3.5, height = 3)
# Produces my-plot.svg (for ctd) and my-plot.pdf (for pdflatex)
```

This way `\includegraphics{figures/my-plot}` works in both pdflatex (picks up the PDF) and the ctd pipeline (falls back to the SVG).

## Viewer Controls

The viewer UI is minimal by design. The primary interface is touch/stylus — keyboard shortcuts exist but aren't required.

**Ping button** — the small circle in the bottom-right corner. Tap it to get an agent's attention. This is the primary way to say "hey, look at this" during a review session. It captures a screenshot and triggers `wait_for_feedback` on any listening agent.

**iPad tool zones** — three invisible buttons on the right edge, below the table of contents: pointer, highlighter, and eraser. Double-tap with the stylus to switch to that tool; double-tap the active tool to switch back to the pen. With a hover-capable stylus, the buttons appear on hover; otherwise they appear briefly on tap.

**Panel** — expandable side panel (top-right) with tabs for table of contents, notes list, search, proof info, and change review.

**Keyboard shortcuts** (optional):

| Key | Action |
|-----|--------|
| `m` | Create a math note (click to place, type `$...$` for math) |
| `d` | Draw tool (pen) |
| `e` | Eraser |
| `t` | Text select tool |
| `i` | Edit selected note / add reply tab |
| `h`/`l` or arrows | Cycle tabs on a selected note |
| `n`/`p` | Jump to next/previous change (diff mode) |

## Agent Architecture

Two kinds of AI agents can interact with the viewer:

- **Todd** — an always-on triage agent that covers all documents. Listens for pings and questions, gives quick answers, drops multiple-choice notes, and escalates to a terminal agent when deeper work is needed. Runs via `ctd server start --agent`. Signs notes "—Todd".
- **Terminal Claude agents** — full Claude Code sessions with access to the source files. Can read and edit LaTeX, do deep math checking, run builds. Connect per-document via the MCP server. Sign notes "—Claude".

Todd yields to terminal agents automatically via heartbeat detection — when a Claude Code session is active on a document, Todd steps back. Color convention: orange = Claude, green = Todd, violet = user.

### Running Todd against a remote server

Set `CTD_SYNC_SERVER` to route shapes and signals to a remote sync server while reading doc assets from local disk. Run from a published clone (created by `publish-snapshot`) so ongoing work doesn't affect Todd's view of the document:

```bash
cd ~/work/published/tlda
CTD_SYNC_SERVER=https://example.com node cli/lib/triage-agent.mjs
```

The publish script (`npm run publish-snapshot -- <doc>`) syncs to the published clone, deploys to GitHub Pages and Fly, and prints the Todd command at the end.

## CLI Reference

Everything goes through the `ctd` command:

| Command | What it does |
|---------|-------------|
| `ctd server start` | Start the server (port 5176) |
| `ctd server start --agent` | Start with Todd, the always-on triage agent |
| `ctd server stop` | Stop the server |
| `ctd create <name> --dir /path --main file.tex` | Create a project, push files, build |
| `ctd push [name]` | Push source files, trigger rebuild |
| `ctd watch-all start` | Watch all projects for changes |
| `ctd open [name]` | Open viewer in browser |
| `ctd list` | List projects |
| `ctd status [name]` | Show build status |
| `ctd errors [name]` | Show LaTeX errors/warnings |
| `ctd preview <name> [pages]` | Rasterize SVG pages to PNG |
| `ctd delete <name>` | Delete a project |

The server auto-starts on first use. Configure with `ctd config set server <url>` or the `CTD_SERVER` env var.

## Third-party licenses

This project uses the [tldraw SDK](https://tldraw.dev), which is provided under the [tldraw license](https://tldraw.dev/legal/tldraw-license). The tldraw SDK is source-available but not permissively licensed.

**This matters in practice.** The viewer works fine on `localhost`, so local use and collaboration over Tailscale/LAN are unaffected. But if you deploy to a public URL (your own domain, Tailscale Funnel, etc.), the tldraw canvas will go white after a second. The only clue is red bars of varying heights in the browser console. You need a [tldraw license key](https://tldraw.dev/get-a-license/plans) for non-localhost deployments. They have a free hobby tier.

All other dependencies are under their respective open-source licenses.

## License

This project's own code is released under the [MIT License](LICENSE).
