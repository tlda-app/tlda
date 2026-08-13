# The list {#the-list}

**62 things**, from 92 at the start of the night. **The difference is not one subtraction:** 41
finished ones were deleted rather than ticked, several pairs were merged into one row, one was
deleted as never your ask, and four left tonight because you said the book is not this list's.
**7 of the 54 are parked rather than closed — you tabled or deferred them, which is not the same as done.**

**⚠️ built and finished, but not on your box — 4 rows as of 10:04 EDT**, against the box named
below. **From where you sit it is indistinguishable from not-done.** That count moves whenever
anything merges, so it is re-derived every time this file is written. · **✓? built and on your box,
and nobody has confirmed it works for you** — each of these says on its own row what would retire
it. ·
🔨 being worked now · ○ not started · **⏸ parked by you** — *tabled* and *deferred* are both your
words and share one mark here; not finished, nobody on it, and every row says which word you used
and why · **? nobody could establish it either way** — including whether a thing you specified was ever
built, which is different from nobody having started it

**Your box now serves `2e763c010`, but your open tab does not.** A deployed sha is not a loaded
module — **the tab you are reading this in is still running the bundle it loaded**, and none of
the eight `✓?` rows reach your screen until you refresh. Nothing here says you have seen any of it.

**Every row here was checked against your own messages.** Two turned out not to be yours and are
gone — the arXiv build, a feature an agent invented, and a row built from an example in the README. **The other 62 are things you asked for.**

Your box runs `2e763c010`, read from `/api/build-info` at 10:04 EDT; `main` is `0e646965b`, 78 ahead —
9 code files in the gap, all of it the scrollback work.

## Chat and scrolling

| | | |
|---|---|---|
| ⚠️ | **Ghost text is painted at the active tone, so it reads as real text** | **Landed as `0f5ed9efe`, on `main`, not on your box.** **Your words:** *"ghost text in search/agents panel etc is so fucking prominent it's easily confused w non-ghost."* **Both sites confirmed in `src/shapes/fleet-chat.css`:** the agents-panel spawn ghost (line 2699) is `color: var(--text-dim)` with `opacity: var(--fleet-agents-content-active)` — **the *active* content tone, on a thing meant to recede**; the filter chip ghost (line 355) is `opacity: var(--ui-tone-rest)`, 0.55, with a dashed border. **Same class as the go-there arrows: a recede-thing given operate-weight.** **And the `faint` preference barely reaches either, which is now established rather than an open question:** `.fleet-faint` redefines only the `--fleet-dim-alpha-NN` family and `--text-dim` (lines 555–581). So the spawn ghost's **colour** follows `faint` and its **opacity** does not, and the filter chip ghost is untouched by it entirely — `--ui-tone-rest` is not in that family. *Leaves the list when ghost text reads as ghost at a glance, and follows `faint` where the rest of the shape does.* `ghost-tone` |
| ⏸ | **A tool call we do not recognise renders as a wall** | **You looked and ranked it, rather than nobody having looked:** *"it can sit on the list for now I guess"*, then *"same w codex shit"* — **deferred, your word.** **Everything below stays because deferred with the evidence intact beats deleted** — whoever picks it up should not have to re-derive it from your DOM. **Captured from his own DOM before deploying, since a deploy would have destroyed it:** `wait: cell_id: 73, yield_time_ms: 30000, max_tokens: 5000, _raw: cell_id=73 … (+56 more)` — **one card's detail body is 11,951 characters**, beside a Claude card reading `Bash: command: …`. **The mechanism is in `src/fleet/activity-render.mjs`, not inferred:** `toolToCommand` switches on known tool names and returns `''` by default (line 406), so an unrecognised tool gets no summary and falls through to `toolCallArgs`, which prints **every** entry — its only filter drops `_semantic*` keys, so a sender's `_raw` is printed beside the arguments it duplicates, and an empty value still renders its key (`chars: ,`). **Your framing sets the order:** *"I think we kind of have to try to keep up"*, and *"gpt5.6-sol agents do quirky shit… this week they're using these other calls."* **So three, in this order: (1) fix the fallback** — an unrecognised tool renders like a recognised one, name, the argument that carries meaning, fold, never `_raw`; **(2) count the unrecognised tools**, because right now the only detector is you reading your chat and seeing something ugly, which is why this took a week to surface; **(3) teach it this week's codex calls** — `wait`, `write_stdin`, `cell_id`, `session_id` — third because it goes stale. *Leaves the list when an unknown tool folds like a known one and somebody can say how often unknowns appear.* Unowned |
| 🔨 | **Chat jerks while you read it, with no input from you** | The measurement is real; **whose session it is, is not established.** 688 corrections, 9 with input, scroller never moves, 200 consecutive writes at one position — but the session is attributed to you **by a shape id containing your name**, and both bursty sessions are `isTouch` while you are on the Air. **That inference is the one an agent was killed for tonight.** Treat the mechanism as sound and the attribution as open **You have this one.** The only part left with us is merging what comes out |
| ⚠️ | **Sometimes you can't scroll up, and it's worse than it used to be** | **A cause, and it matches the symptom:** `requestEarlierChatHistory` now reads the scrollback boundary **from the buffer at the moment you reach the top**, rather than the subscription remembering where it was — *"sometimes I can't scroll up"* is what a cursor held somewhere other than the hole looks like. **Merged and on `main`, not on your box:** `4c1501876` for the boundary, `288137e64` for scrollback a live-tail trim had deleted, and `a3a27f704` after the first server query turned out slower than the one it replaced. **The query plan is the evidence, not the milliseconds** — was `SEARCH events USING INDEX idx_events_type_id` with a correlated subquery per row; now `SEARCH events USING INDEX idx_events_from` with a primary-key lookup — because the control drifted between runs on the same corpus with fifteen agents on this box, so the timings carry machine noise and the plan does not. **The client half is the part that actually addresses what you reported, and no panel has scrolled with it** — `3abc405bb` is typechecked only. The server work sits underneath it, not instead of it. **Two earlier mechanisms are dead:** the scrollbar-drag one, because you are on Safari and there is no scrollbar; and the buffer-trim one, because your sessions never reached the 500-event cap it depended on. *Leaves the list when someone drives a real panel to the top of its scrollback and watches it page.* `chat-scroll` |
| 🔨 | **A list component that behaves** — one abstract component with a signature, everything implements it | Your 23:27 design, on `rc/anchored-list`, none of it on `main` or your box. **It does not fix "can't scroll up"** — the buffer, the trim and the history cursor are upstream of everything it changes, so it pages into the same hole. **The two fixes are independent and both are needed**, which also means your symptom may have had two causes the whole time, and no anchor telemetry could ever have shown the buffer one. **Five things elsewhere in the app were reaching into the old scroller and would have broken silently** — pan mode twice, the history paging guard, a screenshot overlay, and the suggestion tip, which hid on wheel and so worked on a trackpad and not under a finger. **All five found by reading, none by anything failing**; the build, the tests and the app were green throughout. Swept systematically rather than sampled, so the count is five and not "five so far" — though a consumer reaching the scroller some other way would not be in that sweep. `list-component` |
| ○ | Scroll-back prefetch | Your design is written down. Nothing built against it **You have this one.** The only part left with us is merging what comes out |
| 🔨 | **Make layers real** — *"shit in a layer stays in the fucking layer"* | **Everything is now traced. Four sites left, and three are not scroll.** The conversion audit finished at 45 counted → 10 real → 1 open; the DOM queries went 14 → 4 on one discriminator: **a layer-blind query only crosses a frame if what it reads is layer-dependent** — intrinsic SVG user space is identical in every copy, client rects and element identity are not. **The three real ones:** a scroll listener attached to the *first* chat log in the document, **so scrolling the panel you are looking at does not move the overlay**; a slides navigator that takes the first `iframe` for a shape and **can therefore drive the HUD's copy instead of yours, silently**; and a pan measurement that counts both copies — **which means every pan number anyone has quoted has been inflated.** The fourth is your side-button edge scroll, left alone on purpose. **Every one of those reductions was the owner shrinking their own count before anyone scoped work off it.** **A fourth instance, folded in from its own row rather than left standing as a defect on his box:** the anchored chat list does arithmetic without knowing which layer it is in. `heightByKeyRef` takes `row.getBoundingClientRect().height` (`FleetChatShape.tsx:2391`, **screen space, transform-scaled**), `viewportHeight` takes `el.clientHeight` (**:2340, layout space**), `geometry.total` sums the scaled heights (**:2288**), and `clampTop` at **:2293** subtracts the unscaled term from the scaled sum — **with no normalisation anywhere in the file**, whose only two camera reads sit a thousand lines away in telemetry. **Established by reading, never observed running**, and it is unobserved for a reason: the falsifier returned 0px at both zooms from a rig with **zero chat panels, zero rows, an unreachable editor, and `scale` at 1 before and after the gesture** — the camera never moved, so the clean negative was a missing subject. **It is not a live defect on your surface**: it needs a chat panel on the canvas layer at zoom ≠ 1, and HUD panels do not scale with canvas zoom — *"the chat is on the Canvas as an implementation detail. I've never seen one. I'm not supposed to ever fucking see one."* **Wrong arithmetic that is currently unreachable is still wrong.** *Leaves the list when a query cannot pick the wrong copy.* `wm-layers-rc` |
| ○ | **A math note dragged inside a pinned annotation viewer probably cannot drop into chat** | **Traced, not observed — and here is how to tell without re-deriving it.** A pinned viewer is interactive, the note renders in a clip panel with its own camera, and the drop probe is computed from the note's page centre **through the main camera**, because a ShapeUtil callback has no viewport to pass. **Predicted symptom: the drop silently does not resolve** — the probe lands where the note isn't. **The falsifier: `wm-drop-resolve` records with `kind: "chat-composer-item"`, `resolved: false`, `registeredHitCount: 0`.** If they exist it is happening; **if none exist, nobody has ever used it this way, and that is an answer too.** Nobody has run the query — the log is 6.5 GB on your box. **Your decision, one sentence: should a drag aim with the note's centre, or with the pointer, like every other drop site?** The frame-correct fix needs a viewport the callback cannot get; the pointer fix works and changes what a drag aims with. *Leaves the list when you say which.* `wm-layers-rc` |
| 🔨 | **The canvas and the annotation viewer scroll in opposite directions** | **Your report, no longer a hedge:** *"Scrolling on the canvas and scrolling in the thing are giving me opposite scroll directions."* **It is the canvas versus the viewer** — you named that after the earlier version said chat, and you were right about the phenomenon both times. **The pinned-versus-hovering question folded in here and is answered, not open: you ruled the viewer should pan.** So direction is the only live defect. **For whoever takes it: do not fix it by negating a delta.** The canvas is the reference — it is what you use all day, so the viewer conforms to it — and **a camera pan and an element scroll are opposite by convention**, so if the two paths end in different operations the inversion is structural and a minus sign would paper over the wrong thing. *Leaves the list when the same wheel gesture moves the canvas and the viewer the same way.* `wm-layers-rc` |

