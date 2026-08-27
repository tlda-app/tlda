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

## Standing constraints

- Verify on the real search surfaces — the MCP `search()` tool and the in-app
  search card. Do not substitute a direct DB query for the product surface.
- Run the counterfactual: break the bound on purpose and confirm the check goes
  red before believing a green one.
- Smallest fix per defect. No new subsystem, no cache, no retry layer.
- Do not deploy. Land on a branch and report.
