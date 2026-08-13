# The list {#the-list}

**51 things**, from 92 at the start of the night. **The difference is not one subtraction:** 41
finished ones were deleted rather than ticked, several pairs were merged into one row, one was
deleted as never your ask, and four left tonight because you said the book is not this list's.
**8 of the 51 are parked rather than closed — you tabled or deferred them, which is not the same as done.**

**⚠️ built and finished, but not on your box — no row carries this right now.** The 06:04 deploy
cleared all seven at once, which is what that mark was for. · **✓? built and on your box, and
nobody has confirmed it works for you** — a fix that has landed and not recurred is the normal
state of a fixed thing, so these leave the list when somebody sees them work, not on silence. ·
🔨 being worked now · ○ not started · **⏸ parked by you** — *tabled* and *deferred* are both your
words and share one mark here; not finished, nobody on it, and every row says which word you used
and why · ? nobody could establish it either way

**Your box now serves `2e763c010`, but your open tab does not.** A deployed sha is not a loaded
module — **the tab you are reading this in is still running the bundle it loaded**, and none of
the eight `✓?` rows reach your screen until you refresh. Nothing here says you have seen any of it.

**Every row here was checked against your own messages.** One turned out to be a feature an agent
invented — the arXiv build — and it is gone. **The other 51 are things you asked for.**

Your box runs `2e763c010`, read from `/api/build-info` at 06:23 EDT; `main` is `61f626811`, 6 ahead — all
of it list-keeping, no unshipped fixes.

## Chat and scrolling

