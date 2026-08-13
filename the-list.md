# The list {#the-list}

**Deployed on your box: `3d10cb3ef`** (built 04:35:18Z). **`main` is `fc16046ef`, 12 commits
ahead** — anything that landed tonight is on `main` and not on your screen. Status re-baselined
against those two at 01:25 EDT.

**Status:** ✅ working on your box · ⚠️ built, not on your box · 🔨 being worked now · ○ not
started.

**94 rows collapsed to 71 things.** What collapsed and why is at the bottom, so you can check
the merging rather than take it.

## Chat and scrolling

| | | |
|---|---|---|
| 🔨 | **Chat jerks while you read it, with no input from you** | 688 corrections in your own session, 9 with any input. The correction writes to `scrollTop` and the scroller never moves — measured, 200 consecutive writes at one position. `scroll-owner` |
| 🔨 | **Sometimes you can't scroll up** | Sourced tonight from `react-virtuoso`'s own code: the repair aims at Virtuoso's model of the bottom, the gap is measured from the DOM's. Any height in the DOM the model doesn't know about is a permanent residual, so the repair fires every 500ms forever and you are scrolling against a writer that never stops. **Fix committed on a branch, not on your box.** `scroll-owner` |
| 🔨 | **A list component that behaves** — one abstract component with a signature, everything implements it | Your 23:27 design. Chat is migrated and running, −1096 lines. Pan-mode scrolling is dead on that branch and is being wired now. Never rendered in front of you. `list-component` |
| ○ | Scroll-back prefetch | Your design is written down. Nothing built against it |
| ○ | **Make the layer abstraction real** — a layer is a camera and a store | The largest thing on this list |
| ✅ | Thread cards expand and collapse again | `f8da9eb67`. Both controls. Was marked untouched; it had shipped |
| ✅ | Fleet panels render once instead of twice | |

## The canvas

| | | |
|---|---|---|
| 🔨 | **Clicking a shared markdown chip does nothing for seconds, then does everything at once** | Two network round-trips before anything appears, no pending state on the chip, no guard — so each extra click starts a whole new chain. **This is what filled your canvas tonight.** `markdown-chip-owner` |
| 🔨 | **Dragging a markdown chip drops a name pill, not a doc-viewer ghost** | Same owner, same worktree |
| ○ | **Snap to grid draws a grid and does not snap to it** | **A row said this was fixed. Your report tonight says it is not, so the row is wrong and it is now open.** Neither snapping system found can draw many lines or draw a line it won't land on — there is a third source and nobody has found it. Unowned |
| ○ | The layout button after a vertical split crashes the page | |
| ○ | A two-margin layout renders into one margin with a gap on refresh | |
| ✅ | Every sticky note anchors, not just voice notes | `91c77faf0` |
| ✅ | Highlights stop drifting on refresh | |
| ✅ | Shapes stop drifting on reload | `b75e0048a`. Was marked untouched; you call it a regression |
| ○ | Notes written on the iPad while Yjs is offline are stranded | No longer unrecoverable — the emergency dump appears on the sync-failure screen. The stranding itself is unfixed |
| ○ | Place-stack forward/back over documents | Built on a branch, never landed |
| ○ | Pen/handwriting correction | Built on a branch, never landed |
| ○ | The image/token syntax — chips in brackets, markdown for images | |

## Documents and markdown

| | | |
|---|---|---|
| 🔨 | **The document panel shows the readme plus fourteen other documents' headings** | The build concatenates every linked document's headings into one TOC — 176 entries. Chapters-get-their-own-page is book behaviour running on something that is not a book. All documents belong on one canvas page. `doc-panel-owner` |
| ○ | Figures render in colour | **The row said "on a white plate right now" and that describes a shape type your paper does not contain** — zero `svg-figure` shapes in 465 on your live `balancing-act` canvas. What actually paints a figure in a LaTeX project has not been established. `theme-palette-warm` |

## Themes and appearance

| | | |
|---|---|---|
| ✅ | Fog restored to what it was | |
| ✅ | Label chips have their colours back, one per label | |
| ✅ | Warm is cream and lilac, not mud | |
| ✅ | "Default" is now **One** | |
| ✅ | The mint control is visible in every theme | It had gone transparent |
| ✅ | Warm mode is gone from rendered documents | You wanted a theme, not a transform |
| ✅ | Document text colour is themed | Your 19:37 ruling |
| ✅ | The default theme no longer flashes the wrong ink on first paint | |
| ✅ | The tldraw toolbar sits at the screen edge on iPad | One CSS rule. Was marked untouched |

## Settings

| | | |
|---|---|---|
| ✅ | The settings panel regrouped; nine dead controls deleted or wired | 45 counted, 8 were inert |
| ✅ | The composer rail uses your touch-target setting | |
| ✅ | Download everything to a file, in the settings panel | |

## Sync, Overleaf and projects

| | | |
|---|---|---|
| ○ | **Put a real paper on sync and watch it** | **The whole of what is left here, and nobody is on it.** The instruments are on your box: telemetry that reported "online" unconditionally is fixed, a dropped keystroke says so, an edit that reaches nowhere is timed. Nobody has run one |
| ✅ | Moving a project keeps its history | Four versions in, four out |
| ✅ | The linked-git and Overleaf tests | You called them important three times |
| ✅ | The source editor works with two people in it | |
| ✅ | The classroom book pushes, which it never could | 525 MB → 259 KB |
| ✅ | Quarto's cache stopped shipping in uploads | 212 MB, 54% of the payload |
| ○ | Squash tlda's shadow commits the way Overleaf does | |
| ○ | Create an Overleaf project from a git repo | |
| ○ | Build the arXiv format as well as the journal one; `xr` compatibility | |

