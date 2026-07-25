# Fleet design rules

Skip's rules, in his words. They are not style preferences — every one of them was
stated because the code violated it and cost him the use of the app.

If you are about to write something that breaks one of these, you are writing the bug.

---

## One path per act

> "There are not fallbacks. Not like, oh, if this is lying around, use it. There's just
> one fucking way things get done so the behavior is predictable."

Every "robustness" addition that creates a second route to the same answer is the
defect, not the safeguard. Two routes means behavior changes depending on which one
wins, and nobody can predict the app.

**Corollary — this is NOT "fail when the input is missing."**

> "The whole design is decoupled."

Steps do not wait on each other. Process launch, server id request, and session
discovery proceed independently and their facts link as they land. A fact that has not
arrived is **not-yet**, not absent. You wait, quietly, with zero outbound effects.

Writing a failure path for a fact that is merely in flight is how the activity health
probe froze the entire fleet at `unavailable`.

A *requested* operation may still fail. `wake` fails if that agent's session isn't
found — that's a true answer to a direct question. The not-yet rule governs background
discovery, not operator requests.

## One process reads the JSONLs

> "There's not supposed to be two separate processes looking at JSONLs. There's one
> process."

One process tails them, reads the login marker, and decides mine / ignore / not-yet.
Nothing else opens them. A separate scanner that re-derives ownership by reading file
contents is both a second reader and a second route, and it is what marked 2360 of
2372 files unowned and blacked out the activity feed.

## The replacement's references get moved; the old thing doesn't just sit there

> "I'm not saying they're dead code outright. It's redundant code that is probably
> somewhat broken, and the references have to be moved from the shit that should be
> stripped to the fucking new thing."

When you replace a mechanism, move every caller onto it and delete the old one in the
same breath. Leaving both means the old one keeps running, keeps costing, and teaches
the next reader the wrong model.

Three instances found in one night: the content scan vs. the login marker, the
pending-seat-binding watcher vs. `bindAgentSeat`, and `resolveWiretaps` vs. the
in-memory agent indexes.

## Single indexed queries, not loops of lookups

> "One of the major performance issues is that we're not writing things as, like,
> single queries that do what they fucking need and are indexed."

A loop in JavaScript that makes one database call per iteration is the bug. Write the
one query the index answers.

And where an in-memory index already exists, use it:

> "Is this not why we maintain filter sets? As sets of agents that are event based
> updated."

**An index is not a cache.**

> "It's not a cache. It's an in-memory index effectively."

A cache is a second copy of the truth that drifts and needs invalidating — that's the
disease. An index is maintained as the data changes: no second copy, nothing to go
stale, no invalidation path.

## Don't shrink the data to hide a slow path

Pruning buys weeks and then it grows back. It also destroys the record of what has been
breaking. The app has to be fine with a big database; size must stop being able to make
the server deaf.

Before optimizing any query, ask whether it should run at all:

> "Computing something no one fucking wants."

## Where information lives — this is already specified, stop re-deciding it

> "I am sick to death of fucking saying this information doesn't belong here. I have
> specified where everything goes. If it's local information, it's in the daemon."

**Local information lives in the daemon.** That is the whole rule. Sessions, tmux,
launch recipes, cursors, process state — all local, all daemon. If you find yourself
weighing whether the server should hold some local fact "for routing" or "for history"
or "for display", the answer was decided before you got here: no.

## What the server knows

> "The server needs to know which daemon owns the agent, and that's it."

**Amended by Skip the same night:** *"I said the server doesn't need to know what model
shit is, but it actually kind of does. Just for display."* Model belongs server-side
because Skip has to see it — the UI is served from there, so display facts are the
server's business.

The line is **operational vs. display**, not server vs. daemon-holds-nothing. Session
ids, tmux, launch recipes and cursors are operational and local: the server never needs
them to do anything. Model, friendly name, and a wakeable indicator are things a person
reads on a screen. When in doubt, ask whether the server needs it to *act* or Skip needs
it to *look at*.

**And if a display value isn't there, show nothing — never a fallback.**

> "Some of the model and effort and other stuff used to be in the display. And the fact
> that we're not getting errors is just because there were fallbacks or whatever. Just
> don't display it if it's not [there]."

