# The list — everything, by topic

**Every row's location checked against `3d10cb3ef`, the sha your box is running** (built
04:35:18Z). `main` has moved on since — nothing below counts it. **Re-checked 00:52.** Assembled from the four sources: last night's list in
chat, the photoshoot, what carried from previous chief sessions, and the reconstruction file —
plus the full two-day sweep of your own messages.

**Status is on the row:** ✅ done and on your box · ⚠️ half on your box, the rest built and
waiting on a deploy · 🔨 being worked · ○ not started.

**Every row is re-checked each pass, including the ones marked untouched.** The version you
caught only ever verified the rows it claimed were done — so it could be wrong in one direction
only, which is how twelve things marked untouched or being-worked turned out to have shipped.
**A count of what moved is not carried here, because it goes stale the moment the next row
does.** Each row that changed says so on itself.

## Chat, scrolling and the list component

| | | | |
|---|---|---|---|
| 1 | 🔨 | **The jerk is not fixed, and it is not about your finger.** Measured in your own session: **688 corrections, 9 deferrals** — the bursts happen with no input at all | the touch guard was a real deletion and is repaired (`794e585cc`), but that governs flicking, and you said *"nothing was coming in. No activities. No messages."* Two mechanisms open; the probe that separates them is on your box |
| 2 | 🔨 | **Why it jerks: the correction we write never moves the scroller.** `scrollTop` took **16 distinct values across 688 corrections**, 200 consecutive at one | `scrollHeight` constant throughout — so not the loop, not content growth, not clamping. Two candidates left: a delta measured in screen pixels written into layout pixels, and a write that does not land |
| 3 | ○ | **Sometimes you can't scroll up at all.** Your words: *"it's worse than it used to be. It's kind of unusable now because it fucking limits what I can actually fucking see"* | **A different defect from the jerk, and a regression claim.** Nobody is on it. Kept as its own row rather than folded into the two above, because folding it in is how a row ends up with two dispositions |
| 4 | ○ | We stopped reacting to the resize our own scroll write caused | **shipped, then reverted, and both are now on your box** — it turned out there was no loop. `scrollHeight` never moved. Net: not in effect, and correctly so |
| 5 | ✅ | The chat rendering model is written down, with an errata of tonight's defects | it found two scroll writers nobody knew about |
| 6 | 🔨 | **A list component that behaves.** Your 23:27 vision: one abstract, well-behaved component with a signature, everything implements it. Not a chat fix | you said do the hard case, ignore inbox and search, and hand it to someone as an RC |
| 7 | ✅ | Your scroll-back prefetch design is written down in your words | nothing built against it yet |
| 8 | ✅ | Collapsing thread views work again | `f8da9eb67` — a fold key plus 107 lines of thread-card control tests. **Was marked untouched; it had shipped** — *"this was implemented, I don't know what the fuck happened"*; search expands from the bottom, threads from the middle |
| 9 | ✅ | Expanding a thread card expands it | the same commit as the row above. **Was marked untouched** |
| 10 | ✅ | Fleet panels render once instead of twice | canvas copy gated behind the HUD |
| 11 | ○ | Make the layer abstraction real — a layer is a camera and a store | the largest thing on this list |
| 12 | ✅ | The window manager is written down, with its errata | |

## Themes and appearance

| | | | |
|---|---|---|---|
| 13 | ✅ | Fog restored to what it was | you reported it changed under you |
| 14 | ✅ | Label chips have their colours back, one per label | the eight-colour hash |
| 15 | ✅ | Warm is cream and lilac, not mud | |
| 16 | ✅ | "Default" is now **One** | |
| 17 | ✅ | The mint control is visible in every theme | it had gone transparent |
| 18 | ✅ | Warm mode is gone from rendered documents | you wanted a theme, not a transform |
| 19 | ✅ | Document text colour is themed | your ruling, 19:37 |
| 20 | ✅ | The default theme no longer flashes the wrong ink on first paint | |
| 21 | ✅ | Snapping draws guides **and** lands the panel on the line | it used to stop 35% short. **Nobody has felt it — you're the only instrument for whether a snap feels right** |
| 22 | ✅ | The tldraw toolbar sits at the screen edge on iPad | `210ff19ed`, one CSS rule. **Was marked untouched** |

## Settings

