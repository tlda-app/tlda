# Identity and labeling

How an agent is named, labeled, and addressed, and how those facts are recorded
over time. Written because three separate readings of this system in one night
each reached a wrong conclusion from a correct-looking partial read, and each
wrong conclusion nearly became a schema change.

Line references are `server/lib/fleet-store.mjs` unless stated otherwise.

## One namespace

Skip's formulation, which is the rule:

> Friendly names are labels with a unique living occupant. So friendly names and
> other labels share a namespace — the only distinction is that only one living
> agent may occupy a friendly name.

So there is one space of tokens. A friendly name, an ordinary label, a reserved
routing word, an agent id, and `human` are all entries in it, and a filter
expression cannot tell them apart — `chat(to: "reviewers")` and
`chat(to: "opus-chief")` take the same path through the same evaluator.

That is not an aspiration. **The single namespace already exists, twice, as a
projection**, and both projections are single composition points:

- **Live** — `labelsForAgent` (`shared/fleet-labels.mjs:44`) unions explicit
  labels, the status pseudo-label, `human`, `friendly_name` and `id`.
  `filterLabelsForAgent` (`shared/filter-semantics.mjs:33`) wraps it and adds the
  parent id, the parent's current name, and the `descendant-of:` chain.
- **Historical** — `filterMembershipSpans` (`:2683`) unions `name_history`,
  `label_history`, `runtime_status_history`, agent ids, parent names, the
  `descendant-of:` closure, and `human` into one stream of
  `(fleet_id, label, from_ts, to_ts)` spans.

