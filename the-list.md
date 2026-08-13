# The list {#the-list}

**Deployed on your box: `3d10cb3ef`** (built 04:35:18Z). **`main` is `dde8216f4`, 30 commits ahead** — everything tonight is on `main` and none of it is on your
screen. **That is deliberate: you said not to deploy, so nobody has.** Re-derived at 02:38 EDT.

**Status:** ✅ working · ⚠️ built, not reaching you yet · 🔨 being worked now · ○ not started ·
? nobody could establish it. **Where a thing lives is on the row** — three of these work but do
not live on your box, and one of those is a documentation file.

**92 things**, counted at write time. **Every row was re-checked tonight by four verifiers reading diffs, not subjects.** A `?` means nobody could establish it either way — that is a real answer and there are 4 of them.

## Chat and scrolling

| | | |
|---|---|---|
| 🔨 | **Chat jerks while you read it, with no input from you** | The measurement is real; **whose session it is, is not established.** 688 corrections, 9 with input, scroller never moves, 200 consecutive writes at one position — but the session is attributed to you **by a shape id containing your name**, and both bursty sessions are `isTouch` while you are on the Air. **That inference is the one an agent was killed for tonight.** Treat the mechanism as sound and the attribution as open. Unowned — `scroll-owner` is gone |
| 🔨 | **Sometimes you can't scroll up, and it's worse than it used to be** | **A cause, on the sha you are reading.** A panel's buffer is trimmed to 500 events every time it is pinned to the tail — which is every time a message arrives while you follow — but the history cursor it pages from is a separate record the trim never touches. So the buffer's oldest row becomes newer than the cursor, and scrolling up asks the server for rows *older than the hole the trim just made*. **Nothing ever requests the hole.** That is *"show me the list you already showed me… now I can't fucking scroll up to it."* Fix committed on a branch, typechecked, never run. **Nobody found a commit that made it worse and nobody claimed one.** The earlier mechanism on this row ended at a scrollbar drag — you are on Safari, there is none, and I reverted that commit off `main` (`5a1089f0d` → `a47b438e5`) |
| 🔨 | **A list component that behaves** — one abstract component with a signature, everything implements it | Your 23:27 design, on `rc/anchored-list`, none of it on `main` or your box. **It does not fix "can't scroll up"** — the buffer, the trim and the history cursor are upstream of everything it changes, so it pages into the same hole. **The two fixes are independent and both are needed**, which also means your symptom may have had two causes the whole time, and no anchor telemetry could ever have shown the buffer one. **Five things elsewhere in the app were reaching into the old scroller and would have broken silently** — pan mode twice, the history paging guard, a screenshot overlay, and the suggestion tip, which hid on wheel and so worked on a trackpad and not under a finger. **All five found by reading, none by anything failing**; the build, the tests and the app were green throughout. Swept systematically rather than sampled, so the count is five and not "five so far" — though a consumer reaching the scroller some other way would not be in that sweep. `list-component` |
| ○ | Scroll-back prefetch | Your design is written down. Nothing built against it |
| ⚠️ | **Make the layer abstraction real** — a layer is a camera and a store | **The shape-membership half is built on `rc/wm-layers`** — the window manager can say which layer a shape is in, with 329 lines of tests, and five errata entries are marked resolved *on that branch and nowhere else*. **Not on `main`, not on your box.** `verify-canvas-rows` read the same branch and called it groundwork rather than the abstraction; the branch's own commit is titled *"…and what still does not"*. **So: one half built, the store half not, and the largest thing on this list is still open** |
| ✅ | Thread cards expand and collapse again | `f8da9eb67`. Both controls. Was marked untouched; it had shipped |
| ✅ | Fleet panels render once instead of twice | |

## The canvas