| | | | |
|---|---|---|---|
| 23 | ✅ | The settings panel regrouped; nine dead controls deleted or wired | 45 counted, 8 were inert |
| 24 | ✅ | The composer rail uses your touch-target setting | the magnet and terminal hover |
| 25 | ✅ | An emergency "download everything to a file" — in the settings panel, where you put it | |

## Notes, annotations and the document

| | | | |
|---|---|---|---|
| 26 | ✅ | Every sticky note anchors, not just voice notes | `91c77faf0` — `NoteDropHandler`, `noteSourceAnchor`, `MathNoteTool`. Voice notes anchored first (`153a44758`); this made it true of all of them. **Merged two rows that had become contradictory** — *"voice notes are just sticky notes"* |
| 27 | 🔨 | Figures render in colour — **on a white plate right now**, which is the bit you spotted. Transparent is the end state once the SVG rewrite lands | svglite writes the axes as literal black, so they vanish on a dark theme without it |
| 28 | ✅ | Highlights stop drifting on refresh | |
| 29 | ✅ | Shapes stop drifting on reload | `b75e0048a` gates HUD anchors on camera restore. **Was marked untouched** — you call it a regression |
| 30 | ○ | A two-margin layout renders into one margin with a gap on refresh | |
| 31 | ✅ | Macros display in an agent's edits | `23164166d`, `useProjectPreambleMacros`. **Was marked untouched** |
| 32 | ○ | Notes written on the iPad while YJS is offline are still stranded | **but no longer unrecoverable** — the emergency dump three rows up now appears on the sync-failure screen itself, which is the case this was. The stranding is unfixed; the fifteen minutes of hand-copying is not |
| 33 | ○ | The layout button after a vertical split crashes the page | |
| 34 | ○ | Place-stack forward/back over documents | built on a branch; goes at the bottom of the ToC panel |
| 35 | ○ | Pen/handwriting correction RC | built on a branch, never landed |
| 36 | ○ | The image/token syntax — chips in brackets, markdown for images | |

## Sync, Overleaf and moving projects

| | | | |
|---|---|---|---|
| 37 | ✅ | Moving a project keeps its history | four versions in, the same four out |
| 38 | ✅ | The linked-git/Overleaf tests | you called them important three times |
| 39 | ✅ | The source editor works with two people in it | |
| 40 | ○ | **Put a real paper on sync and watch it.** The instruments to tell you it broke are on your box now — the telemetry that reported "online" unconditionally is fixed (`2f4d1d694`), a dropped keystroke says so, and an edit that reaches nowhere is timed | **Nobody has run it, and no one is on it** — that is the whole of what's left. The socket record the server keeps is still wiped by every restart, which is why nobody could say why your iPad didn't come back |
| 41 | ✅ | The classroom book pushes, which it never could | 525 MB → 259 KB |
| 42 | ✅ | Quarto's cache stopped shipping in uploads | 212 MB, 54% of the payload |
| 43 | ○ | Squash tlda's shadow commits the way Overleaf does | |
| 44 | ○ | Create an Overleaf project from a git repo | |
| 45 | ○ | Build the arXiv format as well as the journal one; `xr` compatibility | |

## Fleet, agents and bots

| | | | |
|---|---|---|---|
| 46 | ✅ | A fresh agent gets your project's macros | the photoshoot failure |
| 47 | ✅ | Todd talks again, with a wake budget you set at 20 and `shut-up-todd` as a label | |
| 48 | ○ | A handoff through Todd never works | reported three times across three days |
| 49 | ○ | A bot's tmux session should die with the bot | you said "go for it" on 08-10; a session from 31 July is still waiting |
| 50 | ○ | Bots have no real options | the fake per-bot model picker is gone |
| 51 | ○ | Reanimate does nothing and says nothing | |
| 52 | ○ | Minting sonnet and terra agents fails silently | |
| 53 | ○ | You sometimes load as a generated name instead of yourself | |
| 54 | ○ | Name generation for first-time users was deleted | |
| 55 | ○ | Read receipts are gone — the UI is there, disconnected | |
| 56 | ✅ | A label dragged out of a chat filters, same as one dragged from the agents panel | `5e6d3a4e9` + 66 lines of tests. **Was marked untouched.** The cause was not drop-target resolution — `FleetChatShape` never entered the drop system at all, so a chat-origin drag could not reach the filter zones |
| 57 | ○ | `involving:(nobody & bot)` finds nothing for an agent you can name | |
| 58 | ○ | Inbox affordances: archive/delete entries, drag a sticky to an agent, task from a note | |
| 59 | ○ | Unexplained wakes; build notices fan out to everyone who ever touched the project | |
| 60 | ✅ | A live agent is never told it was hibernating | `54db1f438`. **Was marked untouched** |
| 61 | ○ | A notification that fails to arrive must be noticed by the system | |
| 62 | ⚠️ | `thread()` asks for the two-party conversation | `e163218e0` made the shorthand dyadic and is on your box; **`07e192a1e` rewrote the docstring and is on `main`, not deployed** — its own message says agents reached for `from:skip`, got you talking to everyone, and acted on instructions meant for someone else |
| 63 | ○ | The history endpoint should announce pagination the way `thread` does | |
| 64 | ○ | The build pill should name who sent it and who is responsible | |
| 65 | ○ | Edit attribution for builds, shown in history | you said "add it to the list" |
| 66 | ○ | The paper dependency graph and edit-implication notices | you ruled these are two rows, not one |
| 67 | ○ | Take build success away as a completion signal; an edit creates an obligation sized by the diff | |