## The canvas

| | | |
|---|---|---|
| ⏸ | **The spatial view in the project tab is junk** | **Deferred, your word, and your dismissal with it:** *"the spatial view in the like, project tab is so junk. but whatever… who cares"*, then *"just add that to the list as like, deferred."* **The row exists so nobody rediscovers it as a find in three weeks — not so it gets worked.** Nobody looked at why, and you did not ask anyone to. |
| ✓? | **Clicking a shared markdown chip does nothing for seconds, then does everything at once** | **Read, not watched.** Two round-trips, no in-flight state, no key a second click could find — read in `openMarkdownChipFromTarget` and `openChatMarkdownColumn`. **Nobody has watched a second click produce a second object.** What you reported is a slow click you repeated and a trail of name cards. Fixed in `5e67afccb`, on `main`, and on your box since the 06:04 deploy. `markdown-chip-owner` |
| ✓? | **Dragging a markdown chip drops a name pill, not a doc-viewer ghost** | **Watched, in your own `client.log` on the Fly box** — 04:54:20→27, **2,993 `wm-drop-resolve` samples, every one `resolved:false`**, hitting an `iframe` and the annotation-viewer nav button, and **exactly one `pill deleted`, `deleter: "drag-drop"`, clean.** So the store never held many objects that minute. **Whether the trail you saw was paint over an iframe or one card seen repeatedly, nobody would assert.** Fixed in `5e67afccb`, the same commit as the markdown-chip click row — *"say the markdown chip click landed, and drag the doc viewer it opens"*. On your box since the 06:04 deploy. `markdown-chip-owner` |
| ✓? | **Resize snapping** | **The only open part of snapping, and it merged tonight** — `0049622e4`, *"a resized panel's edge snaps to its neighbours, not just a moved one"*, which also carries the guides that persisted after a drag that touched nothing. **On your box since the 06:04 deploy.** *Leaves the list when a resize snaps on your box and no guide is left behind.* `panel-snap` |
| ⏸ | **Shapes drift into the document on reload** | **Not settled, and your correction of the agent who said it was:** *"It doesn't settle it, dude. It, like, tentatively settles it."* You reloaded and nothing drifted — **on a markdown document**, and your own next test is *"maybe it'll be different in a tech document."* **Tabled by you, and your reason:** *"I tabled the second because I think it's I didn't observe it."* You reloaded twice and highlights held — once on Markdown, once on **balancing act** — so both render paths were tried. **Two clean observations are not an absence**, and drift is the class that returns intermittently. **No reproduction exists**, which is the difference between this and the two-margin row. *Comes back if it moves again.* |
| 🔨 | **The doc viewer spins at load — the layout button is only how you found it** | **The fix was reverted on `main` (`796cbb755`) and the revert has not deployed, so your box is running the reverted code right now** — `0f8b13c13` is in `2e763c010`, the revert is not. **The trigger is not the button.** A confirming run showed it spinning from page load, before any click, **so the ⊞ button was never the cause — it was the way you found it.** **The run inverted the alternative instead of arguing past it:** the fix arm held renderer at 100 / 91.6 / 78.8 with the evaluation timing out twice at 280s and **zero** `Failed to fetch`; the control sat at 29.9 / 25.0 / 57.4, answered in 15s with a payload, and had one. **The arm that spun had the healthier proxy**, so a fetch-retry storm does not merely fail to explain it — it points the other way. **And the discriminator is responsiveness, not CPU**: the CPU figures overlap, fifteen seconds against two timeouts at 280 does not. **Why the fix came off:** starting `svgReady` true removed the state flip that made each iteration a nested update, and React's depth limit only fires for nested updates in one pass — **it removed the bound, not the loop.** **What drives the remount is still unestablished**, which is what the reverted commit said of itself, and it is a fresh-eyes job rather than a handover. *Leaves the list when the doc viewer is idle at load on your box.* `canvas-bugs` |
| ⏸ | **A two-margin layout renders into one margin with a gap on refresh** | **Tabled by you:** *"we can probably table the two margin layout thing. Because, like, I haven't seen it for a while."* **Unlike the drift row, this one has a reproduction** — `canvas-bugs` reproduced it — so it is parked with a way back in, not parked for lack of evidence. *Comes back if you see it again, and there is already a repro to start from.* |
| 🔨 | **Why your iPad did not reconnect** | **The record cannot contain it, by construction — this is the finding, not an absence of one.** `src/logger.ts:94` splices the whole batch out of the queue **before** the POST and never retries, so **every log line produced while the server is unreachable is destroyed.** The disconnection window is exactly what `client.log` structurally cannot record, and the server side has nothing durable either — sync room open and close are `console.log` only. **The consequence is bigger than this row:** nobody can separate *never retried* from *retried and refused*, so **every "it broke while it was offline" report has the same hole.** *Leaves the list when the logger keeps what it fails to send, and the next disconnection leaves a record.* `why-not-resolved` |
| ⚠️ | **Place-stack forward/back over documents** | **Landed as `f0f0c691a`, on `main`, not on your box** — your box is still `2e763c010` and this is not in it. Your feature in your words: *"we maintain a place stack… like, a browser has that. Where a place is a document."* **Forward and back at the bottom of the table of contents**, cherry-picked from `place-stack-nav`, which had sat 313 commits behind. *Leaves the list when forward and back move you between documents on your box.* `sync-pm` |
| 🔨 | **Pen/handwriting correction** | **The branch exists and does not merge** — `rc/pen-correction`, 411 behind `main`, colliding in `FleetChatShape.tsx`, **which `main` has rewritten in 46 commits since it forked** and which two agents rewrote again tonight. **The finding worth keeping, because it dies with the branch otherwise:** while the pen is active chat sets `pointer-events: none`, so **`elementsFromPoint` and `caretRangeFromPoint` see straight past chat to the canvas** — which is why that branch's own first commit could never work, and its second commit says so. **Confirmed in the live page: with the pen selected, the hit-test stack at a point over a chat message is `[tl-background, tl-background__wrapper, tl-canvas]` — no chat row in it at all.** **And the fix that worked is geometric rather than hit-testing:** rectangle containment for the message, a `Range` per word for the word — **neither affected by `pointer-events`** — verified in the same page with the pen active, a message resolved and a word resolved at a point over that glyph. **On the branch as `a692e0ebf` plus its successor, whose own message says the first implementation could never work.** **Your prerequisite still stands:** *"atm chat doesnt like recognize different tools it all gets interpreted as browse but i imagine we could fix that."* **Browser-verified. Whoever re-lands the idea should not rediscover it.** *Leaves the list when a pen correction lands on the text it was drawn over.* `sync-pm` |
| 🔨 | **The image/token syntax — chips in brackets, markdown for images** | **Your older ask, and you raised its second half again this morning as though it were new — which it was, to whoever last read this row, because it said *nobody looked* the whole time.** **What you settled today, on the images half:** *"using our ref url system as a url instead of a giant fucking like 'abspath url'"*, the target form `![](image#546456)`, and the namespace rule — *"image is a namespace. fleet/image, but we're in chat, so fleet is the local namespace."* **Your priority, in your words:** *"not urgent, just nice to have"*, *"just whining"* — so nothing here is urgent, and a row that read urgent would be its own lie. **The chips-in-brackets half is not covered by any of that and does not disappear into the images half:** if `image-ref-url` lands only the image form, this row stays open with chips named. *Leaves the list when an image reference in chat is a short namespaced ref rather than a path, **and** chips in brackets are settled.* `image-ref-url` |

