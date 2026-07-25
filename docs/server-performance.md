# Why the server goes deaf, and the rules that keep it from happening again

The tlda server is one process. Every fleet chat, every activity card, every
heartbeat, and every document sync frame goes through one event loop. Anything
synchronous on that loop is time during which the server answers nobody — not
the browser, not the daemon, not its own heartbeat. When Skip says "chat works
for a minute and then the server stops answering," that is what he is describing.

The database is large and will keep getting larger. **Making it smaller is not a
strategy** — it grows back, and the telemetry in it is the record of what has
been breaking. The requirement is that the app is fine with a big database.

## The rules

### 1. The first question about any query is whether it should run at all

Not how to make it faster. Ask in this order:

1. Does anything consume the result? If not, delete the query.
2. Does it need to run this often, or on this path at all?
3. Only then: index it, bound it, move it off the loop.

Deleting dead work beats optimizing it, and it is the only version that stays
fixed. Two instances found in one night:

- `resolveWiretaps` performed a full `getAgent()` + `_hydrateAgent()` **per
  subscription, per message** to produce a value that only a `my_labels` filter
  ever reads. With ~2000 subscriptions on the live box that was ~2000 agent loads
  per event and 39% of all non-idle CPU, to compute something nothing read.
- The daemon liveness batch re-checked ~190 agents every 30 s whose death report
  the server then discarded — the death signal that would have cleared them was
  the exact thing being thrown away.

### 2. One indexed query, not a loop of lookups

If you are iterating a collection and doing a database call per item, that is one
query with a `WHERE` clause the index can answer. If the index does not exist,
add it — that is in scope, not a separate task.

A loop of N cheap lookups is invisible to per-query instrumentation and lethal to
the event loop. 190 × 4 ms is 760 ms of deafness that no slow-query log will ever
print.

### 3. Small, slow-changing, hot-path data belongs in memory

Matching 2000 subscriptions in memory costs nothing. Doing 2000 database round
trips per event is the failure. Data that is small, changes rarely, and is read
on every event should be resident in the process and refreshed on change.

**One invalidation path only.** A cache that can go stale in a second way is the
disease being removed, not the cure.

### 4. Cost must not scale with things merely existing

Death is rare; agents accumulating is not. A design whose per-event cost grows
with the number of agents that have ever been created will fail as the fleet
grows, and cleaning up old rows only defers it. Fix the scaling, not the count.

## Instrumentation, and its blind spots

Three layers exist. Know what each cannot see.

| Layer | Sees | Blind to |
|---|---|---|
| `[slowquery]` (`fleet-store.mjs`) | any `.all()`/`.get()` over 25 ms | loops of sub-threshold queries; every `.run()` write, which it does not wrap at all |
| `[event-loop-lag]` / `[hot-op]` (`unified-server.mjs`) | that the loop stalled, and by how much | what stalled it |
| **lag profiler** (`server/lib/lag-profiler.mjs`) | the actual stack during the stall | nothing relevant — it samples the thread itself |

The first two are why the top cost on the server stayed invisible for so long: it
was neither a single slow query nor a write, but thousands of fast reads.

### The lag profiler

Always on. V8's sampling profiler runs on **its own thread** and interrupts the
isolate, so frames from inside a stall are captured *as they happen* and sit in
V8's buffer; only the disk write waits for the loop to recover. That is what
makes a lag-triggered dump possible at all.

- Rolling 10 s windows keep memory bounded; two are retained so a stall near a
  window boundary is still fully covered.
- A tick whose own overrun exceeds 250 ms is the trigger. The deadline is stamped
  when the timer is *scheduled*, not when it fires — read at fire time a timer can
  never be measured as late.
- Dumps land in `<config>/lag-profiles/` with a one-line summary appended to
  `lag-profiler.log`. Rate-limited to one per minute so a sustained stall cannot
  fill the disk.
- Status is exposed at `/api/diagnostics/live-perf` under `server.lagProfiler`.

Tunable via `TLDA_LAG_PROFILER_*` environment variables; the defaults are the
intended production settings.

When the server next goes deaf, it names its own cause. Nobody has to be watching.