| | | |
|---|---|---|
| ⏸ | **A tool call we do not recognise renders as a wall** | **You looked and ranked it, rather than nobody having looked:** *"it can sit on the list for now I guess"*, then *"same w codex shit"* — **deferred, your word.** **Everything below stays because deferred with the evidence intact beats deleted** — whoever picks it up should not have to re-derive it from your DOM. **Captured from his own DOM before deploying, since a deploy would have destroyed it:** `wait: cell_id: 73, yield_time_ms: 30000, max_tokens: 5000, _raw: cell_id=73 … (+56 more)` — **one card's detail body is 11,951 characters**, beside a Claude card reading `Bash: command: …`. **The mechanism is in `src/fleet/activity-render.mjs`, not inferred:** `toolToCommand` switches on known tool names and returns `''` by default (line 406), so an unrecognised tool gets no summary and falls through to `toolCallArgs`, which prints **every** entry — its only filter drops `_semantic*` keys, so a sender's `_raw` is printed beside the arguments it duplicates, and an empty value still renders its key (`chars: ,`). **Your framing sets the order:** *"I think we kind of have to try to keep up"*, and *"gpt5.6-sol agents do quirky shit… this week they're using these other calls."* **So three, in this order: (1) fix the fallback** — an unrecognised tool renders like a recognised one, name, the argument that carries meaning, fold, never `_raw`; **(2) count the unrecognised tools**, because right now the only detector is you reading your chat and seeing something ugly, which is why this took a week to surface; **(3) teach it this week's codex calls** — `wait`, `write_stdin`, `cell_id`, `session_id` — third because it goes stale. *Leaves the list when an unknown tool folds like a known one and somebody can say how often unknowns appear.* Unowned |
| 🔨 | **Chat jerks while you read it, with no input from you** | The measurement is real; **whose session it is, is not established.** 688 corrections, 9 with input, scroller never moves, 200 consecutive writes at one position — but the session is attributed to you **by a shape id containing your name**, and both bursty sessions are `isTouch` while you are on the Air. **That inference is the one an agent was killed for tonight.** Treat the mechanism as sound and the attribution as open **You have this one.** The only part left with us is merging what comes out |
| 🔨 | **Sometimes you can't scroll up, and it's worse than it used to be** | **Nobody knows why. Two mechanisms have been offered on this row and both are dead.** The scrollbar-drag one died because you are on Safari and there is no scrollbar; that commit is reverted off `main`. **The buffer-trim one is retracted too — your sessions never reached the 500-event cap it depended on.** A fix sits on a branch that was typechecked and never run, against a cause that no longer stands. **Nobody found a commit that made it worse and nobody claimed one.** **You have this one.** The only part left with us is merging what comes out |
| 🔨 | **A list component that behaves** — one abstract component with a signature, everything implements it | Your 23:27 design, on `rc/anchored-list`, none of it on `main` or your box. **It does not fix "can't scroll up"** — the buffer, the trim and the history cursor are upstream of everything it changes, so it pages into the same hole. **The two fixes are independent and both are needed**, which also means your symptom may have had two causes the whole time, and no anchor telemetry could ever have shown the buffer one. **Five things elsewhere in the app were reaching into the old scroller and would have broken silently** — pan mode twice, the history paging guard, a screenshot overlay, and the suggestion tip, which hid on wheel and so worked on a trackpad and not under a finger. **All five found by reading, none by anything failing**; the build, the tests and the app were green throughout. Swept systematically rather than sampled, so the count is five and not "five so far" — though a consumer reaching the scroller some other way would not be in that sweep. `list-component` |
| ○ | Scroll-back prefetch | Your design is written down. Nothing built against it **You have this one.** The only part left with us is merging what comes out |
| 🔨 | **Make layers real** — *"shit in a layer stays in the fucking layer"* | **Everything is now traced. Four sites left, and three are not scroll.** The conversion audit finished at 45 counted → 10 real → 1 open; the DOM queries went 14 → 4 on one discriminator: **a layer-blind query only crosses a frame if what it reads is layer-dependent** — intrinsic SVG user space is identical in every copy, client rects and element identity are not. **The three real ones:** a scroll listener attached to the *first* chat log in the document, **so scrolling the panel you are looking at does not move the overlay**; a slides navigator that takes the first `iframe` for a shape and **can therefore drive the HUD's copy instead of yours, silently**; and a pan measurement that counts both copies — **which means every pan number anyone has quoted has been inflated.** The fourth is your side-button edge scroll, left alone on purpose. **Every one of those reductions was the owner shrinking their own count before anyone scoped work off it.** *Leaves the list when a query cannot pick the wrong copy.* `wm-layers-rc` |
| ○ | **A math note dragged inside a pinned annotation viewer probably cannot drop into chat** | **Traced, not observed — and here is how to tell without re-deriving it.** A pinned viewer is interactive, the note renders in a clip panel with its own camera, and the drop probe is computed from the note's page centre **through the main camera**, because a ShapeUtil callback has no viewport to pass. **Predicted symptom: the drop silently does not resolve** — the probe lands where the note isn't. **The falsifier: `wm-drop-resolve` records with `kind: "chat-composer-item"`, `resolved: false`, `registeredHitCount: 0`.** If they exist it is happening; **if none exist, nobody has ever used it this way, and that is an answer too.** Nobody has run the query — the log is 6.5 GB on your box. **Your decision, one sentence: should a drag aim with the note's centre, or with the pointer, like every other drop site?** The frame-correct fix needs a viewport the callback cannot get; the pointer fix works and changes what a drag aims with. *Leaves the list when you say which.* `wm-layers-rc` |
| 🔨 | **The canvas and the annotation viewer scroll in opposite directions** | **Your report, no longer a hedge:** *"Scrolling on the canvas and scrolling in the thing are giving me opposite scroll directions."* **It is the canvas versus the viewer** — you named that after the earlier version said chat, and you were right about the phenomenon both times. **The pinned-versus-hovering question folded in here and is answered, not open: you ruled the viewer should pan.** So direction is the only live defect. **For whoever takes it: do not fix it by negating a delta.** The canvas is the reference — it is what you use all day, so the viewer conforms to it — and **a camera pan and an element scroll are opposite by convention**, so if the two paths end in different operations the inversion is structural and a minus sign would paper over the wrong thing. *Leaves the list when the same wheel gesture moves the canvas and the viewer the same way.* `wm-layers-rc` |

## The canvas