## Documents and markdown

| | | |
|---|---|---|
| ✓? | **The document panel shows the readme plus fourteen other documents' headings** | **Fixed in `338f81ea6`, on `main`, and on your box since the 06:04 deploy.** The loop that made every file reachable from the readme into a chapter is gone; a markdown project's document is its main file, and no condition was added — a book is a declared format, so nothing should infer chapter-hood from a link. Following a link to a document with no shape yet calls `createTemporaryMarkdownColumn`, the chip's own code path, so it lands away from you and appears in the project tab for the same reason a clicked file does. **The first attempt stacked the documents vertically, which in this app means one document; I reverted it** (`5a539ad6a` → `883303c01`) and it was rebuilt. Counterfactual run: unmodified code reproduces the welded TOC at fixture scale. **The canvas is unverified** — the link-follow crosses an iframe boundary and neither end has been exercised. `doc-panel-owner` |



## Sync, Overleaf and projects

| | | |
|---|---|---|
| ○ | Create an Overleaf project from a git repo | **Nobody looked.** |

## Fleet, agents and bots

| | | |
|---|---|---|
| ○ | **A codex partial mint gets `session_id: null` and nobody has confirmed that is harmless** | `freshSessionId` is generated for `claude` only, so a codex mint with a null `resumeId` also gets `session_id: null`. **It is believed identical to an ordinary fresh codex mint and that has not been confirmed** — the agent who found it said plainly they had not checked, which is why this is a row rather than a footnote on somebody's branch. **A test cannot close it:** the test that covers this path stubs `resumeSession`, so the behaviour under a real null `resumeId` is exactly what it does not reach. **No owner.** *Leaves the list when one real partial codex mint has been run and its seat is indistinguishable from an ordinary fresh one.* |
| ? | **A Fly token was reported leaked on 2026-07-31, and the report itself has no record** | **The credential is live, mode 600, absent from git across all refs, and absent from every reachable place scanned** — history files, deploy tree, hooks, LaunchAgents. The 1,749 `fm2_` hits in agent logs are wireguard identifiers, **proved rather than assumed**: 45 characters against 641, not a prefix, rejected exactly as garbage is. **And the delegate that raised it has no body.** Thirteen days on there is no record of what was seen, where, or by whom — **so *leaked* rests on an observation nobody wrote down**, which is either a real exposure now invisible or a task raised on nothing, **and nobody will guess between them.** **The question for you, and it is one question:** do you remember what was seen on 7/31? **If you do, the decision is real; if nobody can say, that is the answer about what the premise is worth.** **The blast radius, so the question is a fair one:** rotating costs an interactive `fly auth login` in your own terminal and **breaks every deploy across 19 apps, including `tlda-pic`, the course box** — against an unquantified risk with no evidence behind it. **Nobody is rotating anything and nobody woke you for it.** *Leaves the list when you say whether you remember it.* `quiet-the-box` |
| ○ | **A second list exists and nobody reads it** | **34 open fleet tasks, 26 of them stale, the oldest 328 hours** — and every one has an owner who is hibernating. **They are not all the same thing, and nobody knows which is which — that is the finding.** **Three kinds have already turned up in a sample of nine:** work that is *abandoned*, which needs an owner or a decision; work that is **finished and never closed**, which needs only a close and until then inflates the backlog and hides the real ones; and **eight of the nine that have no row here at all — invisible rather than duplicated**, which is the sharper version of the problem, since the risk is not that the queue mirrors this list but that it holds work this list has never heard of. **One of the nine was established done on inspection:** *build the gesture classifier in the tldraw fork*, open 276 hours — `GestureInterpreter.ts` is 418 lines, imported and instantiated on the live gesture path, and **tonight's wheel fix is built on top of it.** **That is not anyone's failure:** the work was done; finishing it and closing its task are two actions and only one of them was somebody's job. **The kinds cannot be told apart from titles** — this one only resolved because someone opened the file. **They are not imported here**, because this file is the durable artifact and mirroring the queue into it would make both wrong — **but a task with no reader is the same thing as a row nobody inherits.** **No owner.** *Leaves the list when a stale task is visible as abandoned, finished, or unheard-of, rather than uniformly as in-progress.* |
| 🔨 | **The agent read path does not fold amends** | **`thread()` returns raw events and does not fold amends the way the client does. A read carrying `types: ["chat"]` returns only the pre-amend body; an unfiltered read returns every underlying row, so one message can appear two or three times. Neither view is what you see.** **Established by a single-variable test — same agent, same window, one argument moved:** unfiltered gave 12 messages with one message three times and both amend bodies; `types: ["chat"]` gave 9, with the extra copies gone. **12 − 9 = 3, and the three that vanish are exactly the extra copies.** **The mechanism is deterministic rather than flaky:** an amend is written as its own event of type `amend` (`unified-server.mjs:6613`), **so a chat-filtered read cannot show that an amend landed — it is not in the set that was asked for.** **Your app is unaffected and this row does not claim otherwise:** the original is never mutated because it is an accountability trail, and the client folds the versions into one message with a stepper (`FleetChatShape.tsx:3074`, `chat-render.mjs:891`). **What it cost tonight: three reversals and a phantom row inside the audit that exists to remove phantoms** — an amend looks like a failed write to every agent who checks one. **The per-recipient explanation for the triple is unverified and nobody has looked at it.** *Leaves the list when an agent reading an amended message through `thread()` sees what you see.* `app-fix-forward` |
| ? | **A bot loses its own name to its mint's shell row** | **The mechanism, from the daemon ledger:** when a mint launches the process, the bot takes the minted id and keeps its canonical name — `todd`, `chat-lint`. **When the bot is already running, the mint's row squats the name and the bot is assigned `quiet-<name>` and goes inert** — `dev`, `nobody`, `grammar`, `teacher`. **So a bot has two rows and the shell's row wins.** **`quiet-` therefore has two causes and only one was known**: the sanctioned stop for a runaway bot, and this. **Killing the squatter does not hold — one was killed at 12:58 and a new mint held the name 96 seconds later**, so the next person's instinct to kill it again is already known to fail. **The question is yours and nobody has decided it: should a bot mint adopt the id in the bot's idfile rather than allocate a new one, so a bot has one row for its whole life?** `app-fix-forward` recommends yes, from your own principle — *"nothing's gonna label a fucking bot a bot except the fucking bot"*, and the idfile is the bot asserting which being it is. **Identity is yours, so nobody has acted.** *Leaves the list when a bot keeps its name across a mint.* |
| ○ | **An inert `dev` reclaims no disk** | `node_modules` eviction against a 50 GB budget, preview reaping and the `pw` pool **all arm in `onOpen` and are correctly gated** — so an inert `dev` sweeps nothing. **The box is carrying 38 GB of worktrees across 536.** **This is not a bug in the gate:** the gate is the contract working, and this is what the contract costs while a bot cannot hold its own name. **Blocked by the row above and not independently actionable** — no owner. *Leaves the list when a canonical `dev` sweeps again.* |
| ○ | **A shared parent for the fleet panels** | **You asked, 2026-08-13 03:43:12:** *"why is this not just in all or, like, some parent of the fucking …"* — **and the answer at the time was *not doing it unasked*, when you had just asked.** **The gap is real and I checked it:** all **10** `Fleet*` shapes extend `BaseBoxShapeUtil` directly, **30 shape files do**, and **no intermediate class exists anywhere in `src/shapes/`** — so there is nowhere to put shared behaviour. **Its failure mode is one this list already carries three times tonight:** behaviour repeated at every site is behaviour that will silently be missing at one — the ghost tone, todd's `to_id`, the layer-blind DOM queries. **No owner.** *Leaves the list when the fleet panels share a parent and something can be fixed in one place.* |
| 🔨 | **The server mint path is still async, and it was specified not to be** | **Your words this morning:** *"we were meant to split out the fucking like, server based mint path from the fucking CLI mint path. Because only one of these things needs to be, like, complicated and async… the CLI mint path is, like, a little complicated. It's, like, async because it's gotta do something if the server is down. But the server mint path does not need to do something if the server is down because the server fucking knows. If the server is talking to you, it's fucking up. And can just send you the fucking information the server would eventually give you anyway. From the fucking beginning."* Then: *"I don't know if that ever happened. But, like, it was specified."* **It did not happen, and the async text is still in the tree:** `mcp-server/fleet-tools.mjs:2867` and `:2872` both return *"Mint completion or failure will arrive from the server mailbox."* **Live this morning: two mints returned that sentence and neither the agent nor the promised failure ever arrived.** **Not a clean never-built** — `8f3ae7902` (08-11 21:46) gated server-originated mints on daemon route proof so that *"failed proof or daemon refusal returns an error to the caller"*, and `058c0f524` (08-11 23:01) reverted it **with no reason in the commit body.** *Leaves the list when a server mint answers with the outcome instead of a mailbox promise.* `why-not-resolved` |
| 🔨 | **The client logger throws away anything it fails to send** | `src/logger.ts:94` removes the batch from the queue before the POST and never retries, so a failed send is a destroyed record rather than a delayed one. **This is why the iPad row above cannot be answered**, and it silently costs every report about something that broke while you were offline. *Leaves the list when a batch that fails to send survives and arrives later.* `why-not-resolved` |
| 🔨 | **Every temporary-identity row in the fleet database says you are not human** | `registerHuman()` sends `human: true` (`src/fleet/fleet-data.mjs:474`), and every temporary-identity row in `fleet.db` is `human=0`, back to 2026-08-02. **Not cosmetic: `approval_id` depends on the human flag** — closing a task that needs your approval checks that the approving sender was human. *Leaves the list when a temporary identity that is you is stored as human.* `why-not-resolved` |
| 🔨 | **Bots that aren't all fucked up** | **Your framing:** *"that's a fucking item, right — to have bots that aren't all fucked up."* **One item, not five.** **Four bots are silenced** — `quiet-grammar`, `quiet-teacher`, `quiet-nobody`, `quiet-dev` — and **why is now known — see the row below: the bot loses its name to its own mint's shell row.** `quiet-` is also the sanctioned stop for a runaway bot, so the prefix has two distinct causes and only one of them is somebody stopping something. **Three produce zero lines after login**, confirmed from their own logs, which is the mechanism working. **`dev` is the contract violation:** inert on the fleet surface, still running local sweeps. Your words: *"Inertness should gate the entirety of bot behavior. That's the fucking contract."* **The destructive part of that sweep is already stopped, and this row does not claim otherwise** — the worktree removal in the code the running bot actually loads is disabled behind a stop-loss that classifies and logs instead, and it already records every candidate rather than only failures. **What is genuinely open is yours to answer**, and the code says so: the sweep cannot tell ignored *build cache*, which is reclaimable, from ignored *agent content*, which is somebody's work — so removal stays off until you say what the sweep is for. **The two bot rows above are part of this item, not separate ones:** todd never completing a handoff, and the settings tab writing per-bot preferences six of seven bots do not read. *Leaves the list when every bot is either working or deliberately silent — and silent means silent.* `fleet-bugs` |
| 🔨 | **A handoff through Todd never works** | **Found, watched on the live socket.** Your *"Todd, let's do a Direct handoff"* was delivered — todd's heartbeat wrote `fleet-event` the same second. **The payload carries `recipients: [...]` and no `to_id`.** todd reads `to_id = rawData.to_id ?? rawData.to`, gets `undefined`, and **all 17 of its addressing gates go false.** The boundary is `1638fbe33`/`ed96a97bc`, *"Group send: recipients table replaces events.to_id"*, 31 July — and todd's ledger holds **no action derived from a message of yours since 28 July.** Rotate, disinherit, escalation, poke and QA dispatch are the same gate. *Leaves the list when todd reads `recipients` and a handoff you type produces a `handoff-direct` record.* `fleet-bugs` |
| 🔨 | **A tmux session should die with the agent it was made for** | **Watched: 48 sessions, 16 belong to agents whose row is `dead: true`, 8 more resolve to no row at all, and 15 of the dead ones still hold a live pane process — 719 MB between them.** **Pid 800 is the tmux server, not a wedged launcher** — parented to launchd, 47 children, every agent shell on the machine. A tmux server keeps its first client's argv forever, so `ps` still shows a July launch that is a fossil. *Leaves the list when a dead agent has no session.* `fleet-bugs` |
| 🔨 | **Bots have no real options** | **Found, and it is an inversion.** `PrefsTab.tsx:803–819` maps over running bots and emits **the same two hardcoded controls for each** — self-check poke, countdown — with only the pref key varying by bot id. **Exactly one bot reads those keys: `todd`.** The other reader, `disposition`, is in neither the `bots:` map nor either environment list in `bots.yaml` and has no process — a repo nobody launches. Live, the tab renders three bots: `todd` works; `debt` runs `edit-debt-bot.mjs`, which reads neither key, so **both its controls are inert**; and `sodd` runs todd's code but logs `inert: requested "todd", assigned "quiet-todd"` under the alternate-name guard, so it acts on nothing and its two are inert as well. **So it is not "some bots' controls are inert" — it is every bot in the tab but one, and every configured bot but one.** **And the inversion is sharper than it looked:** `dev`, `nobody`, `grammar` and `edit-debt` each export a typed `defineConfig` schema with descriptions and `env:` keys, **nothing in `src/` or `server/` reads a schema at all** (verified with a control), and `todd` — the one bot the tab shows controls for — declares none. **Making them real is reading a schema that is already written.** **Which way it resolves is not settled.** You said *"either we fucking expose something or we don't"* and then said you had been misunderstood, so **no ruling is recorded here** — exposing the declared options and removing the two hardcoded controls are both live. *Leaves the list when the tab is coherent either way: every bot's declared options shown, or none shown for any of them.* `fleet-bugs` |
| 🔨 | **Dead agents cannot be discovered, only confirmed** | **Watched, in one response body:** `/api/fleet-table` returned `totals.dead: 0` and `wholeFleet.dead: 21103` **at the same time.** The rows carry no wrong value — **`rowForAgent` has no `dead` key at all**; it emits `status`, whose `dead` branch cannot be reached on a route fed by `getAliveAgents()`, **which no grep for where `dead` is written could have found.** **There is exactly one path that hands back a dead id:** `?filter=<fragment>` returns a `resolved_elsewhere` block with no dead filter — `waffles-the-28th` comes back as `fleet:dafa8d45`, `dead: true`. **But it is gated on the live roster matching nothing** — control: `filter=todd` matches one live agent and returns an empty block. **So any fragment broad enough to sweep also matches somebody living, which suppresses it.** You can confirm a name you already suspect; you cannot find one. **Reanimate is stuck on exactly that: it needs a name you do not have.** *Leaves the list when dead agents can be listed, and the panel's hiding is an option rather than the query.* `fleet-bugs` |
| ? | Reanimate does nothing and says nothing | **The "says nothing" half is fixed and on your box** — `3f6251e28` added the whole reanimate feedback path, pending/queued/error with a rendered status message, and server-side reasons. **"Does nothing" is still not established, and the reason this row gave was wrong.** It said the fleet has zero dead agents. **All 2,154 rows of the fleet table carry `dead: null` — the field is written nowhere**, so "zero dead" was an instrument reporting a value nobody sets, not a fact about the fleet. You say there are thousands. **Nobody can currently see a dead agent to reanimate one**, which is its own defect and may be this one `fleet-bugs` |
| 🔨 | **A mint that has not joined yet reads as `hibernating`** | **Watched in `daemon-mints.sqlite`. Not a failure — all eight of your 22:32–22:39 mints joined**, 1.9s to 242s. **What you saw is real and it is the vocabulary:** runtime states are `awake / hibernating / dead` with no *starting*, so a shell whose process has not joined yet renders **hibernating** — that is *"waffles-the-29th is hibernating"*. Each retry into that silence took the name, which is the whole `waffles → vaffles → taffles` rotation. **The theory that the agent gave up is not supported: nothing gave up.** Found alongside: `vaffles-the-28th` and `waffles-the-29th` were minted one second apart **holding the same codex session id.** *Leaves the list when a shell between mint and join has a state that says so, so retrying is never the only way to find out.* `fleet-bugs` |
| 🔨 | **Read receipts are gone — the UI is there, disconnected** | **Watched in the bundle your browser loads.** The server broadcasts `read-receipt` from two sites; **that string appears zero times in the bundle.** The receipt is drawn from `readBy`, which only `resolveChatRows` produces and only on a **history** fetch — the live push payload carries no `read`, `readBy` or `recipientCount`. **So a receipt is a snapshot from your last history load and nothing on the wire can move it.** `markRead`, whose comment says it exists for the broadcast, has one use outside its own definition and it is a lint fixture. *Leaves the list when someone reading your message changes the receipt without a reload.* `fleet-bugs` |
| 🔨 | A notification that fails to arrive must be noticed by the system | **The noticing shipped; a reader for it did not.** `c330f231b` is on your box and builds a `notification_failure` onto the wake payload. **That literal appears exactly once outside tests — the writer** — so no code consumes it. **What happens at runtime nobody has watched.** `fleet-bugs` |
| ○ | **Unexplained wakes; build notices fan out to everyone who ever touched the project** | **Your report stands; the mechanism is not what the phrase suggests, and nobody has watched a notice go out** — none has fired in 24 hours. **Checked and retracted:** no code subscribes an agent to a document on edit, on project link, or at mint. The only path that creates one is an explicit `subscribe`. **So a build card goes to a deliberately-subscribed set plus the one agent who edited** — touching a project does not put you in it. **What does stand: nothing ever removes a subscription when an agent dies.** The only deletion is an explicit `unsubscribe`; marking an agent dead touches no subscription row. **So whatever that set is, it only grows — across 21,103 dead agents.** *Blocked by the dead-agent row above, and confirmed still blocked: the one path that returns a dead id only fires when nothing living matches, so it cannot sweep the subscriber set either.* *Leaves the list when someone counts the subscribers for a document, split live and dead, and watches one notice go out.* `fleet-bugs` |
| 🔨 | **`involving:(nobody & bot)` finds nothing for an agent you can name** | **Watched on the live search, and there are two causes — the row named neither.** `involving:nobody` returns **30 of 30 rows belonging to `pull-tells-nobody`**: `resolveAgentSelector` gives exact precedence only to an id and a lineage name, so a friendly name is a `LIKE '%…%'` ordered by recency and the agent you named is **buried, not excluded** — control, `involving:fleet:9307b38c` returns its own two events in the same window. **`& bot` empties the set for a different reason: `nobody` holds no labels at all**, model `bot`, label none, while the twenty `bot` matches are label holders. *Leaves the list when an exact friendly name outranks a substring and the `nobody` bot carries the `bot` label.* `fleet-bugs` |
| ○ | Inbox affordances: archive/delete, drag a sticky to an agent, task from a note | **Nobody looked.** `fleet-bugs` |
| ✓? | **Everything that paginates announces it, at the top and at the bottom** | **Done — `2cb6cac1e`, on `main`, and on your box since the 06:04 deploy.** Your rule, 03:04–03:05: the top says it is paginated, the bottom says how to get the next page. **8 paginated surfaces; `tasks` already did it correctly and was left alone as the shape to match.** Two cannot hand back a cursor and say so rather than invent one — `roster` has no parameter to pass `/api/fleet-table`'s cursor back, and `search`'s byte budget drops results already fetched. **And a correction to what I told you about my own mistake: `/api/fleet-table` *did* announce it.** It returned `page_limited: true` and a `nextCursor`, my own output printed `nextCursor: True`, and I read 500 of 2,154 and told you zero anyway. **So the machine fields were never the gap — I was.** That is the argument for saying it in words next to them. `chat-render-doc` |
| ○ | **Who caused a build, shown on the pill and in history** | Nothing implements it. **Merged from two rows** — the build pill naming who sent it and edit attribution in history are one ask wearing two surfaces. Split them again if you meant two |
| ✓? | **The paper dependency graph, and edit-implication notices** | **It is built, it is on your box, and you already ruled on it — the row said neither.** Engine `server/lib/invalidation-graph.mjs`, route `POST /invalidation/dry-run`, client `src/invalidationGraph.ts`, projected into the inbox and both provenance panels; all present at `3d10cb3ef`. **Your ruling, 06-14:** *"isn't this the lesson we were trying to derive from this physics package that we should do invalidation along the dependency graph?"*, then the cascade — *"if a implies B and B implies C and D if you invalidate B it Cascades but if you revalidate B you validate the downstream stuff"* — then the surface: *"in terms of like a ribbon I'm not sure you're able to but in terms of tasks for sure."* You green-lit the build the same hour. **What is actually open: whether you have ever seen it fire.** *Leaves the list when you have.* |
| ✓? | **Take build success away as a completion signal; an edit creates an obligation sized by its diff** | **Not "nobody looked" — you designed it and it was built.** The `edit-debt` bot is running now as `debt` (pid 26693). Its header records your 08-10 design verbatim: the editing turn as the debounce, one amended task rather than a queue, the size showing, and **no positive counterpart because you refused one** — *"there isn't one, dude… agents want cheap garbage."* Your words tonight: *"we wrote a fucking bot to create these fucking obligations."* **What is open is whether it works** — whether `debt` is issuing obligations, whether they are sized by the diff, and whether anything still treats a build as completion. Nobody has checked that. *Leaves the list when someone has.* |


