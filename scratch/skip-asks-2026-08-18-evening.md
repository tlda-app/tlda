# Skip's asks, evening of 2026-08-18 {#asks}

His words, verbatim, in the order he said them. Where something is not a quote it is
marked as mine. **Do not work from a paraphrase of these** — he does not type, so a
summary of what he wants is an agent's account of it.

## Deadline: before noon, 2026-08-19 {#layout-13-inch}

He named the deadline and the reason himself, 15:32–15:33 EDT:

> just like fyi if you have a list you can add this to or create a task for yourself.
> this is like, **not immediate priority but needed before noon tomorrow**

> we need to calibrate our default layouts, except the phone ones, so the key shit---eg
> doc and chat-over-editor col in the editing layout---**fits on screen on a 13 inch mac**.

> have the default settings like

> make th eTOC hover region **as wide as possile** and like

> shit **as visible as possible**

> my advisor was having troible using the app on his mac

> and we meet at 1 tomorrow

15:34 EDT, the framing for the whole item:

> **beginner-appropriate-defaults is the idea**

That is the criterion to build against, and it is broader than screen size: the defaults
have to be right for someone opening tlda for the first time, who does not know what any
panel is for. A layout that fits a 13-inch screen and still requires knowing where things
are does not satisfy it.

**So the consumer is a person who is not Skip and not an agent, on a 13-inch Mac, at
13:00 tomorrow.** That is who this is for and it is why the deadline is noon rather than
end of day — it has to be right before the meeting, not during it.

**What is settled, in his words:** default layouts get calibrated so the key panels fit a
13-inch screen; phone layouts are excluded; the editing layout's doc and chat-over-editor
column are the named case; the TOC hover region gets as wide as possible; things get as
visible as possible.

**What is not settled and is a judgement call for whoever builds it:** exact widths,
breakpoints, and which panels yield first. §"Don't stop for a decision nobody needs to
make" governs — *"if you put a fucking button in the wrong place, I'll fucking tell you to
move it."* Placement and sizing inside a feature he asked for are decided by the builder.

**Two constraints from the standing contract that bear on this one directly:**

- **Defaults are a product decision.** He asked for this one explicitly, so it is
  authorised — but it changes what *everyone else* gets, so it stays scoped to what he
  named and does not grow into an onboarding or layout redesign.
- **Preserve the same interaction and layout rules at narrow and wide viewport sizes
  rather than adding a separate phone mode.** He excluded the phone layouts from
  recalibration; that is not licence to fork behaviour by width.

**Unestablished and worth one cheap check before building:** what actually broke for his
advisor. *"having troible using the app on his mac"* is a symptom without a mechanism, and
a 13-inch viewport is a hypothesis about it, not a diagnosis — his advisor's screen size
is not recorded anywhere I have seen. Ask Skip which Mac, or find the advisor's session,
before assuming the fix is width.

## Also wanted for the 1pm meeting, 15:39–15:40 EDT {#pointer-offset}

> oh uh another meeting thing / like for one tomorrow / **not urgent but it'd be nice**

> in my meeting with Jose today my like, pointer on his screen---like tldraw sync shows
> everyone's pointer---**was offset from where it appeared on my screen**

**A live multiplayer defect with a witness.** It happened in a real meeting with a real
second person, so it is not a lab report — and the same meeting shape recurs at 13:00
tomorrow. His pointer rendered to Jose at a different place than it rendered to Skip.

**He rated it himself: not urgent, nice to have.** Do not let it displace the layout item,
which has the hard noon deadline.

**Unestablished:** whether this is a camera/coordinate-space mismatch (presence broadcast
in page space and rendered in screen space, or vice versa), a zoom/DPI difference between
the two machines, or the same stale-transform family as the pan work. **Two machines at
different zoom levels is the first thing to reproduce**, because it is the cheapest and it
matches "offset" rather than "absent". `docs/window-manager.md` owns the layer and camera
model — read it before touching presence coordinates.

**Note the constraint from the standing contract:** this is genuinely a case where the
thing under test only exists once rendered and needs two participants, so it is one of the
narrow cases where driving a browser is the right instrument rather than the lazy one.

## Performance tooling — revisit, 15:35–15:36 EDT {#perf-tools}

> we used to have like / performance logging and prpfiling and did a lot with like slow
> queries / like **i thought we fixed all that shit** but like / **seems like someone
> added a bunch more** / may be useful to revisit those tools

**What exists, checked:** `server/lib/lag-profiler.mjs`, referenced from
`server/unified-server.mjs` and `server/lib/observability/telemetry-status.mjs`.

**What the history shows**, from `git log -S`:

- `21c417335` / `8ff1fe6c0` — *"Persist slow queries to a file, not only stdout"*
- `80c74a0c8` — *"Stop per-event agent loads and lost death signals; add lag profiler"*
- **`3b49375b2` — `Revert "The fleet store runs off the event loop"`**

**That revert is the one to look at first**, because moving store work off the event loop
is precisely the week of work he is describing, and something reverted it. Whether that
revert was his call or an agent's is not established and **must be traced to his own words
before anyone acts on it** — a revert can as easily be the repair as the fault.

This belongs to the audit rather than to a new project: *"someone added a bunch more"* is a
keep/cut question about commits in the window, and the slow-query log is the instrument for
finding them rather than the deliverable.

