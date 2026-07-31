# Identity and labeling

The intended model, and how the system realizes it.

Written because three separate readings of this system in one night each reached
a wrong conclusion from a correct-looking partial read, and each wrong conclusion
nearly became a schema change. If you are about to change anything about names,
labels, runtime status, or the three history tables, read this first — and read
[How to read this system without getting it wrong](#how-to-read-this-system-without-getting-it-wrong)
before you conclude anything from a grep.

Line references are `server/lib/fleet-store.mjs` unless stated otherwise.

## Part 1 — The intended model

Three statements, in Skip's words. This is the design.

**One namespace.**

> Friendly names are labels with a unique living occupant. So friendly names and
> other labels share a namespace — the only distinction is that only one living
> agent may occupy a friendly name.

A friendly name, an ordinary label, a reserved routing word, an agent id and
`human` are all entries in one space of tokens. A filter expression cannot tell
them apart: `chat(to: "reviewers")` and `chat(to: "opus-chief")` take the same
path through the same evaluator. Reserved routing words are occupied entries, not
a separate category.

**Status is a label too.**

> in a sense, status is just a fucking label too.

`awake`, `hibernating`, `dead`, `here`, `away` are a more granular form of the
same thing, not a second concept living beside labels.

**Labeling is recorded as events; labels are computed.**

> I was not thinking that labels should be recorded historically. I was thinking
> that labeling *events* should be recorded historically. And then labels should
> be computed.

The events are the record. Everything else — the current set, the history — is a
fold over them. A table holding folded results is a cache.

## Part 2 — How the system realizes it

| fact | current state | history | realizes the model? |
| --- | --- | --- | --- |
| labels | `agents.labels` (JSON) | `label_history` | **yes** — both are caches over events |
| friendly name | `agents.friendly_name` | `name_history` | no — trigger-written off the column |
| runtime status | derived, not stored | `runtime_status_history` | no — span-written by the caller |
| `dead` | `agents.dead` | via `runtime_status_history` | see [`dead`](#why-dead-is-still-a-column) |

### Labels: realized

Every labeling action writes a real event. `_insertLabelStateEvent` (`:2281`)
stores `metadata.label_state = { labels, operation }` with an actor and a
timestamp. From that log:

- `_currentLabelStateFromEvents` (`:2307`) computes the current set from the most
  recent such event, reading no table.
- `_rebuildLabelHistoryForAgent` (`:2336`) folds the whole log in timestamp order
  into `label_history` spans, and writes `agents.labels` from the last event
  (`:2353`). **One fold refreshes both caches from one log.**
- `rebuildLabelHistoryFromEvents` (`:2358`) regenerates the entire table.

**`label_history` and `agents.labels` are caches, and they cannot drift.** There
are exactly two writers of the column — `mutateAgentLabels` (`:2406`) and
`upsertAgent` (`:2200`) — and each writes the column, the event and the rebuild
**inside one transaction**. No path writes a label without writing an event.

That this was a decision rather than an accident is recorded in the code itself.
The comment above the DDL (`:1207-1209`) states it outright — "the table is only
a query cache; every row is rebuildable from events" — and the earlier
trigger-written version was **deliberately dropped** at `:1211-1212`.

Say this plainly when asked, because both an agent and a chief read these caches
as the source in one night and designed a schema on top of that error.

One structural note, not a live defect: `upsertAgent`'s change test compares
`JSON.stringify(nextLabels)` against the stored **column** (`:2225-2226`), not the
last event — a cache consulted to decide whether to append to the log. No current
path can make the column diverge first, so nothing is wrong today. It is simply
the one comparison that would perpetuate a divergence rather than repair it.

### Names: recorded, not folded

`name_history` (`:1177`) is **not** a fold, because nothing logs a rename. The
table is the only record that a name was ever held. Two triggers on the column
maintain it (`:1188-1204`): insert opens a span; any change to `friendly_name`
closes the open span and opens a new one. Because they are triggers, no write
path can skip them — the rename route, lineage rotation, the worker and external
sweep scripts all pass through `agents`.

It also has writers that bypass the column entirely: `_backfillNameHistory`,
`scripts/merge-history.mjs:51`, `bin/seed-name-history-from-sweep.mjs:46`.

**What the missing event costs, concretely.** A rename is recorded as a *state
transition* — the span closes and a new one opens — with no actor and no reason.
So "who renamed this agent, and when, and why" is not answerable today, and no
amount of reading `name_history` will answer it. Labels have that, because a
labeling event carries an actor. That is the difference between "names and labels
ought to be symmetric" and a capability the system does not have.

### Runtime status: recorded, not folded

`runtime_status_history` (`:1229`) is also not a fold. **Its primary writer is
`recordRuntimeState` (`:2619-2661`)**, which writes spans directly — closing the
open span at `:2652` and inserting the new one at `:2656`.

| writer | writes |
| --- | --- |
| trigger `runtime_status_history_ai` `:1249` | opens `awake` (AI) or `here` (human) at registration |
| trigger `runtime_status_history_au` `:1263` | on `dead` changing, AI only: closes the span, opens `dead` or `awake` |
| `recordRuntimeState` `:2619` | **all five statuses**, on every liveness and presence edge |
| `_backfillRuntimeStatusHistory` `:2577` | startup: seeds missing agents; closes each human's `here` span and opens `away` (`:2610-2613`) |

`recordRuntimeState`'s call sites in `server/unified-server.mjs`: `:446` human
presence edge (`status` passes through unchanged, so `away` is recorded —
`durableStatus` at `:2633` does not rewrite it for humans); `:480`
`markAgentAlive` → `awake`; `:500` `markAgentNotAlive` → **`hibernating`**;
`:2151` startup, server owner → `away`.

So `hibernating` spans exist, `away` spans exist, and an `awake` span closes on
the **liveness edge**, not on `dead`. An agent that slept six hours is recorded as
`hibernating` across them. **The live and historical paths agree on runtime
status, and the lexical property holds.**

Skip's question — *"hibernation, like, waking? Is not an event. That's
surprising."* — has a precise answer: hibernating **is** recorded, but **not as an
event**. It is written straight to a span.

### One of three is a fold; two are shadows

That is the distance between the model and the system, and it is the answer to
"why does this feel half-and-half." Labels go event → fold. Names and status are
written directly. **Both are correct today. Neither is a defect.** But only labels
have the property Skip specified, and anyone unifying these needs to know which
is which before starting.

What realizing status-as-events would actually cost, so nobody reads this as an
easy win: `hibernating` is derived from **silence**, and an absence does not
produce an event. Something has to decide when quiet becomes hibernating and
write that decision down. Today that decision lives in the liveness tracker and
goes straight to a span. Turning it into a log means giving the tracker an event
writer and folding it back.

And it is not urgent, which Skip has settled:

> we don't have to be perfectly accurate in terms of history, but we can do the
> backfill really easily.

One human, effectively always here. The historical gap is cheap to repair if it
ever matters.

### Why `dead` is still a column

`dead` stays a column because `idx_agents_live_name` is a **partial** unique index
whose `WHERE dead = 0` predicate must test it, and a partial index cannot
reference another table. The trigger writes the `dead` label when the column
changes. So `dead` is a label backed by a column — an implementation detail of the
constraint, not an exception to the model.

## Why label history is lexical

A historical label filter joins `label_history` spans and requires the agent to
have held the label **at the event's timestamp**, not now.

> this is a question of lexical versus dynamic scope. And no one likes
> dynamically scoped variables. It just makes code impossible to reason about. It
> makes history impossible to reason about. So the current label behaviour is
> right.

Folding events up to time T *is* "who held it then," so the event-sourced design
and the lexical rule are one statement. Under dynamic scope the same query would
return different history depending on when it ran.

**This is not a gap and must not be reported as one.** It is the expensive thing,
done on purpose:

> It turns out implementing lexical scope is harder than implementing dynamic
> scope… it took fucking work to implement lexical scope.

The machinery is `TemporalMembership` in `server/lib/filter-subscriptions.mjs` — a
per-filter temporal table, extended forward by live events and backward only
across the interval a history page actually queries. A present-day roster is never
projected onto an old message.

## Who reads `name_history`

Asked because it was worth asking — *"name history, I think, was written to do
that — I don't actually know that we need to do [it] at all anymore."* Checked by
grepping the call sites rather than reasoning from the name.

**It is load-bearing, in three current places**, and the reason is the same
lexical property as labels, applied to names:

- **`stampNames`** (`server/unified-server.mjs:328-351`) → `nameSpansFor`
  (`:2491`). Every events and thread reply stamps each row with the friendly name
  its sender and recipient **actually held at that row's timestamp**, plus the
  current name when it has since changed. Without the table, thread history would
  display everyone's present name on their old messages. The comment there notes
  the historical name must not be memoized on id alone, because that "would
  collapse an agent's distinct historical names into whichever resolved first and
  silently rewrite history in every thread view."
- **`filterMembershipSpans`** (`:2685`, and `:2723` for parent names) unions name
  spans into the flat historical label space, so a filter on a name an agent used
  to hold matches the messages from when it held it.
- **Agent search** (`:4743`) — a `UNION ALL` branch over `name_history` so
  searching an agent's former name still finds it.

Plus `bin/feelings-export.mjs:58` (`nameAt`), and the migration/merge scripts.

**There was one dead reader, now deleted.** `nameHistory(fleetId)` and its
prepared statement had no caller anywhere — only an entry in the exposed-methods
list. Its comment claimed a thread-header provenance trail, which is the trap:
a comment describing a feature is not evidence the feature calls it. Removed in
`dae9477ef`. The table itself stays, for the three readers above.

## The namespace already exists as a projection

Worth knowing before anyone proposes building one. The single namespace is
already computed, twice, and each projection is a single composition point with
no reader special-casing a computed label:

- **Live** — `labelsForAgent` (`shared/fleet-labels.mjs:44`) unions explicit
  labels, the status pseudo-label, `human`, `friendly_name` and `id`.
  `filterLabelsForAgent` (`shared/filter-semantics.mjs:33`) wraps it and adds the
  parent id, the parent's current name and the `descendant-of:` chain.
- **Historical** — `filterMembershipSpans` (`:2672`) unions `name_history`,
  `label_history`, `runtime_status_history`, ids, parent names, the
  `descendant-of:` closure and `human` into one span stream.

So a namespace table would not make the namespace exist. What it would add is
*enforcement in the schema*, which is a narrower and more defensible claim.

## Enforcement: where the rule actually lives

Living-name uniqueness is **`idx_agents_live_name`** (`:900`), a partial unique
index on `agents(friendly_name) WHERE dead = 0 AND friendly_name IS NOT NULL`. A
second living holder of a name is unrepresentable. A name frees when its holder
dies, which is why `findAgent` (`:2779`) resolves a living name with no
disambiguation and still falls back to a dead row for reanimate-by-name.

**Never add a code check beside that index.** It is the enforcement; code looking
at the same question exists for the error message.

A name collision **rotates the loser; it does not kill it** (`:860-896`). This path
already ran on real rows.

> Nothing should kill an agent, ever, other than a manual operation.

If a name cannot be rotated it is cleared — the index is partial on
`friendly_name IS NOT NULL`, so a nameless agent satisfies it and stays alive.

The rest of the rule is enforced in code by `checkNameAvailable` (`:2892`): one
gate, one error shape, several reasons — unaddressable syntax, reserved routing
word (`PSEUDO_LABELS`, `shared/fleet-labels.mjs:28`), agent id, living friendly
name, and, only when assigning a name, another agent's label.

### The addressability rule

The filter grammar's TOKEN is "a maximal run of characters that are not
whitespace or `& | ! ( )`". A label containing one of those stores fine and is
then **unaddressable**: roster, `chat(to:)`, thread and search tokenize it into
pieces and return zero matches with no error, while a panel filter still matches
because it hands the leaf straight to the evaluator — correct in the one place you
would look, silently broken everywhere else.

This is now an error at write time. The check is exactly the tokenizer's rule and
is deliberately not a stricter charset. Documented residue: NBSP (U+00A0) and
U+2028 still store and are unaddressable, because the tokenizer splits on JS
`/\s/` which matches them and SQL `GLOB` does not.

## Defect: `register` and `login` enforce a weaker rule than `label()`

One rule, two code paths, already drifted.

`upsertAgent` (`:2209-2221`) **silently strips** labels colliding with a live
friendly name — a `console.log`, no error — where `mutateAgentLabels` (`:2421`)
throws through `checkNameAvailable`. The stripped set is what reaches the event,
so the log stays self-consistent; the caller is simply never told.

The strip is also **narrower than the gate it stands in for**. It checks only live
friendly names — not `PSEUDO_LABELS`, not agent ids, not the addressability
charset — and `_normalizeCompleteLabels` (`:2268`) only de-dupes and type-checks.
So these paths can write a label `awake`, or another agent's id, or `a&b`, each of
which `label()` rejects.

**Extent, as of `c591133bc`.** Mint is fixed: `server/unified-server.mjs:1942-1945`
calls `checkNameAvailable` before `upsertAgent`, commented "Same gate as
label()". The gate went into `checkNameAvailable`, which `mutateAgentLabels`
calls and `upsertAgent` does not — so the remaining open paths are the ones that
call `upsertAgent` with labels and no gate:

- WS `register` — `server/unified-server.mjs:5464`
- WS `login` — `server/unified-server.mjs:5524`
- WS `update-agent` — `:6736` (gates the *name* at `:6729`, not the labels)
- `POST /api/set-metadata` — `server/routes/fleet.mjs:864` (re-upserts the whole
  agent, labels included)
- `importFromStateJson` — `:5054`

**This is a fourth enforcer of the label-vs-living-name rule, and it already
exists.** Moving enforcement into the schema would not add a fourth mechanism to
three; it would replace four, one of which is silently wrong. A rule enforced in
two code paths has already drifted — which is exactly what a constraint on the
column would make impossible, and it would have covered both paths without anyone
having to notice they differed.

## What cannot move, and why

Verified against `better-sqlite3` on a scratch database, not assumed:

| want | verdict |
| --- | --- |
| partial index referencing another table | **no** — subqueries prohibited in partial index `WHERE` |
| generated column referencing another table | **no** — subqueries prohibited in generated columns |
| `CHECK` containing a subquery | **no** — subqueries prohibited in `CHECK` |
| one unique index covering unique names *and* repeatable labels | **no** — labels legitimately repeat; a label equal to a living name is not a uniqueness violation |
| `BEFORE INSERT` trigger raising on label-vs-living-name | **yes** — and `RAISE(ABORT)` propagates out through an enclosing trigger to abort the original statement |
| a trigger body exploding a JSON array via `json_each(NEW.labels)` | **yes** |
| `CHECK` enforcing the token charset via `GLOB` | **yes** for ASCII; misses NBSP and U+2028 |
| a case-insensitive partial unique index | **not by default** — see below |

Two landmines:

**`PRAGMA foreign_keys` is OFF on the fleet connection.** `fleet-store.mjs` sets
`journal_mode`, `synchronous`, `cache_size`, `mmap_size`, `wal_autocheckpoint` and
`journal_size_limit` (`:322-337`) and never sets `foreign_keys`. SQLite defaults
it off *per connection*; the only place in the repo that enables it is
`server/lib/project-files-store.worker.mjs:21`. **So any foreign key in this
schema parses, looks correct, and cascades nothing.** Do not flip it casually —
enabling it starts enforcing every latent FK in the schema at once.

**Case sensitivity is inconsistent, and the index is the strict one.** A partial
unique index on `TEXT` uses `BINARY` collation, so `alpha` and `ALPHA` are two
different living names to `idx_agents_live_name`. `checkNameAvailable` (`:2892`)
also compares case-sensitively — but `allocateFreshFriendlyName` (`:3021`) and
`_friendlyNameUnavailableLower` (`:3000`) compare case-**in**sensitively. The
namer refuses to mint `ALPHA` beside `alpha`; the index and the gate would both
permit it. Anything moving this rule must pick one, and picking case-insensitive
means existing rows may already violate it.

## How to read this system without getting it wrong

Every wrong conclusion in one night had the same shape, so it is worth naming.

**The obvious writer being visible is what makes the second one invisible.** The
two `runtime_status_history` triggers sit in the schema DDL, immediately below the
`CREATE TABLE`. Reading the DDL finds them and the search feels finished — so
`recordRuntimeState`, which never touches `agents.dead` and lives 1,400 lines
away, is never found. A reading based on the triggers alone concludes that
`hibernating` and `away` are never recorded and that `awake` merely means "not
dead." All of that is false, and it is false in a way that produces confident,
precisely-cited claims: the trigger's `WHEN NEW.human = 0` gate is real, it just
does not matter, because humans never reach that trigger.

**A precise citation of an irrelevant mechanism reads exactly like a proof.**

So: grep for writers of a table **by table name** before concluding who maintains
it. Enumerate, then conclude. "I found a writer" is not "I found the writers," and
a caveat about a check you did not run is not a substitute for finishing the
search.