## Deploy and infrastructure

| | | |
|---|---|---|
| 🔨 | **A squashed merge is invisible to the merged-ness check this repo relies on** | **`AGENTS.md` makes the house rule *check by message*, because `main` is assembled by cherry-pick and ancestry lies. A squash defeats that too** — if the squash carries a new subject, the branch's own subjects never appear on `main` and the check returns nothing for work that landed. **The durable answer is a second check rather than a merge style:** **when subject comes back empty, check content** — symbols, files, tests run against `main`. That holds however anything was merged. **Measured on the one branch it happened to:** `sync-ledger`, landed as `760f9e395` *"say when an edit did not reach the paper"*, **all nine of its subjects absent from `main`**, while `staleSourceSyncEntries` and `recordSourceSyncRefusal` sit in `server/lib/source-sync-conflicts.mjs`, `noteRoomIsHolding` in `source-room-daemon.mjs`, `sweepStuckSourceSync` in `unified-server.mjs`, and `warnAboutFilesTooBigToCarry` **defined at `cli/tlda.mjs:506` and called at `:527` on the live source-push path**, with test coverage beside it — **five for five, nothing partial.** **Subject says never landed; content says landed.** **Scope is that one branch.** `chat-anchored-scroll` survived because its squash reused the branch's own subjects — both are on `main`, `310f17049` and `f34e43f77`, and its one absent line is a superseded wording of a commit that is there. **An earlier version of this row called it partly invisible; that was wrong and would have sent the next auditor to re-verify a healthy branch.** **Mitigation adopted: a squash lists the original subjects in its body.** *Leaves the list when a merged-ness check answers correctly whatever the merge style.* `app-fix-forward` |
| 🔨 | **The `pw` CLI leaks a process every time the pool wedges** | **Measured, not argued.** `cli/lib/pw.mjs:347` calls `spawnSync` with **no timeout**, so every verb run against a wedged pool daemon hangs forever and orphans at `ppid=1` — **35 of them, 1,167 MB, regrowing at 5.5 GB an hour.** **This is what took the box to load 30, and it was not CPU:** CPU sat at 496% of 1000%, half idle, while the machine did 8,027 pageins a second and 125 MB/s sustained — memory thrashing, not work. **It also explains two agents' uninterpretable browser wedges**, which were recorded as environment problems nobody could read. *Leaves the list when a `pw` verb against a wedged pool times out instead of orphaning.* `quiet-the-box` |
| ? | **Every CLI command should be idempotent and keep going until it is done** | **You specified this on 2026-08-12 between 00:11 and 00:16 with `crisis-manager`, and you overruled the archaeology in the same breath:** *"Like, was I don't care what the design was. This is the right design."* **So it supersedes whatever was there before and nobody needs to reconcile the two.** **Five properties, in your words:** *"mint is sort of, like, idempotent, and it just, like, keeps trying to finish the fucking job"*; *"it was also not supposed to return… until it was fucking done"*; *"if shit isn't working, you would see it happening — you would see one thing happening and the other thing failing"*; *"attempts with, like, exponential back off or whatever"*; *"and then you just background it."* **Idempotent here means resuming, not merely safe to repeat:** *"the idea is, like, mint would finish minting a fucking agent that was, like, partially minted"* — the tail of that sentence is garbled in the transcript and is not quoted. This morning you extended it past mint: *"all of the fucking CLI commands should be, like, idempotent and just, like, keep trying… until it's fucking done. And, like, if you wanna back out, you fucking control c or control z."* **The way out is your interrupt, not the command giving up.** **One of the five is built and on your box:** `28fd8bee0`, *"stream local mint progress"*, which is the see-one-thing-succeed-and-the-other-fail property. **The other four have not been established either way**, which is why this row is `?` and not not-started. **No owner.** *Leaves the list when a CLI command that is interrupted or fails resumes where it stopped, and none of them gives up.* |
| 🔨 | **Depend on the tldraw fork directly, not on a committed tarball** | **Your ruling:** *"we should depend on the fork directly… like that's why it's on github bro."* Today `package.json:42` reads `"@tldraw/editor": "file:vendor/tldraw-editor-5.2.0-tlda.11.tgz"` — **a 1.7 MB binary committed into the repo**, built from our own fork at `git@github.com:tlda-app/tldraw-fork.git`. **What makes it urgent rather than tidy:** tonight's wheel fix is **uncommitted in that fork checkout** — `M packages/editor/src/lib/components/TldrawViewport.tsx`, still dirty as of 05:52 — **so the source of a fix about to reach your box exists only as a working file.** The tarball carries the built output and the fork repo carries nothing; clean that checkout and the source is gone. **Two things nobody should have to re-derive:** the pin must name **a commit, not a branch**, or builds stop being reproducible; and `docs/vendored-tldraw-editor.md` gets **rewritten, not amended** — its premise at line 18 is *"needs no external publish"*, which stops being true, and its §*"The tarball cannot rebuild itself"* describes a tarball that will not exist. **One real check before it can land, and it is a verification rather than a deferral:** `Dockerfile.live:241–243` copies `server/package.json` and runs `npm install --production`, so a git dependency needs credentials the deploy image may not have — **and that class fails as a crash-loop, not as a build error**, which this repo has hit before. **The git-URL pin is now known to be impossible, and this is the fact that stops it being re-proposed in three weeks as an obvious oversight.** `packages/editor/package.json` in the fork declares **six siblings as `workspace:*`** — `state`, `state-react`, `store`, `tlschema`, `utils`, `validate` — and the packaging step rewrites them to concrete `5.2.0`. **Measured by comparing the two manifests rather than by reading the script: the fork source has six `workspace:*`, the shipped tarball has the same six at `5.2.0` and none workspace.** npm runs `prepare` on a git dependency, **not** `prepack`, so a git install gets the raw manifest that npm cannot resolve and fails outright; `"build"` also points outside the package, at `../../internal/scripts/build-package.ts`. **The tarball is the output of that packaging step — it is what makes the package installable at all.** **So there are two routes and the choice is yours, stated in full:** (a) **publish the packed editor to a GitHub release on the fork and pin it by URL** — no binary in this repo, resolvable with no keys, immutable so builds stay reproducible, and roughly the same size of change; or (b) **restructure the fork to unpick the six workspace dependencies**, which is a project rather than a cleanup. `app-fix-forward` has put both to you and said it would take (a). **Nothing is deleted until a replacement resolves** — the tarball stays, and that is a blocker rather than a deferral. *Leaves the list when the editor resolves from somewhere that is not a binary in this repo.* `wm-layers-rc` |
| ⏸ | Zero magic numbers; limits in config files, not environment variables | **Tabled — but hedged.** Your word was *"I guess, table"*, not the flat *table* you gave TypeScript, so this is the one to raise again sooner. Nobody on it. `infra-rows` |
| ⏸ | Move the server and daemon JavaScript to TypeScript, gradually | **Tabled**, your word, flatly. Nobody on it. `infra-rows` |
| ⚠️ | **Token permissions — the switch for whether the app needs a token** | **Landed as `eca6921b9`, on `main`, not on your box.** `authDisabled` becomes the positively-named `tokenGating`, defaulting false, cherry-picked from `fix/token-gating` at 284 behind. **The branch predated the `pic` deployment, whose `authDisabled: true` this change deletes the reader for** — so `pic` now states `tokenGating: false` explicitly at line 30, **and its posture did not change: open before, open after.** **Whether a classroom is gated is your call and nobody has made it** — that config line records the present answer and is not a decision. *Leaves the list when the switch works on your box.* `sync-pm` |