| | | |
|---|---|---|
| ⏸ | **The spatial view in the project tab is junk** | **Deferred, your word, and your dismissal with it:** *"the spatial view in the like, project tab is so junk. but whatever… who cares"*, then *"just add that to the list as like, deferred."* **The row exists so nobody rediscovers it as a find in three weeks — not so it gets worked.** Nobody looked at why, and you did not ask anyone to. |
| ✓? | **Clicking a shared markdown chip does nothing for seconds, then does everything at once** | **Read, not watched.** Two round-trips, no in-flight state, no key a second click could find — read in `openMarkdownChipFromTarget` and `openChatMarkdownColumn`. **Nobody has watched a second click produce a second object.** The row used to say *"this is what filled your canvas tonight"*; **that is struck** — see the markdown-chip drag row, where the only record of that minute shows one drag and one pill. What you reported is a slow click you repeated and a trail of name cards. Fixed in `5e67afccb`, on `main`, and on your box since the 06:04 deploy. `markdown-chip-owner` |
| ✓? | **Dragging a markdown chip drops a name pill, not a doc-viewer ghost** | **Watched, in your own `client.log` on the Fly box** — 04:54:20→27, **2,993 `wm-drop-resolve` samples, every one `resolved:false`**, hitting an `iframe` and the annotation-viewer nav button, and **exactly one `pill deleted`, `deleter: "drag-drop"`, clean.** So the store never held many objects that minute. **Whether the trail you saw was paint over an iframe or one card seen repeatedly, nobody would assert.** Fixed in `5e67afccb`, the same commit as the markdown-chip click row — *"say the markdown chip click landed, and drag the doc viewer it opens"*. On your box since the 06:04 deploy. `markdown-chip-owner` |
| ✓? | **Resize snapping** | **The only open part of snapping, and it merged tonight** — `0049622e4`, *"a resized panel's edge snaps to its neighbours, not just a moved one"*, which also carries the guides that persisted after a drag that touched nothing. **On your box since the 06:04 deploy.** *Leaves the list when a resize snaps on your box and no guide is left behind.* `panel-snap` |
| ⏸ | **Shapes drift into the document on reload** | **Tabled by you, and your reason:** *"I tabled the second because I think it's I didn't observe it."* You reloaded twice and highlights held — once on Markdown, once on **balancing act** — so both render paths were tried. **Two clean observations are not an absence**, and drift is the class that returns intermittently. **No reproduction exists**, which is the difference between this and the two-margin row. *Comes back if it moves again.* |
| ⏸ | **Notes written on the iPad while Yjs is offline are stranded** | **Tabled by you, not fixed** — *"the stranding thing is fucking fine. I guess."* The stranding itself is unfixed; what makes it survivable is that the emergency dump appears on the sync-failure screen and notes export to markdown. **I deleted this earlier as finished and that was wrong** — you decided it does not matter, which is not the same as it being done. *Comes back if you lose work to it.* |
| 🔨 | **The layout button after a vertical split crashes the page** | **Fixed and on `main`: `0f8b13c13`**, *"the doc viewer's layout button no longer remounts it to death"*, one file, `FleetDocViewShape.tsx`. **On your box now — the deploy at 06:04 serves `2e763c010`, which contains it.** **That verification was withdrawn by the agent who ran it.** The control read identical to the treatment — *fix build: 0 mounts, 0 removals, no crash; control build with the fix reverted: the same* — **and identical numbers from opposite builds means the rig measured nothing.** **Why, and this is what the next attempt needs first:** `FleetDocViewShape.tsx:711` mounts `CanvasClipPanel` only when `bounds && docviewSurface && mainEditor && (targetShapeId \|\| svgReady)`, so **a default-layout docview has no target and no bounds and the nested viewport never mounts** — the ⊞ click engaged on a panel with nothing inside it. **`nestedViewport: false` is the discriminator: assert it is `true` before measuring, rather than discovering afterwards that it was not.** **`canvas-bugs`' original measurement is untouched** — 51 mounts against React's 50-deep limit on `eiv-paper`, with a chat-panel control that did not crash. The gap was the scratch project, not their finding. **Landed and unverified; a void measurement is not evidence in either direction.** **Reproduced, with a cause and a control.** On `eiv-paper`: **51 remounts against React's limit of 50.** The control — the same sequence on a chat panel — does not crash. **The row said nobody looked and that is no longer true.** Not fixed. *Leaves the list when the sequence stops remounting past the limit and you can split without it going white.* `canvas-bugs` |
| ⏸ | **A two-margin layout renders into one margin with a gap on refresh** | **Tabled by you:** *"we can probably table the two margin layout thing. Because, like, I haven't seen it for a while."* **Unlike the drift row, this one has a reproduction** — `canvas-bugs` reproduced it — so it is parked with a way back in, not parked for lack of evidence. *Comes back if you see it again, and there is already a repro to start from.* |
| ○ | **Why your iPad did not reconnect** | **Nobody has checked.** Agents have speculated the shape schema changed; **that is speculation nobody has tested, and it is on this row as speculation, not as a cause.** *Leaves the list when someone reads the session record for that reconnect and can say what happened.* |
| ○ | Place-stack forward/back over documents | Built on a branch, never landed |
| ○ | Pen/handwriting correction | Built on a branch, never landed |
| ○ | The image/token syntax — chips in brackets, markdown for images | **Nobody looked.** |