## Design rulings, 16:05–16:15 EDT — one way a file gets into sync {#one-way-in}

Given while the strip was running. **These are rulings, not preferences**, and they are the
reason several things are being deleted rather than migrated.

**Sync is the new design and the old one comes out. Now.** 15:14 EDT:

> sync is the new design / stip the old design the fuck out NOPW / NOW NOW

And the reason it has to be a deletion rather than a fix, 15:15:

> the last chief, despite that instruction, spent the entire night patching bugs in the old
> sync / when their first instruction was to get rid of it

**Math-note file sync goes.** He asked whether math notes were still file-synced, was told yes
— `MathNoteShape.tsx:445–470`, a debounced 1 s push of the whole note text as `main.md`
through the old `/push` — and ruled: **"yes. that goes"**.

**The `scratch-doc` path goes with it**, 16:12:

> 'scratch' format goes

> like, we handle adding synced files via markdown embeds, edited using the standard fucking
> like codemirror editor

> **stickies are just stickies**

**The rule those three sentences state:** there is **one** way a file gets into sync — a
markdown embed, edited in CodeMirror, like any other project file. **A canvas note is a note
and syncs nothing.** Anything that gives a sticky-shaped object a file behind it is the thing
being removed. (There is no project format literally called `scratch`; what exists is the
scratch-doc drop path at `NoteDropHandler.tsx:82` and the `scratch-` project naming at
`MarkdownDropHandler.tsx:25`.)

**A one-shot convert is fine, and already exists.** 16:14–16:15:

> if we want a convenience to like, convert a sticky or set of stickies into an in-project
> markdown doc, like that's fine

> actually we already have that — it's just treated as an emergency tool rather than real
> workflow

**I first read that as `POST /:name/inject` and told him it was protected from the strip. That
was wrong**, and he corrected it himself a minute later by explaining what scratch actually
was, 16:10–16:12:

> scratch was this idea we'd have all this garbage about like extracting/injecting auxilliary
> files into the doc

> like the mcp tools are gone afaik / possibly some server-side junk remains

> replacement workflow is like, **just parallel markdown files we copy from verbatim**

> **we just use markdown docs that are actually in the project** and like, if we want
> conveniences to move shit around in the like, ui or mcp, that's fine. **it's not core
> beavior**

**So `/inject` is the junk, not the convenience, and the scratch machinery is a trio that goes
together:**

| route | what it does |
|---|---|
| `POST /:name/extract` (`server/routes/projects.mjs:2387`) | source lines → `scratch/<slug>.md` |
| `POST /:name/inject` (`:2463`) | markdown → LaTeX → writes `.tlda/scratch/<label>.tex` |
| `POST /:name/input-scratch` (`:2821`) | that `.tex` into the document |

**`/inject` never writes into the document** — it produces an auxiliary file and returns its
path, and `/input-scratch` is what references it. That is the mechanism he is describing, and
it is why "we already have that convenience" did not mean this.

**The replacement needs no code:** a parallel markdown doc that is actually in the project,
copied from verbatim, edited in CodeMirror like any other file.

**"It's not core behavior" is the load-bearing phrase.** A convenience for moving content
around in the UI or MCP is permitted later, not requested now, and **not a reason to keep any
of the three alive as scaffolding.**

**How I got it wrong, recorded because it is the repeat:** I read the route's comment
(*"convert markdown note content to LaTeX and inject as scratch section"*) and its `↧` button,
and reported a mechanism without reading the body. The comment was accurate. Stopping at it
was the error.

## The daemon: durability stays, and SQLite is the right store {#daemon-design}

16:02–16:07 EDT, settling the fork on the daemon's queue:

> better to use sqlite for the demon? since like / it's already on people's machines / right?

> **this is a design decision**

> i think i'm with you re durability

> like if the only advantage of the other thing is speed like / i dont think that's where the
> time goes

**Both calls are his and both are right on the evidence.** SQLite is correct *because* it is
embedded and already on every machine — every off-the-shelf durable-queue library is
Postgres-backed, which for a local relay would mean a database server on each agent box. So
the store is not a constraint we are working around; it is the decision, and it is why nothing
off-the-shelf fits.

**And durability costs nothing here**, which is what his last line says: the measured
270–700 ms per flush was SQLite *read* plus `JSON.parse` of rows the daemon then skips.
Durable writes were not in it. Dropping durability would have bought nothing.

## Standing, from earlier the same evening

Recorded here because they were given in chat and chat scrolls:

- **`tlda doctor yolo`** — 14:40 EDT: *"dude just forget dr yolo"*, *"it's better than
  nothing"*, *"it should be fixed so it eventually properly integrates agents into the
  fleet"*, *"like the other cli commands, like idemptotently"*, **"NOT a prioerity"**,
  *"we shiouldnt be fucking using it"*. So: **not deleted**, fixed eventually to join the
  fleet idempotently, unused meanwhile. This supersedes the earlier "just fucking delete
  it".
- **Logging** — 15:21–15:23 EDT: *"like if we dont have adequate logs for this / like
  let's have them"*, and *"like jesus log to a gzipped file or something"*. Compress,
  never discard. The reason, in his words: *"bugs dont like, go away permanently in this
  app / i wish they did / but they dont"*.
- **Data** — 15:22 EDT: *"i have asked agents not to delete data / and yet"*.
