# Fleet search reliability — reproduced boundary

PM: fleet:500df5c2. Reproduced 2026-08-27 on the live `testing` MCP search surface.
Skip's report: "search / sucks / which is a problem" — timeouts, and text+date
queries returning results from other months.

Both defects are in the **server** `fleet-search` handler
(`server/unified-server.mjs`, the `if (type === 'fleet-search')` block). The in-app
search cards (`src/shapes/FleetSearchShape.tsx`, `FleetSearchResultsView.tsx`,
`src/fleet/search-query.ts`) call the same handler, so they inherit both. The
client is a **verification surface, not a second fix**.

## Defect 1 — a text query returns rows that ignore the date bound

`searchProjectContent(msg.query, { limit, currentProject })` is called with
**no `since` and no `before`**. Its rows are then merged into `results`, sorted,
and sliced. It is gated on `hasText && !historyOnly && !eventOnly`, which is
exactly the "text + date" case Skip reported.

Measured, `search(query: "timeout", since: "1d")` — header says
`since 2026-08-26T22:33Z`, and the returned rows include 8/25, 8/25, 8/11, 8/9.
Every `[fleet]` row obeyed the bound; every out-of-window row came from the
document path.

Two more symptoms of the same call, both confirmed:

- The rows are labelled `[session]` with agent `[undefined]`. They are project
  document content, not session JSONL.
- They are absent from the tally. `search(query: "quartolinkgroups")` prints
  **"5 results (0 fleet, 0 session)"** above five printed rows, because the
  count covers `searchAll`'s two sources and not this third one.

`since`/`before` **are** compiled to SQL for the fleet path — see
`server/lib/message-filter-sql.mjs` cases `since`/`before`. This path is the one
that never receives them.

## CORRECTION to Defect 2 — my control was wrong, and its rule is inverted

**Everything in the section below is superseded.** `search-bound-scan` measured it
and my reproduction does not survive. Read this first; the original is kept
underneath only so the wrong claim is visible rather than quietly edited away.

**The rare-term control does not reproduce.** 90 interleaved A/B pairs against the
live operation, alternating which arm went first: `quartolinkgroups` unbounded
median 867ms, bounded median 848ms, **zero 45s deadlines in either arm**. I
re-ran the pair myself afterwards and it returned instantly both ways.

**The rule is backwards.** I wrote that a rare term plus a bound is the failure and
a common term survives. The common term is the expensive one — cost tracks the
**posting list**, not the limit:

| term | postings in `events_fts` | bounded | unbounded |
|---|---|---|---|
| `quartolinkgroups` | 2 | free | free |
| `the` | 400,862 | **15.83s** | 1.7s |
| `agent` | 878,126 | 14.85s cold | 2.34s |

**What my timeout actually was: queueing.** The store is one worker thread serving
one call at a time, so an expensive bounded search stalls everything behind it.
My rare-term call was queued behind somebody else's slow query, not slow itself.

**My query-plan redirect was also wrong.** I sent the doer to `EXPLAIN QUERY PLAN`
expecting a scan. All six plans `searchAll` builds are **index seeks, bounded and
unbounded alike** — reading the plan cannot find this defect. The instrument I
named could not have seen the thing I asked it to look for.

**The real mechanism.** The bound is tested *after* the matched row is joined, so
`LIMIT` can no longer terminate the FTS walk. Unbounded, `ORDER BY rank LIMIT n`
stops at the first `n` hits; bounded, SQLite reads the term's entire posting list
to find the few rows inside the window. Cold I/O turns seconds into a timeout:
`the` bounded is 35.68s cold on events and 24.24s on sessions — **59.9s in one
`searchAll`, past the 45s client deadline on its own.**

**The conclusion I gave Skip was right for the wrong reason.** "Applying a bound is
what makes it expensive" holds. The evidence I offered for it did not, and a right
conclusion resting on a wrong account is worse than no account, because it stops
anyone looking further.

**Two things this also settles:**

- **The `roster` timeout is the same root**, not a roster problem. `roster` is
  `getAliveAgents`/`resolveAgentQuery`, queued behind the same blocker.
  `fleetStoreQueue`: `maxDepth 128`, `waitMax 88011ms`, every unrelated method's
  max within 600ms of that same number — one blocker, everything behind it.
