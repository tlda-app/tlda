# tlda

Collaborative annotation system for reviewing LaTeX papers. Renders LaTeX as SVGs on a TLDraw canvas with KaTeX math in notes, real-time sync, and source-anchored annotations that survive document rebuilds. Also supports Quarto HTML and reveal.js slides as experimental input formats.

Built for iPad-first review workflows. Works standalone as a paper viewer and annotation tool — no AI needed. Optionally integrates with Claude Code via MCP for an agent-assisted review loop.

> **Fair warning:** This entire codebase was vibe-coded with Claude Code. The author has not read the source.

**[Live demo](https://qtm285.github.io/tlda/?doc=spinoff3)** — a live collaborative canvas. Draw on it, leave notes, and everyone sees each other's annotations in real time. Please be cool.

## Why this exists

When you're working with an AI agent that writes faster than you can read, it's easy to get disoriented. tlda helps. It anchors your annotations to the text so they move with it as it changes; uses MCP integration to help you communicate with the agent right on the canvas — highlight a passage and it reads the text under your stroke, ping and it sees your viewport, or let it scroll you through its changes and drop notes addressing your questions; and puts definitions and diffs right on the page with you. The canvas is shared in real time — collaborators and agents see each other's annotations as they appear. No AI required; it works just as well for reading any paper with a friend. Most papers on arXiv have TeX source available.

## What it does

- Converts LaTeX documents to SVG pages via `latexmk` + `dvisvgm`
- Displays them on a TLDraw canvas with pan/zoom and multi-page layout
- Sticky notes with KaTeX rendering (paper macros automatically available). Notes support threaded replies (tabs) and multiple-choice buttons — an agent can ask a question with tappable options, and your selection syncs back immediately.
- Source-anchored annotations via synctex — annotations track source lines, not page coordinates
- Real-time sync between iPad viewer and Claude Code via MCP
- Reference viewer: double-click any `\ref` or `\eqref` in the rendered text and a panel shows the referenced definition, equation, or lemma inline — no scrolling away from where you are. Arrow buttons step to the previous and next reference in the text; go-there (↗) jumps to the target; go-back (↩) returns. It's a window to another place on the canvas. You can pan to see context just like you would in the main view. 
- Proof statement overlay: when you scroll into a proof, a pill appears with the theorem name. Click to expand into a panel showing the theorem statement — no need to flip back to where it was stated. It's another window.
- Build error overlay: when LaTeX fails, errors appear as text shapes anchored to the source line where they occur, with a navigation panel to cycle through them. Clickable to open in your editor. Warning count is displayed in a small badge; click to expand the list, click a warning to jump to it in the editor.
- Editor integration (`texsync://`): Cmd-click rendered text to open the source file at that line in your editor. Errors and warnings are clickable too. Run `./scripts/install-texsync.sh` to set up the URL handler (macOS; defaults to Zed, `--editor code` for VS Code)
- Magic highlighter: freehand highlight strokes that extract the underlying text and attach it as metadata, so agents can read what you highlighted without a screenshot. Glows on hover so you know what text has been attached.
- Change review: pick any point from a unified timeline of your git history and last 30 builds, then diff it against the current version — side-by-side pages with tappable status dots per change (keep / revert / discuss), `n`/`p` to jump between changes, and agent-generated summaries.
- File watcher for live rebuild on save

## Architecture

```
cli/          — `tlda` CLI: project management, file watching, builds
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

This installs the `tlda` command globally, builds the viewer, and you're ready to go.

**Or clone and link:**

```bash
git clone https://github.com/qtm285/tlda.git
cd tlda
npm install
npm link
```

**Then:**

```bash
tlda server start      # start the server on port 5176
tlda create my-paper --dir /path/to/paper --main paper.tex
tlda watch-all start   # watch all projects for changes
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
# Produces my-plot.svg (for tlda) and my-plot.pdf (for pdflatex)
```

This way `\includegraphics{figures/my-plot}` works in both pdflatex (picks up the PDF) and the tlda pipeline (falls back to the SVG).

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

- **Todd** — an always-on triage agent that covers all documents. Listens for pings and questions, gives quick answers, drops multiple-choice notes, and escalates to a terminal agent when deeper work is needed. Runs via `tlda server start --agent`. Signs notes "—Todd".
- **Terminal Claude agents** — full Claude Code sessions with access to the source files. Can read and edit LaTeX, do deep math checking, run builds. Connect per-document via the MCP server. Sign notes "—Claude".

Todd yields to terminal agents automatically via heartbeat detection — when a Claude Code session is active on a document, Todd steps back. Color convention: orange = Claude, green = Todd, violet = user.

### Running Todd against a remote server

Set `TLDA_SYNC_SERVER` to route shapes and signals to a remote sync server while reading doc assets from local disk. Run from a published clone (created by `publish-snapshot`) so ongoing work doesn't affect Todd's view of the document:

```bash
cd ~/work/published/tlda
TLDA_SYNC_SERVER=https://example.com node cli/lib/triage-agent.mjs
```

The publish script (`npm run publish-snapshot -- <doc>`) syncs to the published clone, deploys to GitHub Pages and Fly, and prints the Todd command at the end.

## CLI Reference

Everything goes through the `tlda` command:

| Command | What it does |
|---------|-------------|
| `tlda server start` | Start the server (port 5176) |
| `tlda server stop` | Stop the server |
| `tlda create <name> --dir /path [--format html\|slides]` | Create a project, push files, build |
| `tlda push [name]` | Push source files, trigger rebuild |
| `tlda watch-all start` | Watch all projects for changes |
| `tlda open [name]` | Open viewer in browser |
| `tlda list` | List projects |
| `tlda status [name]` | Show build status |
| `tlda errors [name]` | Show LaTeX errors/warnings |
| `tlda preview <name> [pages]` | Rasterize SVG pages to PNG |
| `tlda share [name]` | Print read-only viewer URL |
| `tlda book <name> --members a,b,c` | Create a composite book project |
| `tlda publish [doc ...]` | Publish docs to GitHub Pages + Fly |
| `tlda agent start [--remote]` | Start Todd, the always-on triage agent |
| `tlda agent stop` | Stop Todd |
| `tlda delete <name>` | Delete a project |

The server auto-starts on first use. Configure with `tlda config set server <url>` or the `TLDA_SERVER` env var. For remote publishing: `tlda config set remote <url>` and `tlda config set published doc1,doc2,...`.

## Other Input Formats

LaTeX/SVG is the primary and best-supported format. tlda also has experimental support for:

| Format | Source | Command | Demo |
|--------|--------|---------|------|
| **Markdown** | `.md` with KaTeX math | `tlda create notes --format markdown --dir /path` | [demo](https://qtm285.github.io/tlda/?doc=markdown-demo) |
| **HTML** | Quarto-rendered chapters | `tlda create book --format html --dir _book-tlda` | [demo](https://qtm285.github.io/tlda/?doc=qtm285) |
| **Slides** | reveal.js HTML | `tlda create deck --format slides --dir /path` | [demo](https://qtm285.github.io/tlda/?doc=swissrollera) |
| **Book** | existing projects | `tlda book course --members lec1,lec2` | — |

See [docs/formats.md](docs/formats.md) for a detailed comparison. For Quarto HTML projects, see [docs/quarto-html.md](docs/quarto-html.md) and the config template in `extensions/tlda-quarto-config/`.

## Collaborative Roles

In collaborative sessions, one person presents (broadcasts camera, controls annotation visibility) while others view (follow camera, draft annotations before publishing). See [docs/roles.md](docs/roles.md).

## Third-party licenses

This project uses the [tldraw SDK](https://tldraw.dev), which is provided under the [tldraw license](https://tldraw.dev/legal/tldraw-license). The tldraw SDK is source-available but not permissively licensed.

**This matters in practice.** The viewer works fine on `localhost`, so local use and collaboration over Tailscale/LAN are unaffected. But if you deploy to a public URL (your own domain, Tailscale Funnel, etc.), the tldraw canvas will go white after a second. The only clue is red bars of varying heights in the browser console. You need a [tldraw license key](https://tldraw.dev/get-a-license/plans) for non-localhost deployments. They have a free hobby tier.

All other dependencies are under their respective open-source licenses.

## License

This project's own code is released under the [MIT License](LICENSE).