## Documents and markdown

| | | |
|---|---|---|
| ✓? | **The document panel shows the readme plus fourteen other documents' headings** | **Fixed in `338f81ea6`, on `main`, and on your box since the 06:04 deploy.** The loop that made every file reachable from the readme into a chapter is gone; a markdown project's document is its main file, and no condition was added — a book is a declared format, so nothing should infer chapter-hood from a link. Following a link to a document with no shape yet calls `createTemporaryMarkdownColumn`, the chip's own code path, so it lands away from you and appears in the project tab for the same reason a clicked file does. **The first attempt stacked the documents vertically, which in this app means one document; I reverted it** (`5a539ad6a` → `883303c01`) and it was rebuilt. Counterfactual run: unmodified code reproduces the welded TOC at fixture scale. **The canvas is unverified** — the link-follow crosses an iframe boundary and neither end has been exercised. `doc-panel-owner` |



## Sync, Overleaf and projects

| | | |
|---|---|---|
| ✓? | **One binary file made a stale-base push unrebasable, forever** | **Found and fixed tonight — `9657e586a`, on `main`, and on your box since the 06:04 deploy.** Classification ran over the union of every path rather than the changed ones, and one unmergeable sibling failed the whole batch, **so a single `.png` poisoned every rebase of files it had nothing to do with.** It worked on a probe and failed on any paper with a figure in it. **Now run rather than read** (`d21c9f0c6`): a paper with three figures and a bibliography nobody touches, two people editing different chapters from their own machines, through the real push route — before the fix, refused as `stale-base`; after it, both chapters land and the figures are carried. The run also found that a text-only fixture **cannot** produce this class, which is why the suite never caught it. `sync-pm` |
| ○ | Create an Overleaf project from a git repo | **Nobody looked.** |

## Fleet, agents and bots

