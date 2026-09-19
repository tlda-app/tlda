# Resolved agent sets

One primitive answers *which agents match this expression*, and everything that
asks that question uses it: chat filters, agent subscriptions, send targets,
roster views, search, `thread()`.

**It is one walker over the expression, not one resolver.** The boolean algebra
— `lit`/`and`/`or`/`not` — is duplicated today, in `fleet-store.mjs:2758` and
`unified-server.mjs:7812`, with the same shapes over different element types.
That is the deduplication available: one generic walker parameterized by its leaf
resolver and its intersect/union, instantiated twice.

**The leaf resolvers must stay two, and merging them breaks one of them.**

| | `resolveChatRecipients` | `resolveAgentSpans` |
|---|---|---|
| asks | who is in this set **now** | every id this name **ever** pointed at, and when |
| element | `Map<id, agent>` | `{id, from_ts, to_ts}` spans |
| dead agents | excluded | included |

Chat send-targets on span semantics addresses every former holder of a name.
History reads on membership semantics return zero — the documented bug
`fleet-store.mjs:6542` exists to prevent, where a read of the previous chief's
whole day came back empty and an empty answer is indistinguishable from an empty
world.

So a cache entry is keyed by the expression **and by which question is being
asked**: `chief` has two different correct answers.

Skip, 2026-09-19:

> "send targets, like chat filter-sets for push-type display, are easy to
> maintain as event-invalidate cache"

> "vs like, maintaining a fixed set of event-maintained dereferenced-label-sets
> for this and that, we can basically have a kind of generic set"

## Events invalidate by dependency

A fleet event carries what changed about an agent — labels, friendly name,
liveness, death, subscription. A set knows which terms its expression mentions.
An event touches only the sets whose terms it intersects; nothing recomputes
globally.

A term no set mentions costs nothing, however often it fires. `awake` is a
runtime-status pseudo-label that churns on every process start and stop, and
nothing uses it:

> "so nobody ever uses that label" / "so the churn invalidates nothing in
> practice"

That is the general property rather than a case to handle — no term-specific
code anywhere.

## Refs are typed

**Subscription refs** — a chat filter someone has open, an agent subscription —
mean the holder wants to be *told* when membership changes. Those sets are
maintained eagerly and produce deltas, because a push display consumes the
change rather than the value.

> "chat, agent subscription. it's maintained"

**Plain refs** are pull: correct when read. Events mark them dirty; they
recompute on the next acquire.

## Refcount, then a size-bounded LRU

> "think refcounting + lu cache" / "+ some size lu"

At zero refs a set drops into a size-bounded LRU, dirty-marked rather than
maintained, and evicts under the bound. Dropping a dirty unreferenced set is
always safe: nobody can observe one without acquiring it.

So there is no policy about which expressions deserve caching — usage decides,
and a one-off expression that happens to repeat gets the hit for free. Memory is
bounded however many distinct expressions are ever used.

The LRU tier's consumers are the high-cardinality readers:

> "for like, search/thread/etc"

Those resolve an agent set per query rather than holding one. `thread()` resolves
through `resolveAgentSpans()`; search resolves its filter the same way. Neither
holds a durable ref, so neither belongs in the maintained tier — and both repeat
the same few expressions often enough that an LRU hits.

## What this replaces

`chat()` resolved `to` through a server round-trip on a deadline
(`mcp-server/fleet-tools.mjs`, `resolve-chat-recipients`). Under load it timed
out and the send **failed closed** — messages silently failing to send exactly
when the box was busiest. A bare `fleet:` id short-circuited; a plain name did
not, so an unambiguous single recipient took the same path as a full expression.

Subscriptions decide delivery. If subscription sets are maintained, a send
already holds its targets: there is no resolve round-trip left to time out.

Chat failing to send under load is measured: the resolve is a server round-trip
on a deadline, and it fails closed.

**Measured 2026-09-19 on the live store** (19.7 GB, 61,752 agents, 5.5M events).
Resolving an agent term costs **15–22 ms and is flat** — the same for a term
hitting 1 agent as for one hitting 356. The read that follows is **113–177 ms
cold and ~1 ms warm**. The cache removes the 15–22 ms. It is **not** the fix for
search or `thread()`, and the 30-second bound is not explained by agent-set
resolution.

The variable that dominates is cold versus warm, ~100×, against 1.97 GB of page
cache for a 19.7 GB database. Which reads are warm is a machine question, not a
code one.

**One primitive, an instance on each side of the wire.** Chat's resolve crosses
from the MCP process to the server and its deadline is client-side, so its cache
belongs there. Search and `thread()` run server-side and never cross that wire,
so theirs belongs in the server. Same primitive, two instances — not one cache in
one place.

Search already carries a hand-built version of this, and it is the strongest
evidence the design is right. `unified-server.mjs:7796` memoizes resolved leaves
on the node for the duration of one request, because *"ignoring the annotation
repeated the full selector query dozens or hundreds of times for one search
request."* That is this cache, built narrowly, discarded after every request, for
one consumer. It should be deleted once the real one exists rather than left
alongside it.
