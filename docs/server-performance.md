# Diagnosing a deaf server

The rules for *not writing* this class of bug are in **`docs/fleet-design-rules.md`** —
single indexed queries not loops of lookups, use the in-memory index, don't shrink the
data to hide a slow path, ask whether the query should run at all. This file is the
other half: how to find one that is already running.

The tlda server is one process. Every fleet chat, activity card, heartbeat, and document
sync frame goes through one event loop. Anything synchronous on that loop is time during
which the server answers nobody. "Chat works for a minute and then the server stops
answering" is that, seen from the browser.

## Know what each instrumentation layer cannot see

| Layer | Sees | Blind to |
|---|---|---|
| `[slowquery]` (`fleet-store.mjs`) | any `.all()`/`.get()` over 25 ms | loops of sub-threshold queries; every `.run()` write, which it does not wrap at all |
| `[event-loop-lag]` / `[hot-op]` (`unified-server.mjs`) | that the loop stalled, and by how much | what stalled it |
| lag profiler (`server/lib/lag-profiler.mjs`) | the actual stack during the stall | nothing relevant — it samples the thread itself |

The first two are why the largest cost on the server stayed invisible: it was neither a
single slow query nor a write, but ~2000 fast reads per event. A per-query threshold
cannot see 2000 × 0.05 ms, and 190 × 4 ms of seat lookups is 760 ms of deafness that no
slow-query log will ever print.

**A measurement tool that cannot see the failure mode is how a bug survives.** When a
stall has no attributable cause in the logs, suspect the instrumentation before
concluding the code is fine.

## The lag profiler

Always on. When the loop stalls, it dumps the stack from that moment, so the next outage
names itself instead of requiring someone to be watching.

V8's sampling profiler runs on **its own thread** and interrupts the isolate, so frames
from inside a stall are captured *as they happen* and sit in V8's buffer; only the disk
write waits for the loop to recover. That is what makes a lag-triggered dump possible at
all — a sampler running on the blocked thread would have nothing to report.

- Rolling 10 s windows bound memory; two are retained, so a stall near a window boundary
  is still fully covered.
- Trigger: a 100 ms tick whose own overrun exceeds 250 ms. The deadline is stamped when
  the timer is *scheduled*, not when it fires — read at fire time, a timer can never be
  measured as late.
- Dumps land in `<config>/lag-profiles/`, one-line summaries append to
  `lag-profiler.log`. Rate-limited to one per minute so a sustained stall cannot fill
  the disk.
- Status at `/api/diagnostics/live-perf` under `server.lagProfiler`.
- Tunable via `TLDA_LAG_PROFILER_*`; the defaults are the intended production settings.

## Reading a query plan against the real database

Plans are worth more than timings, because a timing is a page-cache accident and a plan
is the shape of the cost. `SEARCH ... USING INDEX x` followed by `USE TEMP B-TREE FOR
ORDER BY` means the whole matching set is read and sorted before `LIMIT` discards it —
cost grows with total history, and no amount of hardware fixes it.

The same query measured 37 ms warm and 15.2 s cold on the live box. Warm timings hide
this class of bug completely; the plan does not.

Read-only diagnosis against live is safe and is how all of the above was measured. Do
not run `PRAGMA wal_checkpoint`, `VACUUM`, or anything that writes.