| | | |
|---|---|---|
| 🔨 | **Bots that aren't all fucked up** | **Your framing:** *"that's a fucking item, right — to have bots that aren't all fucked up."* **One item, not five.** **Four bots are silenced** — `quiet-grammar`, `quiet-teacher`, `quiet-nobody`, `quiet-dev` — and **why is unknown**; `quiet-` is the sanctioned stop for a runaway bot, so this may be entirely correct. **Three produce zero lines after login**, confirmed from their own logs, which is the mechanism working. **`dev` is the contract violation:** inert on the fleet surface, still running local sweeps. Your words: *"Inertness should gate the entirety of bot behavior. That's the fucking contract."* **The destructive part of that sweep is already stopped, and this row does not claim otherwise** — the worktree removal in the code the running bot actually loads is disabled behind a stop-loss that classifies and logs instead, and it already records every candidate rather than only failures. **What is genuinely open is yours to answer**, and the code says so: the sweep cannot tell ignored *build cache*, which is reclaimable, from ignored *agent content*, which is somebody's work — so removal stays off until you say what the sweep is for. **The two bot rows above are part of this item, not separate ones:** todd never completing a handoff, and the settings tab writing per-bot preferences six of seven bots do not read. *Leaves the list when every bot is either working or deliberately silent — and silent means silent.* `fleet-bugs` |
| 🔨 | **A handoff through Todd never works** | **Found, watched on the live socket.** Your *"Todd, let's do a Direct handoff"* was delivered — todd's heartbeat wrote `fleet-event` the same second. **The payload carries `recipients: [...]` and no `to_id`.** todd reads `to_id = rawData.to_id ?? rawData.to`, gets `undefined`, and **all 17 of its addressing gates go false.** The boundary is `1638fbe33`/`ed96a97bc`, *"Group send: recipients table replaces events.to_id"*, 31 July — and todd's ledger holds **no action derived from a message of yours since 28 July.** Rotate, disinherit, escalation, poke and QA dispatch are the same gate. *Leaves the list when todd reads `recipients` and a handoff you type produces a `handoff-direct` record.* `fleet-bugs` |
| 🔨 | **A tmux session should die with the agent it was made for** | **Watched: 48 sessions, 16 belong to agents whose row is `dead: true`, 8 more resolve to no row at all, and 15 of the dead ones still hold a live pane process — 719 MB between them.** **An earlier version of this row was wrong and dangerous:** it named pid 800 as a wedged launcher. **Pid 800 is the tmux server** — parented to launchd, 47 children, every agent shell on the machine. A tmux server keeps its first client's argv forever, so `ps` still shows a July launch that is a fossil; the dot-versus-underscore detail chased for hours was an artifact of reading it. *Leaves the list when a dead agent has no session.* `fleet-bugs` |
| 🔨 | **Bots have no real options** | **Found, and it is an inversion.** `PrefsTab.tsx:803–819` maps over running bots and emits **the same two hardcoded controls for each** — self-check poke, countdown — with only the pref key varying by bot id. **Exactly one bot reads those keys: `todd`.** The other reader, `disposition`, is in neither the `bots:` map nor either environment list in `bots.yaml` and has no process — a repo nobody launches. Live, the tab renders three bots: `todd` works; `debt` runs `edit-debt-bot.mjs`, which reads neither key, so **both its controls are inert**; and `sodd` runs todd's code but logs `inert: requested "todd", assigned "quiet-todd"` under the alternate-name guard, so it acts on nothing and its two are inert as well. **So it is not "some bots' controls are inert" — it is every bot in the tab but one, and every configured bot but one.** **And the inversion is sharper than it looked:** `dev`, `nobody`, `grammar` and `edit-debt` each export a typed `defineConfig` schema with descriptions and `env:` keys, **nothing in `src/` or `server/` reads a schema at all** (verified with a control), and `todd` — the one bot the tab shows controls for — declares none. **Making them real is reading a schema that is already written.** **Which way it resolves is not settled.** You said *"either we fucking expose something or we don't"* and then said you had been misunderstood, so **no ruling is recorded here** — exposing the declared options and removing the two hardcoded controls are both live. *Leaves the list when the tab is coherent either way: every bot's declared options shown, or none shown for any of them.* `fleet-bugs` |
| 🔨 | **Dead agents cannot be discovered, only confirmed** | **Watched, in one response body:** `/api/fleet-table` returned `totals.dead: 0` and `wholeFleet.dead: 21103` **at the same time.** The rows carry no wrong value — **`rowForAgent` has no `dead` key at all**; it emits `status`, whose `dead` branch cannot be reached on a route fed by `getAliveAgents()`, **which no grep for where `dead` is written could have found.** **There is exactly one path that hands back a dead id:** `?filter=<fragment>` returns a `resolved_elsewhere` block with no dead filter — `waffles-the-28th` comes back as `fleet:dafa8d45`, `dead: true`. **But it is gated on the live roster matching nothing** — control: `filter=todd` matches one live agent and returns an empty block. **So any fragment broad enough to sweep also matches somebody living, which suppresses it.** You can confirm a name you already suspect; you cannot find one. **Reanimate is stuck on exactly that: it needs a name you do not have.** *Leaves the list when dead agents can be listed, and the panel's hiding is an option rather than the query.* `fleet-bugs` |
| ? | Reanimate does nothing and says nothing | **The "says nothing" half is fixed and on your box** — `3f6251e28` added the whole reanimate feedback path, pending/queued/error with a rendered status message, and server-side reasons. **"Does nothing" is still not established, and the reason this row gave was wrong.** It said the fleet has zero dead agents. **All 2,154 rows of the fleet table carry `dead: null` — the field is written nowhere**, so "zero dead" was an instrument reporting a value nobody sets, not a fact about the fleet. You say there are thousands. **Nobody can currently see a dead agent to reanimate one**, which is its own defect and may be this one `fleet-bugs` |
| 🔨 | **A mint that has not joined yet reads as `hibernating`** | **Watched in `daemon-mints.sqlite`. Not a failure — all eight of your 22:32–22:39 mints joined**, 1.9s to 242s. **What you saw is real and it is the vocabulary:** runtime states are `awake / hibernating / dead` with no *starting*, so a shell whose process has not joined yet renders **hibernating** — that is *"waffles-the-29th is hibernating"*. Each retry into that silence took the name, which is the whole `waffles → vaffles → taffles` rotation. **The theory that the agent gave up is not supported: nothing gave up.** Found alongside: `vaffles-the-28th` and `waffles-the-29th` were minted one second apart **holding the same codex session id.** *Leaves the list when a shell between mint and join has a state that says so, so retrying is never the only way to find out.* `fleet-bugs` |
| ○ | **Why your identity failed to resolve, so you loaded as `snuffy-k3x9`** | **The two halves of the old row contradicted each other and only one was true. The generator is not deleted** — `temporaryIdentityName()` is alive at `identity-persistence.mjs:23`, called from `IdentityPicker`, and `snuffy-k3x9` is exactly its output. Your words: *"The generator is absolutely not gone. I fucking hope it's not gone."* **It is wanted, so nobody should delete it as vestigial.** **The real question is different:** that function is for *before* you have told the app who you are, so getting one does not mean it misfired — **it means your identity did not resolve at that moment, and the fallback did its job.** *Leaves the list when someone can say why resolution failed.* Nobody on it; `fleet-bugs` established the generator half. |
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
| 🔨 | **Depend on the tldraw fork directly, not on a committed tarball** | **Your ruling:** *"we should depend on the fork directly… like that's why it's on github bro."* Today `package.json:42` reads `"@tldraw/editor": "file:vendor/tldraw-editor-5.2.0-tlda.11.tgz"` — **a 1.7 MB binary committed into the repo**, built from our own fork at `git@github.com:tlda-app/tldraw-fork.git`. **What makes it urgent rather than tidy:** tonight's wheel fix is **uncommitted in that fork checkout** — `M packages/editor/src/lib/components/TldrawViewport.tsx`, still dirty as of 05:52 — **so the source of a fix about to reach your box exists only as a working file.** The tarball carries the built output and the fork repo carries nothing; clean that checkout and the source is gone. **Two things nobody should have to re-derive:** the pin must name **a commit, not a branch**, or builds stop being reproducible; and `docs/vendored-tldraw-editor.md` gets **rewritten, not amended** — its premise at line 18 is *"needs no external publish"*, which stops being true, and its §*"The tarball cannot rebuild itself"* describes a tarball that will not exist. **One real check before it can land, and it is a verification rather than a deferral:** `Dockerfile.live:241–243` copies `server/package.json` and runs `npm install --production`, so a git dependency needs credentials the deploy image may not have — **and that class fails as a crash-loop, not as a build error**, which this repo has hit before. **The git-URL pin is now known to be impossible, and this is the fact that stops it being re-proposed in three weeks as an obvious oversight.** `packages/editor/package.json` in the fork declares **six siblings as `workspace:*`** — `state`, `state-react`, `store`, `tlschema`, `utils`, `validate` — and the packaging step rewrites them to concrete `5.2.0`. **Measured by comparing the two manifests rather than by reading the script: the fork source has six `workspace:*`, the shipped tarball has the same six at `5.2.0` and none workspace.** npm runs `prepare` on a git dependency, **not** `prepack`, so a git install gets the raw manifest that npm cannot resolve and fails outright; `"build"` also points outside the package, at `../../internal/scripts/build-package.ts`. **The tarball is the output of that packaging step — it is what makes the package installable at all.** **So there are two routes and the choice is yours, stated in full:** (a) **publish the packed editor to a GitHub release on the fork and pin it by URL** — no binary in this repo, resolvable with no keys, immutable so builds stay reproducible, and roughly the same size of change; or (b) **restructure the fork to unpick the six workspace dependencies**, which is a project rather than a cleanup. `app-fix-forward` has put both to you and said it would take (a). **Nothing is deleted until a replacement resolves** — the tarball stays, and that is a blocker rather than a deferral. *Leaves the list when the editor resolves from somewhere that is not a binary in this repo.* `wm-layers-rc` |
| ⏸ | Zero magic numbers; limits in config files, not environment variables | **Tabled — but hedged.** Your word was *"I guess, table"*, not the flat *table* you gave TypeScript, so this is the one to raise again sooner. Nobody on it. `infra-rows` |
| ⏸ | Move the server and daemon JavaScript to TypeScript, gradually | **Tabled**, your word, flatly. Nobody on it. `infra-rows` |
| ○ | Token **permissions** — the switch for whether the app needs a token | Built on a branch, never merged |

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
| ⏸ | The README merge, then the photoshoot | **Tabled because you are out of energy, not because it does not matter:** *"It would be nice to do one, but, like, I just don't have the energy, bro."* The fifty images run 2026-04-28 to 2026-07-29, so every one predates the themes that shipped 08-11 and 08-12 — the README shows a UI that no longer exists. **Correction to what this row said an hour ago:** it claimed an agent could shoot most of them without you. **That is wrong.** `readme-shots` tried three framing runs on `eiv-paper` and every one pulled in whatever other agents had open — another agent's live terminal showing source and a `git status` line, and the inbox shape showing your own subject lines. **One image is shootable; the rest need a scratch project with nothing else in it, or you.** |
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