## Classroom, the app parts only

**The book and the course content are not on this list.** You said so tonight: *"You can forget
about the book. That's, like, not your shit. Except for the fucking app shit. Like, the lecture
recording."* Four rows left for that reason and are recorded below, in §Decided. **What stays here
is tlda capability that the classroom happens to need.**

| | | |
|---|---|---|
| ○ | Automatic lecture recording and Notability-style playback | **A tlda feature, not course material** — which is the one you named when you drew the line. Nobody looked. |
| ○ | The classroom common layer is the book layer; a demo student account | Both are app capabilities — a document layer and an account — rather than anything written for the course. Nobody looked. |
| ○ | **Stray text refuses upload** | The app half of the old homework-structure row. **The problem-in-a-narrative-section part was course structure and is gone**; a document the app refuses to accept is a defect either way. Nobody looked. |

## Written down rather than built

| | | |
|---|---|---|
| ⏸ | The README merge, then the photoshoot | **Tabled because you are out of energy, not because it does not matter:** *"It would be nice to do one, but, like, I just don't have the energy, bro."* The fifty images run 2026-04-28 to 2026-07-29, so every one predates the themes that shipped 08-11 and 08-12 — the README shows a UI that no longer exists. **An agent cannot shoot most of them without you.** `readme-shots` tried three framing runs on `eiv-paper` and every one pulled in whatever other agents had open — another agent's live terminal showing source and a `git status` line, and the inbox shape showing your own subject lines. **One image is shootable; the rest need a scratch project with nothing else in it, or you.** |
| ○ | Documentation taxonomy, and an Overleaf onboarding section | **Nobody looked.** |
| ○ | GitHub release: push, tag a late-alpha | Tagging waits on you. **What it is for is the release bar above** — a version good and tested, documented and carefully read, that you have lived on for a week. |
| ○ | **A release you would run on for a week** | **Your standing bar, 2026-08-09 00:52–00:56 EDT, and you have been saying it for six weeks:** *"let's just get this fucking thing, like, good and tested and all that"* · *"go test it, documented, like, carefully read"* · *"I really wanna have a release that's worth submitting as a software paper"* · *"I'm not gonna do that. Without, like, running on that version for a while… then I can run that for a week."* **The subject is the app, not the classroom:** *"It is about tilde itself. The grading side is — I almost think of that as an extension."* **The audience ladder is yours too:** *"a solid thing for the fall and then hopefully good enough to run some little workshops for interested other professors at my institution."* **And you named what has to be defensible:** *"the rendering pipeline and the versioning pipeline… and then the agent management systems, those are all important."* **The bar is not a version that ships — it is one you live on:** *"I don't wanna live unstable for a week if it sucks"*, and *"maybe we're there now. I don't know."* **The testing ask hangs off this** — DevBot exercising the running system rather than a build — and nobody has looked at it. *Leaves the list when you have run on one frozen version for a week and would still stand behind it.* |