| | | |
|---|---|---|
| ⚠️ | **Clicking a shared markdown chip does nothing for seconds, then does everything at once** | Two network round-trips before anything appears, no pending state on the chip, no guard — so each extra click starts a whole new chain. **This is what filled your canvas tonight.** `markdown-chip-owner` **Fixed in `5e67afccb`, which is on `main` and not on your box** — its own message says "Not deployed." Both chip rows are that one commit |
| ⚠️ | **Dragging a markdown chip drops a name pill, not a doc-viewer ghost** | Same owner, same worktree **Fixed in `5e67afccb`, which is on `main` and not on your box** — its own message says "Not deployed." Both chip rows are that one commit |
| ○ | **Snap to grid draws a grid and does not snap to it** | **Nobody has looked at your screen.** Nobody knows where those lines come from. A previous version of this row offered tldraw's own snap prefs as a lead — you don't use tldraw snapping, so that was a guess about the wrong system and it is gone. **The one thing nobody has done is read your live tab and count what is actually drawn**, which is a read-only inspection that needs nothing from you. Unowned |
| ○ | The layout button after a vertical split crashes the page | **Nobody looked.** No commit mentions the layout button or a vertical split in three weeks, and nobody has opened the crash. This dot means untouched, not checked-and-untouched |
| ○ | A two-margin layout renders into one margin with a gap on refresh | **Nobody looked.** No commit for it and no investigation. This dot means untouched, not checked-and-untouched |
| ✅ | Every sticky note anchors, not just voice notes | `91c77faf0` |
| ✅ | Highlights stop drifting on refresh | |
| ? | Shapes stop drifting on reload | **The sha I cited was wrong.** `b75e0048a` gates *fleet HUD* anchors on camera restore — one file, `FleetHUD.tsx`, and it does not touch document shapes. If the row means the HUD, done. **If it means shapes in your document, nothing was found that fixes it** |
| ○ | Notes written on the iPad while Yjs is offline are stranded | No longer unrecoverable — the emergency dump appears on the sync-failure screen. The stranding itself is unfixed |
| ○ | Place-stack forward/back over documents | Built on a branch, never landed |
| ○ | Pen/handwriting correction | Built on a branch, never landed |
| ○ | The image/token syntax — chips in brackets, markdown for images | **Nobody looked.** |

## Documents and markdown

| | | |
|---|---|---|
| ⚠️ | **The document panel shows the readme plus fourteen other documents' headings** | **Fixed in `338f81ea6`, on `main` and not on your box.** The loop that made every file reachable from the readme into a chapter is gone; a markdown project's document is its main file, and no condition was added — a book is a declared format, so nothing should infer chapter-hood from a link. Following a link to a document with no shape yet calls `createTemporaryMarkdownColumn`, the chip's own code path, so it lands away from you and appears in the project tab for the same reason a clicked file does. **The first attempt stacked the documents vertically, which in this app means one document; I reverted it** (`5a539ad6a` → `883303c01`) and it was rebuilt. Counterfactual run: unmodified code reproduces the welded TOC at fixture scale. **The canvas is unverified** — the link-follow crosses an iframe boundary and neither end has been exercised. `doc-panel-owner` |
| ✅ | Figures render in colour, and have since `e69313a28` deployed | **Your figures are svglite markup inlined into the page SVG, not figure shapes** — zero `svg-figure` shapes among 548 on your `balancing-act` canvas, while page 16 carries Figure 1 as 116 polylines and 24 polygons inside the page itself. That commit removed the invert from the page container and the container was inverting them too. Everyone was looking at a shape type your paper does not contain. **What is left is smaller: the authored greys may read low-contrast on a dark family**, being looked at on the real page rather than argued from hex. `theme-palette-warm` |

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
| ✅ | The settings panel regrouped; **all eight inert controls disposed of** | Four features removed — the three doc-viewer-source checkboxes sharing one key, slide advance, two corner controls, the bots model picker — and two wired, line height and touch target. **A previous version of this row said two were still unaccounted for. That was false and there is no remainder** — it subtracted six *features* from eight *controls*, which are different units |
| ✅ | The composer rail uses your touch-target setting | |
| ✅ | Download everything to a file, in the settings panel | |