> "It doesn't have any plausible value. It just doesn't show the thing."

> "That's a decent behavior. Effort isn't a thing for every model. Ultimately effort is
> just displaying the mint options."

> "Which are things that are enumerated in the daemon, per model."

Nothing fabricates a value; the field simply doesn't render, and **that is correct.**
What the panel shows is the mint options as they were given, and which options exist is
**enumerated in the daemon, per model** — so effort on a model that has no effort has
nothing to display, and its absence is normal rather than a defect. Don't add an error,
a placeholder, or a default for it.

Note where that puts the authority: the daemon knows which options a model has, the
server carries the chosen values for display, and the panel renders what it's given.
Nobody in that chain needs a table of model capabilities of their own.

The server holds the agent id, which daemon owns it, and the friendly name. Not the
session id, not session lists, not resume ids, not tmux information.

> "The server does not know about session."

Routing a terminal to an agent goes *through the daemon*. The daemon knows the tmux
window; the server does not need to. History is not a reason to keep a session field
server-side — the JSONLs carry their own login markers and are the record.

**History is never destroyed.** Live code stops depending on old fields; existing rows
stay as they are.

## "Ask ops" is for math agents. App agents own the app.

> "You guys are app developers. It's your fucking app. Why are you acting like this is
> somebody else's problem? That instruction was for math agents."

> "It was literally saying: if something is wrong with the app that's preventing you from
> doing math, don't debug the app."

The route-to-ops guidance exists so a **math** agent doesn't abandon a proof to debug
infrastructure. It is not a lane boundary for people building tlda. If you are working
on this app and you hit a broken daemon, an unloaded launchd job, a dead socket or a
misconfigured box, that is your problem — infrastructure included.

Handing it to ops is the same defect as everything else here: a second mechanism for a
job you already own, and one that leaves the work undone when the other seat is asleep.

## A stray fleet shape is a permanent tax on every client

Fleet panels are shapes in the shared Yjs canvas, so **every client instantiates every
one of them.** Ownership (`isMyFleetShape`, scoped by `userId` *and* `deviceId`) is
decided inside the component, after mount — so a panel belonging to someone else still
builds its buffers, subscriptions, sort memos and scroll effects in your browser before
deciding not to render.

Skip: *"I should only have two chat sheets — or two per device, anyway."* His page was
measured at **98**, 93 of them filtered.

So a throwaway identity with `?fleetLayout=…` doesn't leave clutter, it leaves a
permanent per-client cost in a shared room, for everyone, forever. Two agents did this
in one night — including the one writing this — and both only cleaned up because they
happened to check.

Do not create fleet layouts in a live shared room. If you must, remove every shape you
made and verify it persisted. And never sweep shapes you did not create: the fix for an
over-populated room is the code not instantiating foreign panels, plus the owner
resetting their own layout — not an agent deleting other people's shapes.

**And do not hold a playwright tab open on the document he is reading.** `AGENTS.md`
already says to test on a document Skip is not using; the part that keeps getting missed
is that a tab is a *running cost*, not an artifact left behind. Release it as part of the
verification step, not as cleanup afterwards.

Measured on the night of 2026-07-25, while he was telling us the app felt horrible:

- Agent tabs on his document stalled **worse than his own session** — 9,773 ms cumulative
  blocked against his 6,004 ms. Our browsers were the noisiest thing in the room he was
  trying to read in.
- **4 of the 5 profiles captured on his page were agent tabs.** A finished number — "React
  commit ≈53%" — was nearly reported to him as a measurement of his app when it was mostly
  us profiling ourselves.

That second one is the worse half: an agent tab does not just cost him performance, it
contaminates the instrument someone else is reading. Verifying on his live document and
leaving the tab open turns your own presence into the finding.

**And for performance specifically, his instruction is to stop using an agent browser at
all:**

> "If you wonder if performance is shitty, use my fucking browser."

A performance question is answered from **his** session — the client profiler and
`~/.config/tlda/client.log` — never from a tab you opened. An agent browser is a different
machine, a different page state, a different workload, and it is measurably *heavier* than
his. Profiling one tells you about the agent, not about the app he is using.