## What I collapsed, so you can check it

**Two rows that were one thing:**

- *"The jerk is not fixed"* and *"why it jerks, narrowed to one candidate"* — one defect, one owner.
- *"Collapsing thread views work again"* and *"expanding a thread card expands it"* — same commit, and it shipped.
- *"Figures render in colour"* and the white-plate note — the plate was the whole content of the second.

**Rows that were notes, not work:** *"we stopped reacting to the resize our own scroll write caused"* — shipped, reverted, both on your box, net not in effect and correctly so. It records an investigation, not a thing to do.

**Rows moved out of the section that hid them:** the four *written down* rows were scattered across chat, canvas and fleet, which is why documentation looked like progress on each of them.

**One row flipped from done to not started:** snap to grid. It was marked ✅ *"snapping draws guides and lands the panel on the line."* You said tonight it draws a grid and does not snap to it. **Your report wins and the row is open.**

**Three things added that were not on it at all** — the markdown chip click, the chip drag, and the document panel. All three are tonight's and all three have owners.

## How this list is kept {#how-kept}

*For whoever maintains it, not for you.*

**It is inherited, never regenerated.** Rebuilding it from chat history or agent reports is the
bug — every rebuild silently drops whatever the rebuilder did not find, and those rows are not
done, they are missing. Hand over the file.