## Sync, Overleaf and projects

| | | |
|---|---|---|
| ✅ | **A real paper went on sync and was watched** | **Done tonight, not a status.** `partial-compliance` — abstract, two `\input` sections, a bibliography with a `\citep`, two figures by `\ref`, a real checkout linked so the daemon watches it. Archived after. **B pushed over HTTP and A's checkout received it on disk unprompted**; A edited another file, the daemon pushed it, both edits in the paper, build success. **The stale-base defect reproduced on it**, on the sha you are running: Carol asleep on an old revision edits the bibliography, every text file classifies mergeable, and the two figures she never opened refuse her edit. **Two things a fixture could not show** — it needs a participant that is *behind*, so it is the asleep laptop, the browser editor and the reconnecting tab rather than any paper with figures; and **the refusal writes no conflict state at all**, so she gets an HTTP status and nobody else is told anything. **The part it could not cover, named as the part:** nobody typed prose in the browser editor over time, and the dropped-keystroke instrument is armed but nothing tripped it because nothing was typing. `sync-pm` |
| ⚠️ | **One binary file made a stale-base push unrebasable, forever** | **Found and fixed tonight — `9657e586a`, on `main` and not on your box.** Classification ran over the union of every path rather than the changed ones, and one unmergeable sibling failed the whole batch, **so a single `.png` poisoned every rebase of files it had nothing to do with.** It worked on a probe and failed on any paper with a figure in it. **Now run rather than read** (`d21c9f0c6`): a paper with three figures and a bibliography nobody touches, two people editing different chapters from their own machines, through the real push route — before the fix, refused as `stale-base`; after it, both chapters land and the figures are carried. The run also found that a text-only fixture **cannot** produce this class, which is why the suite never caught it. `sync-pm` |
| ✅ | Moving a project keeps its history | Four versions in, four out |
| ✅ | The linked-git and Overleaf tests | You called them important three times |
| ✅ | The source editor works with two people in it | |
| ✅ | The classroom book pushes, which it never could | 527 MB, not the 525 the row said. The cause was a push filter sending `.pdf` and `.log` files the manifest then dropped — a 409, not an out-of-memory |
| ✅ | Quarto's cache stopped shipping in uploads | 212 MB, 54% of the payload |
| ○ | Create an Overleaf project from a git repo | **Nobody looked.** |
| ○ | Build the arXiv format as well as the journal one | **It builds what the LaTeX document asks for.** The `xr` half shipped in May and nobody noticed — `detectXrSiblings()` scans for `\externaldocument{}` and sorts targets so a dependent builds after the one whose `.aux` it reads. Nothing tests it |

## Fleet, agents and bots