There is no reader that special-cases a computed label. **A namespace table is
therefore not a thing to build; the namespace is a thing that is already
computed.** What a table would add is *enforcement* in the schema, which is a
narrower claim than "make the namespace exist" — see
[Enforcement](#enforcement-where-the-rule-actually-lives).

## Where each fact is stored, and what is the record

The three history tables look alike and are not alike. This is the distinction
that matters most, and getting it backwards is what cost a night.

| fact | current state | history | is the history a fold? |
| --- | --- | --- | --- |
| labels | `agents.labels` (JSON array) | `label_history` | **yes** — both are caches over events |
| friendly name | `agents.friendly_name` | `name_history` | **no** — the table is the record |
| runtime status | derived, not stored | `runtime_status_history` | **no** — the table is the record |
| dead | `agents.dead` | via `runtime_status_history` | n/a — see [`dead`](#why-dead-is-still-a-column) |

### Labels: the events are the record

This is Skip's design and it is implemented:

> I was not thinking that labels should be recorded historically. I was thinking
> that labeling *events* should be recorded historically. And then labels should
> be computed.

Every labeling action writes a real event. `_insertLabelStateEvent` (`:2285`)
stores `metadata.label_state = { labels, operation }` with an actor and a
timestamp. From that log:

- `_currentLabelStateFromEvents` (`:2311`) computes the current set as the most
  recent such event, reading no table.
- `_rebuildLabelHistoryForAgent` (`:2340`) folds the whole log in timestamp order
  into `label_history` spans, and writes `agents.labels` from the last event
  (`:2357`).
- `rebuildLabelHistoryFromEvents` (`:2362`) regenerates the entire table.

**`label_history` and `agents.labels` are both caches, and they cannot drift.**
The comment above the DDL (`:1207-1209`) says so outright — "the table is only a
query cache; every row is rebuildable from events" — and the earlier
trigger-written version was deliberately dropped (`:1211-1212`). There are
exactly two writers of the column, `mutateAgentLabels` (`:2410`) and
`upsertAgent` (`:2204`), and each writes the column, the event, and the rebuild
**inside one transaction**. No path writes a label without writing an event.

State this plainly to anyone who asks, because both an agent and a chief read
these caches as the source and designed on top of that error.

One structural note, not a live defect: `upsertAgent`'s change test compares
`JSON.stringify(nextLabels)` against the stored **column** (`:2229-2230`), not
against the last event. It is a cache consulted to decide whether to append to
the log. No current path can make the column diverge first, so nothing is wrong
today; it is simply the one comparison that would perpetuate a divergence rather
than repair it.

### Names: there is no rename event

`name_history` (`:1177`) is **not** a fold, because nothing logs a rename. The
table is the only record that a name was ever held, maintained by two triggers on
the column (`:1188-1204`): insert opens a span, any change to `friendly_name`
closes the open span and opens a new one. Because they are triggers, no write
path can skip them — the rename route, lineage rotation, the worker, and external
sweep scripts all pass through `agents`.

It also has independent writers that bypass the column entirely:
`_backfillNameHistory` (`:2535`), `scripts/merge-history.mjs:51`, and
`bin/seed-name-history-from-sweep.mjs:46`.

### Runtime status: written directly, and `recordRuntimeState` is the writer

`runtime_status_history` (`:1229`) is also not a fold. **Its primary writer is
`recordRuntimeState` (`:2630-2672`), which writes spans directly** — closing the
open span at `:2663` and inserting the new one at `:2667`.

This is the single most misread thing in the system, so it gets its own warning:

> **The two triggers at `:1249-1275` are not the only writers, and reading only
> them produces a confident, wrong answer.** They fire on `agents.dead`, so
> searching for what maintains this table by looking at the schema DDL finds
> them and stops. `recordRuntimeState` never touches `agents.dead` and is
> invisible to that search. A reading based on the triggers alone concludes that
> `hibernating` and `away` are never recorded and that `awake` merely means
> "not dead." **All of that is false.**

The full writer set:

| writer | writes |
| --- | --- |
| trigger `runtime_status_history_ai` `:1249` | opens `awake` (AI) or `here` (human) at registration |
| trigger `runtime_status_history_au` `:1263` | on `dead` changing, for AI only: closes the span, opens `dead` or `awake` |
| `recordRuntimeState` `:2630` | **all five statuses**, on every liveness and presence edge |
| `_backfillRuntimeStatusHistory` `:2588` | startup: seeds missing agents, closes each human's `here` span and opens `away` (`:2619-2622`) |

`recordRuntimeState`'s call sites in `server/unified-server.mjs`:

- `:446` — human presence edge; `status` passes through unchanged, so `away` is
  recorded (`durableStatus` at `:2644` does not rewrite it for humans)
- `:480` — `markAgentAlive` → `awake`
- `:500` — `markAgentNotAlive` → **`hibernating`**
- `:2151` — startup, server owner → `away`

So `hibernating` spans exist, `away` spans exist, and an `awake` span is closed
on the liveness edge rather than on `dead`. **The live and historical paths agree
on runtime status.** An agent that slept for six hours reads as `hibernating`
across those hours, not `awake`.

## Status is a label too

Skip:

> in a sense, status is just a fucking label too.

That is the model the system is reaching for: labeling is events, labels are
folds over events, and status is a label — so a status change would be a labeling
event and status history would be the same fold. One mechanism instead of three.

**The system does not contradict this today; it just implements it with two
mechanisms instead of one.** Of the three history tables, one is a fold over
events and two are written directly. That asymmetry is real and is the honest
description of where the system sits.

It is worth being clear about what unifying it would and would not buy, because
the obvious reading is wrong in both directions:

- It would **not** fix a filter bug. There is no live-versus-history disagreement
  on status to fix; see the section above.
- It is **not** a small change. `hibernating` is derived from *silence*, and an
  absence does not produce an event. Something has to decide when quiet becomes
  hibernating and write that decision down. Today that decision lives in the
  liveness tracker and is written straight to a span. Turning it into an event log
  means giving the tracker an event writer and folding it back — which is a
  genuine piece of work, not a schema tidy.

### Why `dead` is still a column

`dead` stays a column because `idx_agents_live_name` is a **partial** unique index
whose `WHERE dead = 0` predicate must test it, and a partial index cannot
reference another table. The trigger writes the `dead` label when the column
changes. So `dead` is a label backed by a column, and the backing is an
implementation detail of the constraint — not a second kind of thing.

## Why label history is lexical

A historical label filter joins `label_history` spans and requires the agent to
have held the label **at the event's timestamp**, not now. Skip's ruling:

> this is a question of lexical versus dynamic scope. And no one likes
> dynamically scoped variables. It just makes code impossible to reason about. It
> makes history impossible to reason about. So the current label behaviour is
> right.

Folding events up to time T *is* "who held it then," so the event-sourced design
and the lexical rule are the same statement. Under dynamic scope the same query
would return different history depending on when it ran.

**This is not a gap and must not be reported as one.** It is the expensive thing,
deliberately done:

> It turns out implementing lexical scope is harder than implementing dynamic
> scope… it took fucking work to implement lexical scope.

The machinery that keeps it lexical is `TemporalMembership` in
`server/lib/filter-subscriptions.mjs` — a per-filter temporal table, extended
forward by live events and backward only across the interval a history page
actually queries. A present-day roster is never projected onto an old message.

## Enforcement: where the rule actually lives

Living-name uniqueness is **`idx_agents_live_name`** (`:900`), a partial unique
index on `agents(friendly_name) WHERE dead = 0 AND friendly_name IS NOT NULL`. A
second living holder of a name is unrepresentable. A name frees when its holder
dies, which is why `findAgent` (`:2790`) can resolve a living name with no
disambiguation and still fall back to a dead row for reanimate-by-name.

**Never add a code check beside that index.** It is the enforcement; code that
looks at the same question is there for the error message.

A name collision **rotates the loser, it does not kill it** (`:860-896`). This
path already ran on real rows. The rule behind it:

> Nothing should kill an agent, ever, other than a manual operation.

If a name cannot be rotated, the name is cleared — the index is partial on
`friendly_name IS NOT NULL`, so a nameless agent satisfies it and stays alive.

The rest of the namespace rule is enforced in code, in `checkNameAvailable`
(`:2903`) — one gate, one error shape, several reasons: unaddressable syntax,
reserved routing word (`PSEUDO_LABELS`, `shared/fleet-labels.mjs:28`), agent id,
living friendly name, and — only when assigning a name — another agent's label.

### The addressability rule

The filter grammar's TOKEN is "a maximal run of characters that are not
whitespace or `& | ! ( )`". A label containing one of those stores fine and is
then **unaddressable**: roster, `chat(to:)`, thread and search tokenize it into
pieces and return zero matches with no error, while a panel filter still matches
because it hands the leaf straight to the evaluator. Correct in the one place you
would look, silently broken everywhere else.

This is now an error at write time. The check is exactly the tokenizer's rule and
is deliberately not a stricter charset. Documented residue: NBSP (U+00A0) and
U+2028 still store and are unaddressable, because the tokenizer splits on JS
`/\s/` which matches them and SQL `GLOB` does not.

## Defect: `upsertAgent` enforces a weaker rule than `label()`

One rule, two behaviours, and the register/mint path is the lenient one.

`upsertAgent` (`:2213-2225`) **silently strips** labels that collide with a live
friendly name — a `console.log`, no error — where `mutateAgentLabels` (`:2425`)
throws through `checkNameAvailable`. The stripped set is what gets written to the
event, so the log stays self-consistent; the caller is simply never told.

Worse, the strip is narrower than the gate it stands in for. It checks **only**
live friendly names. It does not check `PSEUDO_LABELS`, agent ids, or the
addressability charset, and `_normalizeCompleteLabels` (`:2272`) only de-dupes and
type-checks. So the register/mint path can write a label `awake`, or another
agent's id, or `a&b` — each of which the `label()` path rejects.

**This is the fourth enforcer of the label-vs-living-name rule, and it already
exists.** A design that moves enforcement into the schema is not adding a fourth
mechanism to three; it is replacing four, one of which is silently wrong. That is
an argument *for* schema enforcement, and reconciling these two writers is a
prerequisite either way.

## What cannot move, and why

Verified against `better-sqlite3` on a scratch database, not assumed:

| want | verdict |
| --- | --- |
| partial index referencing another table | **no** — subqueries prohibited in partial index `WHERE` |
| generated column referencing another table | **no** — subqueries prohibited in generated columns |
| `CHECK` containing a subquery | **no** — subqueries prohibited in `CHECK` |
| one unique index covering unique names *and* repeatable labels | **no** — labels legitimately repeat; a label equal to a living name is not a uniqueness violation |
| `BEFORE INSERT` trigger raising on label-vs-living-name | **yes** — and the `RAISE(ABORT)` propagates out through an enclosing trigger to abort the original statement |
| a trigger body exploding a JSON array via `json_each(NEW.labels)` | **yes** |
| `CHECK` enforcing the token charset via `GLOB` | **yes** for ASCII; misses NBSP and U+2028 |
| a partial unique index that is case-insensitive | **no**, not by default — see below |

Two landmines in that table:

**`PRAGMA foreign_keys` is OFF on the fleet connection.** `fleet-store.mjs` sets
`journal_mode`, `synchronous`, `cache_size`, `mmap_size`, `wal_autocheckpoint` and
`journal_size_limit` (`:322-337`) and never sets `foreign_keys`. SQLite defaults
it off *per connection*; the only place in the repo that turns it on is
`server/lib/project-files-store.worker.mjs:21`. **So any foreign key in this
schema parses, looks correct, and cascades nothing.** Do not flip it casually:
enabling it starts enforcing every latent FK in the schema at once, which is its
own piece of work with its own blast radius.

**Case sensitivity is inconsistent, and the index is the strict one.** A partial
unique index on a `TEXT` column uses `BINARY` collation, so `alpha` and `ALPHA`
are two different living names as far as `idx_agents_live_name` is concerned.
`checkNameAvailable` (`:2903`) also compares case-sensitively — but
`allocateFreshFriendlyName` (`:3032`) and `_friendlyNameUnavailableLower`
(`:3011`) compare case-**in**sensitively. So the namer will refuse to mint
`ALPHA` next to `alpha`, while the index and the gate would both permit it.
Anything that moves this rule has to pick one, and picking case-insensitive means
existing rows may already violate it.
