# Fleet search — integration disposition

`search-pm`, 2026-08-27 20:45 EDT. **As of now**, re-checked at the moment of
writing. `main` was `cacc1c64c` when the integration test ran and `83825ebca`
when this was filed — it moves under this document; re-check before merging.

**Nothing below is deployed. Nothing is merged. Nothing is pushed.**

## The four branches

| branch | commit(s) | files |
|---|---|---|
| `search-bound-rowid` | `04cacbd10` | `server/lib/fleet-store.mjs`, `server/lib/search-bound-rowid.test.mjs` |
| `search-date-bound` | `3bab0498b` | `mcp-server/fleet-tools.mjs`, `server/unified-server.mjs`, `server/lib/project-files-store.worker.mjs`, `server/lib/project-files-store-offloop.test.mjs` |
| `fleet-search-thread-pair-wording` | `afeb5db5f` | `mcp-server/fleet-tools.mjs` |
| `search-card-one-control` (`features-pm`'s, not mine) | `d645db5a7`, `39b8b466c` | `src/shapes/FleetChatShape.tsx`, `src/shapes/FleetSearchResultsView.tsx` |

## Overlap: exactly one file, and it is clean

`mcp-server/fleet-tools.mjs` is touched by **`3bab0498b` and `afeb5db5f`**. Hunks
are disjoint — 4370–4431 against 4505–4805 — and the two changes are unrelated in
substance (search-result formatter against thread-tool empty branch). Nothing
else overlaps at all.

**Tested rather than predicted.** All five commits cherry-picked onto `main`
(`cacc1c64c`) in a dedicated worktree, in the order above:

- **all five apply with no conflict**
- all four changed `.mjs` files pass `node --check`
- `npx eslint` clean on every changed `.mjs`
- `server/lib/search-bound-rowid.test.mjs` — **3 pass, 0 fail on the combined
  tree**, which is the check that matters: the rowid fix still holds with the
  other three integrated

## Counterfactuals, per fix

Each is the focused red/green, not a suite run.

**Rowid bound (`04cacbd10`).** Red: `the` over one day on the live 11.1 GB store —
events 15.83s, sessions 8.41s, 35.68s + 24.24s cold = 59.9s, past the 45s client
deadline unaided. Green: 0.07s and 0.10s, **identical id sets**. The naive floor
(earliest row's id) is red on three purpose-built tests — it silently drops rows
in 15 of 60 day-windows on `events` and 23 of 60 on `session_entries`, 2016 rows
worst — because ids are assigned at insert and timestamps are not.

**Document-row filters (`3bab0498b`).** Green on the real MCP `search()` tool
against a sandbox server *and* the MCP server both built from that worktree.
Positive control first — unbounded returns both fixture rows, so a bounded empty
means something. Bounded each direction returns exactly the one in range.
`zonkelberry type:chat` → `No results`, against 22 document rows out of 25 for
that query class on `main`. Printed count equals the sum of the parts in every
run. Red re-taken on live `main` an hour after mine and reproduced the same
arithmetic: 32 printed, 28 counted, four uncounted and out of window.

**Thread pair wording (`afeb5db5f`).** Green on the real MCP surface; red
counterfactual on `main` still prints the corpus sentence; **the route the new
sentence advises was run and answers**; unresolvable name still gets its distinct
error; non-empty pair unaffected.

## Pre-existing failures — verified not ours

- `project-files-store-offloop.test.mjs` (`'./a.tex'` vs `'a.tex'`) — **I ran it
  on clean `main` myself: 4 tests, 3 pass, 1 fail.** Pre-existing.
- `text operators execute with the grammar semantics autocomplete advertises` —
  throws `JuxtapositionError` on committed `main`, red ~27 days, from
  `89ad939c5 One strict grammar` against a test last touched the day before.
  **Belongs to whoever owns the grammar.**
- `global event history remains bounded by the recency index` — same 14/15 on
  HEAD and on the branch.
- A fourth apparent failure was a **measurement error the author caught and
  reported**: three test files in one `node --test` invocation contended; run
  alone it is green both sides.

## Decisions that are not ours

- **`project:`** — restore the server authority deleted by `b278de9b6`
  (2026-07-28, 442 lines, one-line message, no reason, took a 139-line test), or
  remove the parameter and its doc string. **With Skip, unanswered.** Nothing
  built either way. The MCP end currently advertises and sends a parameter that
  is read nowhere.
- **Card wording on a mixed card** — with conversation and documents both
  present the button says "Show more messages" while the fetch brings more of
  everything. `features-pm` dismissed this knowingly; Skip named the string.
  Recorded so it is not rediscovered as a defect.

## Unverified, stated plainly

- **The in-app search card was never driven.** `search-date-bound` argues it
  inherits the server fix structurally — the card's client code is unchanged, it
  groups these rows in its own `doc` group, and it sends the same
  `since`/`before`/`filterExpression` on the same `fleet-search` payload. **That
  is a structural argument, not a run, and it is not being called verified.**
- **A card with a second page may be unreachable on a preview at all.**
  `--sandbox` gives a daemon (project content) but no real fleet history;
  `--real-fleet` gives history but no daemon, so no document and no canvas.
  Neither gives both. This is a gap in how anyone verifies a card change, not one
  agent's misconfiguration.
- **No live stall was caught in the act.** The 88s queue figures are cumulative
  over the current uptime, and a 20-minute sampling window stayed quiet.

## Out of scope, routed, not taken

- One slow search stalls every fleet call — the store is one worker thread,
  `maxDepth 128`, `waitMax 88011ms`, every unrelated method within 600ms of it.
  Abandoned work is never cancelled (`calls === settled === 182,966`), so a
  timed-out search holds the thread ~40s past its caller leaving. The rowid fix
  removes today's worst offender and **does not change this shape.** Explicitly
  not building a queue or cancellation subsystem.
- Three `tlda/await-fleet-store` lint errors on `main` in `unified-server.mjs`.
- `tlda-dev serve` keys its state dir on the literal string `HEAD` for detached
  worktrees, so they collide and `serve status` can answer about someone else's
  server. This handed an agent a stale bundle with a green-looking status.

## Suggested merge order

`04cacbd10` → `3bab0498b` → `afeb5db5f`, then `features-pm`'s pair when they say
so. Tested in exactly that order. The first three are independent of the client
work.