| | | |
|---|---|---|
| ✅ | `thread()` asks for the two-party conversation | **Done tonight — `281e36039`, the behaviour and not just the docstring.** It reaches an agent when its MCP restarts, not on deploy, so agents minted from now already have it |
| ○ | A handoff through Todd never works | Reported three times across three days. **Nobody has found a cause.** An inherited note said Todd was not running on `testing`; that is false — `fleet-todd` has been up since 22:27 and has been sending check-ins all night |
| ○ | A bot's tmux session should die with the bot | You said "go for it" on 08-10. **My earlier wording was wrong: no session from July exists.** What exists is a *process* from 31 July — pid 800, **12 days elapsed, 195 minutes of CPU and still climbing** — waiting on `tmux wait-for` for a session name that was never created. The absent session is exactly why it never exits |
| ○ | Bots have no real options | **Nobody looked.** |
| ○ | **A display filter was implemented as a query filter, so nothing can ask about dead agents** | **Your framing, and it is the right one:** you don't want dead agents in your agents panel, and that is a *display* decision — it does not mean the query the code is built on should exclude them. It does. `/api/fleet-table` calls `getAliveAgents()`, which is `WHERE agents.dead = 0`, so **dead agents are unaskable rather than merely unshown**, and `totals.dead` is computed from a set they cannot be in. All 2,154 rows come back `dead: null`. **The panel and the MCP call can both keep hiding them — as a default with an option, which is where you landed.** A comment on that same route already records this exact shape for never-booted shells — *"'0 dead, N total' look like proof that nothing had gone missing"* — and was never extended to the dead. **Precondition for the row below:** nobody can reanimate what nobody can ask about. **Nobody looked** until you said so. Unowned |
| ? | Reanimate does nothing and says nothing | **The "says nothing" half is fixed and on your box** — `3f6251e28` added the whole reanimate feedback path, pending/queued/error with a rendered status message, and server-side reasons. **"Does nothing" is still not established, and the reason this row gave was wrong.** It said the fleet has zero dead agents. **All 2,154 rows of the fleet table carry `dead: null` — the field is written nowhere**, so "zero dead" was an instrument reporting a value nobody sets, not a fact about the fleet. You say there are thousands. **Nobody can currently see a dead agent to reanimate one**, which is its own defect and may be this one |
| ○ | Minting sonnet and terra agents fails silently | **Nobody looked.** |
| ? | **You sometimes load as a generated name, and name generation was deleted** | **These two rows contradict each other** — one says a generated name appears, the other says the generator is gone. Neither could be established: searches for the generator found nothing, but nobody could show the search would have found it under another name. **Merged, and both halves are unverified** |
| ○ | Read receipts are gone — the UI is there, disconnected | **Nobody looked.** |
| 🔨 | A notification that fails to arrive must be noticed by the system | **The noticing shipped and the reading did not.** `c330f231b` is on your box: the server requires an MCP ACK and builds a `notification_failure` onto the wake payload. **That literal appears exactly once outside tests — the writer.** Nobody reads it, so the system notices, tells the daemon, and the daemon drops it |
| ○ | Unexplained wakes; build notices fan out to everyone who ever touched the project | **Nobody looked.** |
| ○ | `involving:(nobody & bot)` finds nothing for an agent you can name | **The cause is sharper than the row:** `nobody` is a real living agent, but `involving:nobody` returns rows belonging to a *different* agent, `pull-tells-nobody` — an exact name resolves to a substring match on somebody else, so the agent you named is never reached |
| ○ | Inbox affordances: archive/delete, drag a sticky to an agent, task from a note | **Nobody looked.** |
| 🔨 | **Everything that paginates announces it, at the top and at the bottom** | **Your rule, 03:04–03:05, and it is general — not a fix to `roster`.** The top says it is paginated; **the bottom tells you how to get the next page.** **This row cost you something tonight, hours after it was written.** I asked the fleet table how many dead agents there are, read the 500 rows it returned, and told you zero. There are **2,154 across five pages** and it never said there was a second one. `thread` announces its pages; `roster` and the history endpoint do not. **The row was already on your list saying nobody had looked — and then it happened to me, while I was using the list to answer you.** Nobody has looked at the code |
| ○ | **Who caused a build, shown on the pill and in history** | Nothing implements it. **Merged from two rows** — the build pill naming who sent it and edit attribution in history are one ask wearing two surfaces. Split them again if you meant two |
| ○ | The paper dependency graph, and edit-implication notices | Two things, your ruling |
| ○ | Take build success away as a completion signal; an edit creates an obligation sized by its diff | **Nobody looked.** |
| ✅ | A fresh agent gets your project's macros | The photoshoot failure |
| ✅ | Todd talks again, with a wake budget you set at 20 and `shut-up-todd` as a label | |
| ✅ | A label dragged out of a chat filters, same as one from the agents panel | `5e6d3a4e9`. Was marked untouched |
| ✅ | A live agent is never told it was hibernating | Was marked untouched |
| ✅ | A message with unavailable macros warns instead of being refused | **It warns and sends** — `shared/chat-render-check.mjs` has an undefined-macro branch, the warning is appended to the result *after* the post and quotes the event id, which only exists because it sent. **Was marked not-started.** *(This was filed under Voice; it is about sending a message, and you asked why)* |
| ✅ | Macros display in an agent's edits | Was marked untouched |