- **The server keeps running after the client gives up.** `calls === settled ===
  182,966` — nothing is cancelled — so a timed-out search holds the one thread
  for another ~40s, charging everyone else for work whose caller has left.

**The fix** puts the bound on the match side as a rowid range, which FTS5 honours,
so the walk skips the prefix. `the` over one day: events 15.83s → **0.07s**,
sessions 8.41s → **0.10s**, identical id sets. Branch `search-bound-rowid`,
`04cacbd10`.

**The trap it avoids, worth keeping:** the obvious floor — the id of the window's
earliest row — is *not* a lower bound, because ids are assigned at insert and
timestamps are not, so a late-ingested row carries a high id with an old
timestamp. On the live store that silently drops rows in **15 of 60 day-windows on
`events` and 23 of 60 on `session_entries`, 2016 rows in the worst.** The fix uses
`min(id)` over exactly the rows the bound admits. Three tests, all red against the
naive floor, checked by building it.

## Defect 2 — applying a time bound turns the search into a scan

The control is decisive. Same rare term, same limit, bound the only difference:

| call | result |
|---|---|
| `search(query: "quartolinkgroups", limit: 5)` | returns immediately |
| `search(query: "quartolinkgroups", since: "1d", limit: 5)` | **45s WS deadline exceeded** |

So the term is not slow. The bound is what makes it scan. Reproduced on four
other calls: `since:2026-08-24`, `since:2026-08-24` with no text at all, and
`since:today` all hit the 45s deadline.

A common term survives the same bound — `search(query: "timeout", since: "3d")`
returns — because it fills `limit` while scanning. The failure is a rare term
plus a bound.

Not yet established, and it is the doer's first job: where in
`fleetStore.searchAll` the bound stops being an index seek. Profile it; do not
reason forward from the query text. Note the error is a **client** 45s WS
deadline, so the server may still be running the query after the caller gives up.

## Defect 3 — the tool's own printed advice errors

Every full page prints "or bound it with since:/before:, which returns the full
range". Following it: `search(query: "timeout", since: "3d", before: "now",
limit: 30)` returns `Bounded query returned ≥30 results — too many to return in
one call. Narrow your time range.` Lowest priority of the three; note it so the
footer and the behaviour stop disagreeing.

## Defect 4 — an empty two-party thread is reported as an empty corpus

This is the one that produced the "visibility-unavailable" reading of four
agents whose history is fully intact.

`thread(agent: "dmitry-fix")` answers:

> No messages found for the given criteria. Selector "dmitry-fix" resolves to
> fleet:8c86de6d, but no indexed fleet messages were found in environment
> "testing".

`thread(filter: "from:dmitry-fix")` returns messages immediately, and
`search(query: "from:dmitry-fix")` returns five. The history is indexed and
readable.

**The two-party read being empty is correct** — the caller and that agent never
exchanged messages. What is wrong is the sentence: it describes an absent
**corpus** when the truth is an absent **pair**, so the reader concludes the
agent's activity is invisible.

The correct wording already exists on the sibling path. `thread(filter:)` prints:

> ↳ This is dmitry-fix talking to the whole fleet, which is what you asked for …
> For the conversation between you and dmitry-fix, ask for `me <> dmitry-fix` or
> `agent: "dmitry-fix"`.

So the fix is to say, on the empty two-party result, that the pair is empty and
name the route to that agent's wider traffic. Do not change what the query
returns — the result is right; only the sentence is wrong.

## Defect 5 — the `project:` parameter is inert

`search`'s `project` parameter is documented as "List agents who worked in a
project/working directory by chronological recency." Measured:

- `search(query: "zzqqxwv", project: "tlda")` → "No results". No agent rows.
- `search(query: "dmitry-fix", project: "tlda")` and
  `search(query: "dmitry-fix", project: "synth-randomization")` → **identical
  five rows**, and identical to the same query with no `project` at all.

Same query, different project, same result set — the parameter changes nothing
on this path, and no call produced an agent listing. This is the first half of
the Monday workflow (which agents worked in this project), and it does not work.

Establish whether the listing exists anywhere before building one. If it was
deleted, say so and cite the commit rather than writing a replacement.

## The arithmetic control for Defect 1

Sharper than the original reproduction, and it is the red/green test to use.
One explicitly bounded one-hour window:

```
search(query: "timeout",
       since: "2026-08-27T22:00:00Z",
       before: "2026-08-27T23:00:00Z",
       limit: 100)