## Voice

| | | | |
|---|---|---|---|
| 68 | ✅ | Enter waits for your dictated tail to finalise | the message-repeating-itself thing |
| 69 | ○ | Message send lag; you suspect the voice box config | |
| 70 | ○ | The voice buffer cap, and a HUD that says which of two things is wrong | |
| 71 | ○ | The voice provider picker: hide unconfigured, surface configured-but-unreachable | |
| 72 | ○ | A message with unavailable macros was refused instead of warned | |

## Deploy and infrastructure

| | | | |
|---|---|---|---|
| 73 | ✅ | **A deploy can no longer report success on a box that is off** — the push now waits for your box to serve the sha it pushed | ran for the first time at 00:07 and took 10 seconds — **it has never seen the failure it was written for** |
| 74 | ○ | **Why your box stopped for six minutes tonight.** A machine was created and told to stop seven seconds later | neither deploy config declares a service or a minimum machine count |
| 75 | ✅ | Push-to-deploy is cut over; the lying `deploy:live` alias is gone | |
| 76 | ✅ | `config apply` retries its own I/O error | the loop you wrote at your terminal |
| 77 | ○ | `config apply` must never be how you fix a running bot | |
| 78 | ○ | Zero magic numbers; limits in config files, not environment variables | |
| 79 | ○ | Move the server/daemon JavaScript to TypeScript, gradually | |
| 80 | ○ | Token **permissions** — the switch for whether the app needs a token | built on a branch, never merged; named wrong until you fixed it |

## Classroom and course

| | | | |
|---|---|---|---|
| 81 | ○ | The probability arc you designed on 08-10 | `fall-class` was told to find it and still hasn't been pointed at it |
| 82 | ○ | The schedule, week by week, with an authorship overlay | |
| 83 | ○ | The course website: a date list and references into the book | nothing hand-coded twice |
| 84 | ○ | The classroom common layer is the book layer; a demo student account | |
| 85 | ○ | Homework structure: problems in narrative sections, stray text refuses upload | |
| 86 | ○ | An errata page for the book, as annotations into it | |
| 87 | ○ | Automatic lecture recording and Notability-style playback | you say you have seen it work |
| 88 | ○ | A screen-reader-safe parallel version of the course content | |

## Documentation, guidance and release

| | | | |
|---|---|---|---|
| 89 | ✅ | Guidance: what an advocate is for, for chiefs and for advocates | your 23:46 ruling, both skills |
| 90 | ○ | The README merge, then the photoshoot | the nine-shot list is still good; images are still July 1 |
| 91 | ○ | Documentation taxonomy, and an Overleaf onboarding section in the README | |
| 92 | ✅ | Naming errata — the list exists, `markAgentNotAlive` is its first entry | you said fix it **or at least write it down**; the writing-down is done and on your box, the rename is not |
| 93 | ○ | GitHub release: push, tag a late-alpha | tagging waits on you |
| 94 | ○ | Submit tlda to JOSS | what the release is actually for |

## Rows I removed rather than leave you to correct

**Activity cards disappear** — you said you're not sure they do; nobody established it either way.
**Notifications and chat travelling different paths** — you said that isn't a defect and you're right.
**The 4,000 shape limit** — real, and it's tldraw's, and it was never the card thing. *"Totally
independent things."*

---

*If a line is wrong, it's wrong because we checked the wrong thing — say so and it gets
rechecked, not argued.*