**Never a summary when the list is asked for.** A shortened version handed back becomes the next
list, and everything left out is gone. **His own carve-out, same breath:** *"if I ask for a summary
of the list, or if I ask what's going on, then you summarize the list."*

**A cause appears only if somebody looked at the running system and can say what they saw** —
not a commit, not a grep. Everything else says nobody looked, which is true and gets
investigated. A wrong cause stops people looking.

**An absence claim needs a check, the same as a done claim.** A row saying nothing exists, or that
nobody has looked, is a claim — it gets verified before it goes on.

**A row that lands carries the sha, and the sha is checked against `main` by subject first.** His
instruction: *"plz keep list updated, cool? … perhaps even tag w/ commits or whatever for
record-keeping."* **The sha is a footnote, never a changelog** — the row still says what he would
see, and `git show <sha>` answers what changed without anyone re-deriving it. **It matters most on
`⚠️`**, where *is this real* is a live question. **A wrong sha is worse than none, because it looks
like proof:** `main` here is assembled by cherry-pick, so ancestry lies and the check is
`git log --oneline main --grep=<subject>`.

**"Not tonight" has to justify itself, and the reason has to be his.** A row parked on his word
is a fact about what he decided. **A row an agent parked because it looked hard is that agent's
judgement wearing his authority** — the same shape as a decision recorded without a quotation, and
it costs more, because nobody re-opens a thing the list says he deferred. His own words for it,
2026-08-13: *"STOP 'NOT DOING IT TONIGHT'ING ME."* **If the reason on a `⏸` row is not traceable
to him, the row is not parked — it is unowned, and it says so.**

**A parked row says why you parked it, in your word.** Unobserved, no energy, not important right
now, looked-at-and-ranked — those are different, and only some of them mean come back soon.
**`tabled` and `deferred` share one mark, deliberately.** They are two words you used for one
state — not being worked, not finished, parked by you — and the difference between *he stopped it*
and *he ranked it* lives in the row's reason, where it can be read, rather than in a second symbol
nobody could tell apart. **One honest mark beats two that blur.**

**No row goes on without saying what would make it leave.** A row that cannot be retired will be
on the next list.

**A row dies when the thing that answered it arrives, not at the next audit.** Snap-to-grid
outlived its answer by four hours and he found it before we did — which made him read work that
was not work, which is the complaint. **When something lands, the row goes that minute.**

**A ruling outlives the row it answered.** When a row closes because he decided something, the
decision moves to §Decided — it does not get deleted along with the row. A decision that lives
only inside a row dies when the row does, and then it gets re-litigated.

**Anything that looks like a defect and is not gets recorded as decided, not deleted.** Delete it
and it comes back as a new row in three weeks. That is the whole two-thirds.

**Every row traces to something he asked for, and a row that cannot be traced cannot be finished
or retired — so it rides every rebuild forever.** Two have failed that check: the arXiv build, a
feature an agent invented, and the `snuffy-k3x9` row, built from an example in the README and
written up as something that happened to him. **Both were phrased as fact and neither was traced
when it went on.** `row-provenance` is now checking every row against his own messages.

**A provenance verdict has four outcomes and they are not interchangeable:**

- **traces to him** — nothing to do.
- **does not trace** — phantom. It goes, and §Decided carries the trace so it cannot come back.
- **could not establish** — genuinely different from a phantom. Some of what he asks for is said
  by voice in a session nobody logged, so an untraceable row is not thereby an invented one. **It
  stays, and it says that nobody could establish where it came from.**
- **traces but has drifted** — he reported X and the row says Y. **That is a corrupted row, not an
  invented one, and retiring it would throw away a real report.** It gets repaired to his words.

**A §Decided entry carries his own words, or the evidence and who produced it — and says which.**
Without one of those it is an agent's judgement, and that belongs on a row where somebody can
argue with it. This is the guard that stops that section becoming the place agents launder their
own opinions into his.

## Loose in the tree {#loose}

**A stale belief nobody catalogued.** `highlighterSnap`'s own comment says the HUD copy store
renders duplicates — the copy-store model that was retired. **That file is not in the window
manager's errata**, so the belief is sitting in the tree where the errata cannot warn anyone
about it, and the next person to read that comment will believe it. Not a row; a pointer.


**Three branches are unmerged, each for a reason, and none of them is "nobody got to it."** A
branch that merely looks unlanded is how shipped work gets reverted here, so the reasons are
written down rather than left to be re-derived:

- **`rc/anchored-list`** — 14 commits off `main`, head `fc7b9f539`. **Waiting on `chat-jerks`, on
  your instruction.** Not stalled.
- **`bot-label-durable`** — 3 commits, head `c9c8a93a7`. **Unfinished.**
- **`restore-chrome-faintness`** — 1 commit, head `4e65b69f1`. **Spent; merging it would revert the
  vendored fork.** The §Decided entry below has the detail.

**Two files are dirty in the shared checkout and neither is this seat's** —
`docs/source-authority-state-machine.md` and `src/overlays/FleetNudgeGuides.css`. Both have copies
under `deploy/_utils/rescued-uncommitted/`, so nothing is at risk; they are somebody's live work
and are left alone.

