# What Skip's Environment Looks Like

> **Audience:** Every agent. Read this before your first task.

## The Short Version

Skip reviews papers and coordinates agents through **tlda** — a custom app that renders LaTeX as zoomable SVG pages on a TLDraw canvas. He views it on an iPad and annotates with a pen. **He has RSI and cannot type.** Fleet chat via voice is his only communication channel.

Your tex output does not become a PDF. It becomes rendered SVG pages in an interactive canvas. Skip sees your work the way a reader sees a published paper — but with annotation tools layered on top.

## What Skip Sees

<!-- TODO: Add annotated screenshot here -->

The tlda viewer has:

- **Paper pages** — SVG renders of your LaTeX output, laid out on an infinite canvas. Skip can zoom, pan, and scroll. Pages are stacked vertically like a continuous document.
- **Annotations** — Pen strokes, highlights, sticky notes (with KaTeX math), arrows. These are TLDraw shapes anchored to source lines in the tex file. When Skip draws a circle around something on page 3, that maps back to a specific line in your `.tex` file.
- **Fleet chat panel** — The right side panel where agent messages appear. This is how Skip talks to you and how you talk to Skip. Markdown renders here (bold, code, lists, headers, LaTeX).
- **Agents panel** — Shows registered agents, their status, current tasks. Skip can see who's working on what.
- **Proof reader** — Press `r` to highlight proof regions and show theorem statements. Cross-page proofs show the statement in an overlay so Skip doesn't have to flip back.

## What This Means for Your Work

### Your LaTeX becomes SVG, not PDF
- `latexmk` compiles your `.tex` → DVI → `dvisvgm` converts to SVG per page
- The viewer loads these SVGs onto the TLDraw canvas
- Layout, spacing, figure placement, and page breaks all matter because Skip sees them rendered
- If your output looks bad as rendered pages, it looks bad to Skip

### Feedback comes as drawn annotations
- Skip draws on the iPad with an Apple Pencil
- Circles, underlines, arrows, highlights — these map to source lines via SyncTeX
- Sticky notes contain text (often with math via KaTeX)
- When you receive feedback via `wait_for_feedback` or `read_pen_annotations`, that's what these shapes contain

### Communication is fleet chat only
- **Never** put important messages in terminal output — Skip can't see your terminal
- **Never** ask Skip to type something — he has RSI and communicates via voice
- Use `chat()` for all communication. Format with markdown.
- Fleet chat is **accessibility-critical** — if it breaks, that's priority zero

### Use tlda tools, not desktop apps
| Don't do this | Do this instead |
|---|---|
| `open file.pdf` | `tlda open <project>` |
| "Open it in Preview" | `tlda preview <project> [pages]` |
| "Check the PDF" | Take a playwright screenshot of the viewer |
| "I've updated the tex" | Push via `tlda push` or let the watcher pick it up |
| Put results in terminal | `chat()` via fleet |

### The build pipeline
```
You edit .tex file
    ↓
tlda watcher detects change → pushes to server
    ↓
Server runs: latexmk → dvisvgm → synctex → proof-pairing
    ↓
Viewer reloads automatically (signal:reload via Yjs)
    ↓
Skip sees updated pages on iPad
```

You don't need to run `latexmk` yourself. Edit the tex, and the pipeline handles the rest. If you need to check build status: `tlda status <project>`. If there are errors: `tlda errors <project>`.

### Verifying your own work
- `tlda preview <project> [page]` — renders a static preview of specific pages
- Playwright MCP tools — take screenshots of the live viewer
- **Never** tell Skip to "go check" or "reload and see" — verify it yourself first

## The Annotation Loop

This is the typical review workflow:

1. Skip opens a document on iPad
2. Skip reads, draws circles/highlights/notes on things that need attention
3. Agent receives feedback (via `wait_for_feedback`, `tlda monitor`, or `read_pen_annotations`)
4. Agent reads the annotation, maps it to source lines, makes the edit
5. Watcher rebuilds, viewer reloads
6. Skip sees the update and continues reviewing

Your job in this loop: respond to what Skip marked, edit the source, and verify the result looks right — all without Skip having to explain anything twice or type anything.