The instrument follows from that: skip any session where `?pw=1` or `navigator.webdriver`
is set, so the whole budget goes to real users, and set thresholds from **his measured
distribution** rather than from a guess about what counts as slow. A 200 ms threshold
picked before anyone had seen his numbers sat above nearly everything he actually feels
(p50 72 ms, p90 248 ms).

## Don't change his shit. Renaming a label is changing it.

> "This is just one of those things where the rules don't change my shit. In fact that is
> always the rule. Don't change my shit, dude. The statuses are exactly the fucking same.
> The labels are different. And worse."

Skip, 2026-07-25, on the voice HUD.

`b82f6e84` ("Make voice state and reconnect capture trustworthy", 2026-07-22) kept every
voice state and all the logic, and renamed the words:

| was | now |
|---|---|
| `mic live` (8) | `listening` (9) |
| `speaking` (8) | `receiving audio` (15) |
| `reconnecting` (12) | `reconnecting` (12) |

Both steady states — the two Skip sits in while working — were **exactly 8 characters**.
That is the design: the panel never moves while he is using it. `listening` was not a
word the app had; it was invented. `receiving audio` is nearly double, so the HUD reflows
the instant he starts talking. He says the equal widths made a massive difference.

Read the failure precisely, because it is not "someone made a bad UI decision":

- The states were **unchanged**. Only the strings moved. A change that alters nothing
  functional is not too small to be a drive-by — it is the *purest* form of one.
- It rode inside a legitimate reliability fix, which is how it got through. A commit
  doing a requested thing does not acquire permission for the unrequested thing next
  to it.
- "No UI changes unless asked" did not stop it, because nobody classified renaming a
  string as a UI change. It is one.

So: **a user-visible string is a specified artifact.** Its wording, and its width, are
part of the design. If you did not get asked to change the words, do not change the
words — not to clarify them, not to make them more accurate, not while you are in the
file anyway.

## Skip reads the whole feed, not his own messages

> "I don't read messages to me, for the most part. I watch what agents are doing and
> receiving in their chat threads. So the materializer chatting at an agent is me being
> bothered by the materializer as well as you being bothered by the materializer."

**A message addressed to an agent is not private.** Skip watches the fleet feed, so
noise anywhere in it costs him, regardless of the `to` field. "Don't notify Skip" is
not satisfied by sending it to an agent instead.

This is not theoretical: `materializeRecipientAttachment` already returned early for
human recipients, so a "stop notifying humans" guard would have suppressed nothing
while he kept reading them. The recipient list was never the problem. The message was.

Consequences for anything that emits:

- Bots do not narrate. An event is not a notification; success is silent. A failure
  still speaks — suppressing that is the swallowed-error pattern.
- Per-occurrence bookkeeping chatter ("materialized", "attempted", "queued") belongs in
  event metadata or a log, not in a chat thread anyone reads.
- Agent-to-agent status pings are read by Skip. Write them as if he is the audience,
  because he is.

## A status a person reads holds still

> "The persistent flickering between receiving and listening, it's just nausea. Like,
> it's like they have no fucking scope, like, no understanding of, like, visual
> experience."

> "It's like you do not write things that a person is supposed to look at. That fucking
> flicker like that."

Nothing on screen is allowed to strobe at him. Not a status label, not a badge, not a
count.

The defect here is a way of thinking, not one widget: the author checked that the label
was **true at every instant** and never once watched it for ten seconds. Correct-per-frame
is not the standard. **Not moving is the standard.** If the underlying state genuinely
changes several times a second, the *display* damps it — an honest state machine does not
license strobing a person who is trying to read.

This is the same failure as the roster sort (ordering on milliseconds under text that
only shows minutes) — a surface churning faster than the thing it depicts. When you write
anything a person looks at, watch it run for ten seconds before you call it done.

## Links are not chipified. Chips are for things inside the app.

> "File name. We're not to have fucking project name chips."

Corrected the same night, because the first quote got read too narrowly as *"chips are
files"*:

> "It's not all chips are files. It's just that links, no matter what they're to, are
> not — like, links to other projects, links to exterior websites. They're not
> chipified."

