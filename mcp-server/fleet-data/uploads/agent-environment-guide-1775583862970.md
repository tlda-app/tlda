# What Skip's Environment Looks Like

> **Audience:** Every agent. Read this before your first task.

## The Short Version

Skip reviews papers and coordinates agents through **tlda** — a custom app that renders LaTeX as zoomable SVG pages on a TLDraw canvas. He views it on an iPad and annotates with a pen. **He has RSI and cannot type.** Fleet chat via voice is his only communication channel.

Your tex output does not become a PDF. It becomes rendered SVG pages in an interactive canvas. Skip sees your work the way a reader sees a published paper — but with annotation tools layered on top.

## What Skip Sees

Everything lives on **one TLDraw canvas** — the paper, agent chat, agent management, all in one zoomable space. This is not three separate apps; it's one viewer.

### The Canvas Layout

It's one Chrome tab, one TLDraw canvas. Skip's typical layout:

```
┌────────────────────────────────────────────────────────────────────────┐
│ Agents Panel │ Chat Column 1 │ Chat Column 2 │  Paper Pages   │  TOC  │
│              │ (math agent)  │ (fleet agent) │                │       │
│ ┌──────────┐ │ ┌───────────┐ │ ┌───────────┐ │ ┌────────────┐ │ ┌───┐ │
│ │ agent    │ │ │ skip: ... │ │ │ skip: ... │ │ │  Page N    │ │ │ · │ │
│ │ tasks    │ │ │ agent:... │ │ │ agent:... │ │ │  theorems  │ │ │ · │ │
│ │ labels   │ │ │ skip: ... │ │ │ skip: ... │ │ │  proofs    │ │ │ · │ │
│ │ search   │ │ │           │ │ │           │ │ │  equations │ │ │   │ │
│ │          │ │ │           │ │ │           │ │ │  figures   │ │ │   │ │
│ └──────────┘ │ └───────────┘ │ └───────────┘ │ ├────────────┤ │ └───┘ │
│              │               │               │ │  Page N+1  │ │       │
│              │               │               │ │  ...       │ │       │
│              │               │               │ └────────────┘ │       │
├────────────────────────────────────────────────────────────────────────┤
│ [voice input bar]                                                      │
└────────────────────────────────────────────────────────────────────────┘
```

- **Agents panel** (far left) — registered agents with colored labels (e.g. "fleet", "stk"), current tasks, search across chat history
- **Chat columns** — filtered views of fleet chat. Skip typically has two open side by side: one for a math agent, one for an infrastructure agent. Each shows that agent's messages + Skip's replies with timestamps. Your `chat()` messages appear here with markdown rendering. **This is where Skip reads your work.**
- **Paper pages** (right of chat) — SVG renders of your LaTeX, stacked vertically. Full math typesetting, clickable cross-references, figures with captions, proper layout. This is the document the math agent is working on.
- **TOC panel** (far right) — table of contents with section links for quick navigation
- **Voice input bar** (bottom) — Skip's voice transcription input. He speaks, it transcribes, he sends. This is how he communicates with you.

**Key insight: the chat and the paper are on the same canvas.** Skip can zoom out to see the big picture, zoom into a chat to read details, or zoom into the paper to review math. Everything is spatially organized — agent work on the left, the document on the right.

### The Paper Pages

Your LaTeX output renders as **SVG pages on the canvas** — not a PDF viewer, not Preview.app:
- Full mathematical typesetting (theorems, corollaries, remarks, display math)
- Clickable cross-references (equation numbers, proposition refs)
- Proper figure and table layout
- Page-by-page vertical stacking

When Skip reviews on iPad, he sees these same pages with pen/annotation tools overlaid. He draws circles around problems, highlights text, drops sticky notes with KaTeX math.

### Annotations
Pen strokes, highlights, sticky notes (with KaTeX math), arrows — all TLDraw shapes anchored to source lines in the tex file. When Skip draws a circle around something on page 3, that maps back to a specific line in your `.tex` file.

### Proof Reader
Press `r` to highlight proof regions and show theorem statements. Cross-page proofs show the statement in an overlay so Skip doesn't have to flip back.

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
- Your chat messages appear **as a shape on the same canvas as the paper** — Skip reads them right next to the document
- **Never** put important messages in terminal output — Skip can see your terminal in the chat shape (bash commands are logged), but he can't interact with it
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