## How this list is kept {#how-kept}

*For whoever maintains it, not for you.*

**It is inherited, never regenerated.** Rebuilding it from chat history or agent reports is the
bug — every rebuild silently drops whatever the rebuilder did not find, and those rows are not
done, they are missing. Hand over the file.

**Never a summary when the list is asked for.** A shortened version handed back becomes the next
list, and everything left out is gone.

**A cause appears only if somebody looked at the running system and can say what they saw** —
not a commit, not a grep. Everything else says nobody looked, which is true and gets
investigated. A wrong cause stops people looking.

**An absence claim needs a check, the same as a done claim.** Three rows tonight said *nobody
looked* about something already built and running — the arXiv build, the edit-debt bot, the name
generator. **That is the mirror of the defect he caught at midnight:** then, finished rows were
checked and unstarted ones were not; now the unstarted ones assert absence and nobody checks
those either. **A row saying nothing exists is a claim, and it gets verified before it goes on.**

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

**Every row has been traced to something he asked for.** Checked once, 2026-08-13 04:55, against
his own thread and the reconstruction he called fine — not against a previous list. **One row
failed the check and was deleted**: the arXiv build, which existed because an agent invented the
feature. **A row nobody can trace to him cannot be finished and cannot be retired, so it rides
every rebuild forever.** That is the two-thirds.