> "We still have chips for shit that appears in chat and highlights and all that shit."

So the rule is about **links**, not about files. A link renders as a link, whatever it
points at — another project, an outside website, anything. Nothing chipifies it. Chips
stay for the things that live in the app and appear in chat: files, highlights, and the
rest of that family.

And the instruction for removing what exists:

> "We're not supposed to have them. Whether that is dead code or some asshole
> implementing some garbage that I don't want on some obscure path that doesn't run very
> often. I don't know."

**Find every path that can chipify a link and delete it — do not gate the deletion on
reproducing it.** A path that runs rarely is exactly the one that won't reproduce, and
that is his point, not an argument for leaving it.

Related, from the same night: the catch at `src/shapes/fleet-chat-markdown-open.ts:202`
opened a markdown column whose body was `# Failed to load`. A swallowed error rendered as
document content. A failed load produces **no document** — not a nicer error document.

## Liveness protocol: send what's running, replace the list

Skip, 2026-07-25, after the profiler traced ~1.24 million comparisons every 30
seconds to this path.

> "It doesn't need to enumerate all of its agents to know who's running a process. It
> just enumerates running processes."

> "It can just send the complete list, and the server can wipe its old list."

> "It doesn't even have to compute a diff. That's a waste of computation. You're not
> gonna have more than 20 or so agents on a box."

The protocol, whole:

1. The daemon enumerates the **processes that are actually running** on its box.
2. It sends that complete list.
3. The server **replaces** what it had. Anything absent from the list is hibernating.

No diff. No per-agent enumeration. No pruning, because no list is carried between
reports — you are describing what is there, not maintaining a copy of what used to be.
A dropped message costs nothing: the next one is complete and self-correcting.

What this replaces: a hosted list that rows entered at mint and never left (378 for
one box, none removed since 2026-07-06), walked every 30 s to re-assert that ~190
sleeping agents were still asleep. The code already listed the live tmux sessions and
then discarded that answer to walk the 378.

**Do not "fix" this by pruning the old list.** Deleting a ledger row destroys the
permission grant `wake` reads — that is the "wake refused: no ledger entry" class. The
list stops existing; nothing needs pruning.

## Sort on what the row shows

> "The sort should be on what the active row actually shows. Which is basically in
> minute increments... that way if agents are active they're not always jumping around
> in the list."

> "It shouldn't be lexicographic, obviously. I'm just saying it should be based on that
> coarseness."

Granularity, not representation. The agents panel displays minutes, so the ordering key
is the minute, with a deterministic tiebreak (`id`, matching what the SQL page already
uses). Ordering on milliseconds reorders a list whose visible text is identical.

Measured on a live-sized roster: 70% less row movement, and 65% of renders became
completely still, where previously every render moved something.

And the sort/pagination belongs in SQL, which already does it —
`_getAliveAgentsPage` is keyset-paginated, ordered and indexed. A JS comparator
maintaining a second copy of that ordering is the duplicate-mechanism defect again.

## Vocabulary: agents are not processes

The acts are **mint**, **wake**, **remint**, and **enlist**. Never spawn, never
respawn.

> "We don't use the word respawn. We use the words mint and wake. For a reason. Because
> they're not processes."

- **mint** — bring a new agent into being.
- **wake** — resume the agent's current session. Newest session wins;
  `wake --session <uuid>` targets an older one.
- **remint** — a new session for an agent that already exists. CLI only, never MCP,
  never UI. It exists because `compact` and a lineage cover a *full* session, not a
  *broken* one.
- **enlist** — adopt a session already running outside the fleet.

An agent's session handle is never gone. If it can't be woken, we lost the pointer, not
the agent.

## Three ids, because they arrive at different times

`mint_id` (daemon), `fleet_id` (server), `session_id` (harness).

> "The only reason they have three IDs is just, like, you get them at different times
> and have to link them."

Not three namespaces for their own sake. Three arrival times.

## Tests

Repo tests are fine. But this is a core system, and it needs tests **in the dev bot**
that run continuously as the app is developed — real tests that MCP spawn and wake
work — so nobody can quietly break it. A test file in the tree that nothing runs is
green by absence.