## Voice

| | | |
|---|---|---|
| ✅ | Enter waits for your dictated tail to finalise | The message-repeating-itself thing |
| ○ | Message send lag; you suspect the voice box config | **Nobody looked.** |
| ✅ | The voice buffer cap, and a HUD that says which of two things is wrong | **Both halves shipped and are on your box** (`8b1decf8d`) — a 64 MiB `PcmBacklog` with a pref and a daemon-config key, and a HUD that returns exactly two failures, `buffered` versus `mic dead`, deliberately the same width so it does not strobe. **Was marked not-started.** Nothing tests it |
| ✅ | The voice provider picker: hide unconfigured, surface configured-but-unreachable | **Both halves on your box.** Deepgram is offered only if its bridge URL is configured; unreachability is answered at connect time with a 503 rather than the option vanishing, plus a loading/ready/error state so uncertainty says so. **Was marked not-started** |

## Deploy and infrastructure

| | | |
|---|---|---|
| ○ | **Why your box stopped for six minutes tonight** | A machine was created and told to stop seven seconds later. Neither deploy config declares a service or a minimum machine count |
| ○ | `config apply` must never be how you fix a running bot | **Nobody looked.** |
| ○ | Zero magic numbers; limits in config files, not environment variables | **Nobody looked.** |
| ○ | Move the server and daemon JavaScript to TypeScript, gradually | **Nobody looked.** |
| ○ | Token **permissions** — the switch for whether the app needs a token | Built on a branch, never merged |
| ✅ | A deploy can no longer report success on a box that is off | **Not on your box, and not in git either** — it is `verify_serving()` in the deploy hooks, which polls your box for the pushed sha and fails the push otherwise, so no `git log` can find it. **✅ here would have meant "working on your box", which it isn't** — it runs on the deploying machine. It has run twice, 10s and 20s, both successes, so **it has still never seen the failure it was written for** |
| ✅ | Push-to-deploy is cut over; the lying `deploy:live` alias is gone | |
| ✅ | `config apply` retries its own I/O error | |

## Classroom and course

| | | |
|---|---|---|
| ○ | The probability arc you designed on 08-10 | `fall-class` was told to find it and still has not been pointed at it |
| ○ | **The course website, which is the schedule** — week by week, a date list, references into the book, an authorship overlay | *"without me having everything hand coded in a million different places."* **Merged from two rows** on your own framing that the schedule is structurally the website. Say the word and they split again |
| ○ | The classroom common layer is the book layer; a demo student account | **Nobody looked.** |
| ○ | Homework structure: problems in narrative sections, stray text refuses upload | **Nobody looked.** |
| ○ | An errata page for the book, as annotations into it | **Nobody looked.** |
| ○ | Automatic lecture recording and Notability-style playback | **Nobody looked.** |
| ○ | A screen-reader-safe parallel version of the course content | **Nobody looked.** |

## Written down rather than built

| | | |
|---|---|---|
| ✅ | The chat rendering and scroll model, with an errata of its live defects | It found two scroll writers nobody knew about |
| ✅ | The window manager, with its errata | |
| ✅ | What an advocate is for, for chiefs and for advocates | Your 23:46 ruling |
| ✅ | Naming errata — the list exists | You said fix it or at least write it down |
| ○ | The README merge, then the photoshoot | **The images are not "still July 1" as the row said** — all 50 run 2026-04-28 to 2026-07-29. Either way they predate every theme that shipped on 08-11 and 08-12, so they show a UI that no longer exists |
| ○ | Documentation taxonomy, and an Overleaf onboarding section | **Nobody looked.** |
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