**A §Decided entry carries his own words, or the evidence and who produced it — and says which.**
Without one of those it is an agent's judgement, and that belongs on a row where somebody can
argue with it. This is the guard that stops that section becoming the place agents launder their
own opinions into his. **The evidence half was added on 2026-08-13** when a row was settled by a
command he ran rather than by a ruling: the rule as first written would have forced that fact out
of the section entirely, which is how a true finding gets deleted silently instead of recorded.
**Eight entries quote him; two cite evidence and name who produced it; checked.**

**Run a case whose answer you already know, before you believe the one you don't.** That is the
cheapest reliable check anyone here has found, and it has now caught two failures of opposite
kinds. **A search that found nothing:** an `-iE` flag this seat passed to `git log --grep` was
invalid, stderr was swallowed, and all 56 open rows came back "nothing" — a control row with a
known match exposed it. **A test that found nothing:** a crash-fix rig reported 0 mounts and no
crash, and so did the same rig with the fix reverted, because the panel under test never mounted.
**Neither was visible from its own output.** Both were one known-answer case away from obvious.

**A grep is evidence about a pattern, not about a fact — and shipped code is minified.** A first
bundle check tonight reported the entire deploy missing: `0.0375` ships as `.0375`, and
`camera.y - delta.y` becomes `e.y+L.y/e.z`. **That would have gone to him as "the deploy did not
work."** Check a shipped bundle for the transformed shape, or check the running surface instead.

**A claim about machine state says how it was known.** Read from a log, run just now, relayed by
somebody else — those are different, and only the middle one is evidence you can stand behind.
**And the failures all have one shape: something answered confidently about a nearby artifact
rather than the real one.** `node_modules` for a pin. A local `dist/` for a deployment. A grep for
a minified literal. An empty doc-view for a crash. An invalid flag for a search. **Each was a true
statement about the wrong object.** The question that catches it is not *am I sure* but *is this
the thing itself, or something beside it.* Three claims tonight were asserted as established and
then disproved by somebody checking, and all three could have been reported as read instead. **This seat cannot run `launchctl` at all** —
zero jobs visible, `com.apple` included — so anything launchd here is relayed by construction and
says so.

## Loose in the tree {#loose}

**A stale belief nobody catalogued.** `highlighterSnap`'s own comment says the HUD copy store
renders duplicates — the copy-store model that was retired. **That file is not in the window
manager's errata**, so the belief is sitting in the tree where the errata cannot warn anyone
about it, and the next person to read that comment will believe it. Not a row; a pointer.

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