## Decided, so nobody opens it again {#decided}

**The arXiv build was never your ask.** *"That's fucking handled… It's never been a problem. It
only exists because some asshole decided to come up with the fucking feature."* **Recorded as
never-asked-for rather than as done** — done invites someone to check it; never-asked-for closes
it.

**You said `disposition` is not a thing any more.** *"I don't think disposition is a fucking thing
anymore."* Recorded, not acted on — it is a bot, and it is one of only two readers of the per-bot
prefs, so retiring it touches the bots-options row. Somebody will ask you what you meant.

**The snap guides were too loud and are now neutral grey at rest** — your complaint, your fix, on
`main`. Nobody should reopen *"the guides are too visible"*.

**A pinned annotation viewer pans, it does not scroll itself.** Your ruling: *"it should PAN"* —
the viewer is a window onto the canvas, not a panel with its own scrollbar. The behaviour that
looked like a bug was this working. **Only the direction is wrong, and that is a row.**

**`playback-frame` stays, unused.** 639 lines, its own tool, a registry entry and an entry in the
synced schema — exactly the shape an agent finds in three weeks and opens a row about. Your
ruling: *"nothing fucking uses it, but it's not a problem for us"*, *"I would love to have such
a thing, but it's just not important to me right now"*, *"why don't we just fucking leave it?"*

**You reopened it on 2026-08-13 and left it open**, so this entry is not authorization either way:
*"literally has never been used by a human"* at 03:51:15, then *"probably, we should delete it,
but, like, it's not a bad idea"* seven seconds later. **Hedged in both directions in one breath —
so nobody may cite the ruling above as permission to delete it, and nobody may cite the reopening
as a decision to.** It needs putting back to you.

**It is recorded here rather than as a row** because a row saying *nobody looked* would invite
exactly the rediscovery this is meant to stop.

**The book and the course content are not this list's.** *"You can forget about the book. That's,
like, not your shit. Except for the fucking app shit. Like, the lecture recording."* **Four rows
left on that ruling:** the probability arc you designed on 08-10, the course website that is the
schedule, an errata page for the book, and a screen-reader-safe parallel version of the course
content. **They are not cancelled — they are not the app's.** If one of them later needs app work,
it comes back as an app row rather than as a course row.

**A bot labels itself, and nothing else does.** *"Nothing's gonna label a fucking bot a bot. Except
the fucking bot."* **All seven configured bots already do it** — each declares `labels: ['bot', …]`
in its own login payload: `todd`, `grammar`, `chat-lint`, `dev`, `teacher`, `nobody`, `debt`
(checked one by one against `bots.yaml`, with a control). **So nobody should build a manager-side
labeller** — the thing already works the way you said it should.

**The four `com.tlda.bot.*` launchd labels look like stale jobs and are not.** They are launchd
remembering an enable/disable state for labels whose plists were renamed away months ago —
bookkeeping in its own database, nothing on the machine. **`config apply` correctly ignores them:**
his own dry run returned `Update: 0  Remove: 0  Unchanged: 4` over exactly the right set — the
three `fleet-daemon` jobs and `com.tlda.bot-manager`. **Settled by that command, relayed by
`app-fix-forward`; this seat has no launchd domain and could not run it.** **And `config apply` is
not broken** — it needs `managername = Aqua`, which is your terminal, and that is the design.
**The row it closes** — one manager supervising all bots, rather than every bot in the launch
config — **is the thing you half-remembered building, and you did build it.**

**Never screenshot a shared room for publication.** `readme-shots` tried three framing runs on
`eiv-paper` and each pulled in whatever other agents had open — **another agent's live terminal
with source and a `git status` line, and the inbox shape showing your own subject lines.** **Panel
crops are the only safe frame**; anything wide enough to show the canvas needs a scratch project
with nothing else in it. **This is a leak risk rather than an aesthetic one, and it applies to any
screenshot anybody publishes**, not only the README. Established by `readme-shots`' own three runs
and relayed by `app-fix-forward`; this seat did not shoot them.

**`restore-chrome-faintness` is spent, not merged, and merging it would have been a regression.**
It was cut before the layer work, so a merge would have **reverted the vendored fork from `.11` to
`.10` and removed 1,411 lines.** Its content reached `main` by another route — `63d7b9658`, *"let
the faint preference reach the annotation viewer's nav buttons"*. **Recorded because a stale branch
that looks unmerged is how shipped work gets reverted here**, and the branch will still be sitting
there tomorrow looking like something nobody landed. Established by `app-fix-forward`.

**You never loaded as `snuffy-k3x9`, and the row that said you did is gone.** That string was
written by `skip-hands-off` on 2026-07-28 23:18 EDT as **README example copy**; five minutes later
you quoted it back while dictating the README paragraph — *"(e.g. snuffy-k3x9)"*. **There is no
message in which you report having loaded as it**, so the row was built from an `e.g.` in
documentation. **What you did report was 2026-07-31, loading as generated names — and that was
root-caused and fixed the same night**, `4a20ee342`, *"stop the identity read from deleting the key
it rejects"*, four minutes after you raised it. **The generator itself is wanted and stays:** your
words, *"the generator is absolutely not gone. I fucking hope it's not gone"* — `temporaryIdentityName()`
at `identity-persistence.mjs:23`, **not vestigial, nobody deletes it.** Established by
`why-not-resolved`.

**`wake` was already idempotent by design before the 08-12 ruling, and that is a separate fact.**
Your words, 2026-08-09 23:24 EDT: *"Right. Like, wake is idempotent. That's the design."* The
08-12 ruling extends idempotence to every CLI command; it does not restate this one. **And `wake`'s
failure then was that the check itself was wrong** — it asked whether a session existed rather than
whether a runtime was alive in it, so a dying runtime answered *already alive*. Established by
`cchief`. **Kept apart from the CLI row so neither is read as evidence for the other.**

**JOSS is a hedged venue, not a deliverable — but the release bar behind it is real and repeated.**
Your sentence was *"perhaps for like, submitting to joss orw whatever"*, twice hedged, so **nobody
should be working on a JOSS submission.** **What that clause hangs off is not hedged at all:**
*"I really wanna have a release that's worth submitting as a software paper"*, 2026-08-09 00:52:41
EDT, and you have said it across six weeks. **An earlier entry here said the whole thing was never
asked for. That was wrong** — it read the hedged venue as standing for the intent, and the row is
now the release bar in your words.

**The stranding on the iPad is fine by you, so it is not a row.** *"The stranding thing is fucking
fine. I guess. I think that was a weird deploy quirk. I don't know."* — 2026-08-13 03:34:35 EDT.
**The stranding itself was never fixed**; what makes it survivable is that the emergency dump
appears on the sync-failure screen and notes export to markdown, which you noted in the same
breath. **It was deleted once, restored as parked, and is deleted again** — parked would mean you
want to come back to it, and you said it is fine. **The reconnect question you raised alongside it
is a separate row and stays open.**

**`chat({ amend_id })` works; the report that it silently failed was wrong.** A message to you was
amended, reported as landed, and then read as unchanged — so a row went on this list saying an
amend reports success without changing anything. **It was checked and the amend had landed:**
message 2750883 carries its corrected body in your thread at the original timestamp. **The row is
deleted, and recorded here rather than dropped, because it was a phantom created inside the audit
that exists to remove phantoms** — and because the next person to see a stale-looking amend will
otherwise open it again. **One code fact that made the false report plausible, and it is
now partly exonerated:** `amendEventText` at `server/lib/fleet-store.mjs:5032` returns `true` after
its `UPDATE` without checking that any row changed — **a latent reporting weakness, and the cause
of nothing anybody has seen**, since the amend it was supposed to explain did write. **What is
genuinely unsettled has since moved and is not view-versus-store:** a second agent reproduced a
real no-write on a message that had been read, while the amend to you — unread — landed. **The
live hypothesis is that an amend silently refuses to rewrite an already-read message**, which
would mean the documented rule *amend only what has not been read* is enforced rather than
advisory, and the defect is the success return rather than a missing write. **Nobody has
established it and there is deliberately no row**; it gets one when a message to an agent known
not to have read it is tested.