## Fleet, agents and bots

| | | |
|---|---|---|
| ⚠️ | `thread()` asks for the two-party conversation | **Done tonight — `281e36039`, the behaviour and not just the docstring.** It reaches an agent when its MCP restarts, not on deploy, so agents minted from now already have it |
| ○ | A handoff through Todd never works | Reported three times across three days. Todd is not running on `testing` at all — its tmux session only exists for `stable` |
| ○ | A bot's tmux session should die with the bot | You said "go for it" on 08-10; a session from 31 July is still running |
| ○ | Bots have no real options | |
| ○ | Reanimate does nothing and says nothing | |
| ○ | Minting sonnet and terra agents fails silently | |
| ○ | You sometimes load as a generated name instead of yourself | |
| ○ | Name generation for first-time users was deleted | |
| ○ | Read receipts are gone — the UI is there, disconnected | |
| ○ | A notification that fails to arrive must be noticed by the system | |
| ○ | Unexplained wakes; build notices fan out to everyone who ever touched the project | |
| ○ | `involving:(nobody & bot)` finds nothing for an agent you can name | |
| ○ | Inbox affordances: archive/delete, drag a sticky to an agent, task from a note | |
| ○ | The history endpoint should announce pagination the way `thread` does | |
| ○ | The build pill should name who sent it and who is responsible | |
| ○ | Edit attribution for builds, shown in history | |
| ○ | The paper dependency graph, and edit-implication notices | Two things, your ruling |
| ○ | Take build success away as a completion signal; an edit creates an obligation sized by its diff | |
| ✅ | A fresh agent gets your project's macros | The photoshoot failure |
| ✅ | Todd talks again, with a wake budget you set at 20 and `shut-up-todd` as a label | |
| ✅ | A label dragged out of a chat filters, same as one from the agents panel | `5e6d3a4e9`. Was marked untouched |
| ✅ | A live agent is never told it was hibernating | Was marked untouched |
| ✅ | Macros display in an agent's edits | Was marked untouched |

## Voice

| | | |
|---|---|---|
| ✅ | Enter waits for your dictated tail to finalise | The message-repeating-itself thing |
| ○ | Message send lag; you suspect the voice box config | |
| ○ | The voice buffer cap, and a HUD that says which of two things is wrong | |
| ○ | The voice provider picker: hide unconfigured, surface configured-but-unreachable | |
| ○ | A message with unavailable macros was refused instead of warned | |

## Deploy and infrastructure

| | | |
|---|---|---|
| ○ | **Why your box stopped for six minutes tonight** | A machine was created and told to stop seven seconds later. Neither deploy config declares a service or a minimum machine count |
| ○ | `config apply` must never be how you fix a running bot | |
| ○ | Zero magic numbers; limits in config files, not environment variables | |
| ○ | Move the server and daemon JavaScript to TypeScript, gradually | |
| ○ | Token **permissions** — the switch for whether the app needs a token | Built on a branch, never merged |
| ✅ | A deploy can no longer report success on a box that is off | Ran twice, 10s and 20s. **It has never seen the failure it was written for**, so it is proven not to get in the way, not proven to catch anything |
| ✅ | Push-to-deploy is cut over; the lying `deploy:live` alias is gone | |
| ✅ | `config apply` retries its own I/O error | |

## Classroom and course

| | | |
|---|---|---|
| ○ | The probability arc you designed on 08-10 | `fall-class` was told to find it and still has not been pointed at it |
| ○ | The schedule, week by week, with an authorship overlay | |
| ○ | The course website: a date list and references into the book | |
| ○ | The classroom common layer is the book layer; a demo student account | |
| ○ | Homework structure: problems in narrative sections, stray text refuses upload | |
| ○ | An errata page for the book, as annotations into it | |
| ○ | Automatic lecture recording and Notability-style playback | |
| ○ | A screen-reader-safe parallel version of the course content | |

## Written down rather than built

| | | |
|---|---|---|
| ✅ | The chat rendering and scroll model, with an errata of its live defects | It found two scroll writers nobody knew about |
| ✅ | The window manager, with its errata | |
| ✅ | What an advocate is for, for chiefs and for advocates | Your 23:46 ruling |
| ✅ | Naming errata — the list exists | You said fix it or at least write it down |
| ○ | The README merge, then the photoshoot | Images are still July 1 |
| ○ | Documentation taxonomy, and an Overleaf onboarding section | |
| ○ | GitHub release: push, tag a late-alpha | Tagging waits on you |
| ○ | Submit tlda to JOSS | What the release is for |

## What I collapsed, so you can check it

**Two rows that were one thing:**

- *"The jerk is not fixed"* and *"why it jerks, narrowed to one candidate"* — one defect, one owner.
- *"Collapsing thread views work again"* and *"expanding a thread card expands it"* — same commit, and it shipped.
- *"Figures render in colour"* and the white-plate note — the plate was the whole content of the second.

**Rows that were notes, not work:** *"we stopped reacting to the resize our own scroll write caused"* — shipped, reverted, both on your box, net not in effect and correctly so. It records an investigation, not a thing to do.

**Rows moved out of the section that hid them:** the four *written down* rows were scattered across chat, canvas and fleet, which is why documentation looked like progress on each of them.

**One row flipped from done to not started:** snap to grid. It was marked ✅ *"snapping draws guides and lands the panel on the line."* You said tonight it draws a grid and does not snap to it. **Your report wins and the row is open.**

**Three things added that were not on it at all** — the markdown chip click, the chip drag, and the document panel. All three are tonight's and all three have owners.