```

Header: `26 results (8 fleet, 14 session) — since 2026-08-27T22:00:00.000Z —
before 2026-08-27T23:00:00.000Z`.

**8 + 14 = 22, and 26 rows print.** The four uncounted rows are exactly the four
dated outside the window — 8/25, 8/25, 8/11, 8/9. So one call demonstrates both
halves of the defect at once, in arithmetic: the rows that escape the bound are
precisely the rows missing from the tally.

**Green is `8 + 14 = 22` printed rows, all inside the window.** Red is any
printed row outside it, or a total that exceeds the sum of the parts.

It also sharpens which rows are at fault. `[session] [user] <agent>` rows in
that result **do** obey the bound; only `[session] [undefined]` rows escape it.
Document content is the offender, not session JSONL — consistent with
`searchProjectContent` being the uninstrumented call.

## Defect 3, characterized — `limit` is a hard error, and the advice is wrong

The bounded-call error threshold is **whatever `limit` the caller passed**:

- `limit: 30` → `Bounded query returned ≥30 results — too many to return in one call.`
- `limit: 5` → `Bounded query returned ≥5 results — too many to return in one call.`
- `limit: 100` → returns 26 rows.

So `limit` is being treated as an error threshold rather than a page size, and
the remedy the message names — "Narrow your time range" — is the wrong one. The
range was already one hour; what fixed it was raising `limit`. Combined with the
footer on every full page ("bound it with since:/before:, which returns the full
range"), a caller who follows the printed advice is sent from a working query to
a failing one and then told to do the thing that will not help.

Unassigned. Small, but it is user-facing text that misdirects.

## Defect 6 — the document merge bypasses EVERY filter, not just dates

This generalizes Defect 1 and is probably the most user-visible thing here.
Defect 1 is not "the date bound was forgotten". It is that document rows are
merged in **after** the filter runs and are subject to none of it.

Measured, `search(query: "search type:chat", limit: 25)`:

- header: `25 results (3 fleet, 0 session)`
- **22 of the 25 printed rows are `[session] [undefined]` document rows**
- only 3 are actual chat messages

A `type:chat` query returned 22 non-chat rows and 3 chats. At `limit: 3` it
returns **zero chats** — the document rows take every slot.

**The mechanism is the handler's ordering.** In the `fleet-search` block:

1. `fleetStore.searchAll(...)`
2. `if (msg.eventType) results = results.filter(...)`
3. `if (messageFilter) { ... matchesMessageNode ... }` ← the filter runs here
4. `if (hasText && !historyOnly && !eventOnly) { documentRows merged }` ← **after**
5. `results.sort(by score).slice(0, limit)`

So document rows never meet `type:`, `role:`, `from:`, `to:`, `since:` or
`before:` — and then they compete for the limit on score. Both the date leak and
this are the same line.

**Consequence for the fix, and it changes the scope.** Threading `since`/`before`
into `searchProjectContent` fixes one symptom of a filter that is bypassed
wholesale. Either the document rows are subject to the same filter as everything
else, or they are excluded when a message filter is present.

**Where the product decision starts, and it is Skip's.** Whether document
content belongs in fleet search results *at all* — and whether it should be able
to outrank chat on score — is a decision about what search is for. The repair is
that a filter must filter. Do not resolve the wider question by implementing it.

## Standing constraints

- Verify on the real search surfaces — the MCP `search()` tool and the in-app
  search card. Do not substitute a direct DB query for the product surface.
- Run the counterfactual: break the bound on purpose and confirm the check goes
  red before believing a green one.
- Smallest fix per defect. No new subsystem, no cache, no retry layer.
- Do not deploy. Land on a branch and report.
