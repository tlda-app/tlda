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

Skip's clarification, because the mechanism matters and I got it wrong first:
*"It doesn't have any plausible value. It just doesn't fucking show the thing."*

Nothing fabricates a fake model. The field simply vanishes. Not displaying an absent
value is the **correct** behaviour and should stay — the defect is that the data stopped
arriving and **the fallbacks upstream meant no error was ever raised**, so a field
disappearing from his panel looked identical to a field that was never meant to be
there.

So: keep showing nothing, and make the *absence* loud somewhere it isn't a fallback's
job to hide.

The server holds the agent id, which daemon owns it, and the friendly name. Not the
session id, not session lists, not resume ids, not tmux information.

> "The server does not know about session."

Routing a terminal to an agent goes *through the daemon*. The daemon knows the tmux
window; the server does not need to. History is not a reason to keep a session field
server-side — the JSONLs carry their own login markers and are the record.

**History is never destroyed.** Live code stops depending on old fields; existing rows
stay as they are.

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
