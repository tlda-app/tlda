# Architecture Invariants — things that must be made impossible

Context: on the night of 2026-06-21/22 a cascade of "should-not-be-possible" states
happened at once — two daemons running, hibernation silently not firing, agents
piling up, duplicate bots over-poking. The app is **built on the assumption that
auto-hibernation works**; when it silently breaks, disasters cascade and Skip has
to manually intervene. The through-line: the system relies on agents *noticing and
hand-fixing* bad states instead of **maintaining invariants** that make them
impossible.

Each item below is an invariant to enforce + how it failed tonight. "Fixed" means
the bad state is structurally impossible and there is a test/alarm proving it —
not a one-off cleanup.

## 1. Daemon is a singleton (per event stream)

**Invariant:** at most one fleet-daemon may be attached to a given event stream
(server + watched folders) on a machine. Two daemons reporting the same agents to
the same server is forbidden — they eat each other's events and poison liveness.

**Allowed:** a *test* daemon pointing at a different server/folder. The singleton
is per-(target server, watch root), not "one process ever" — so test daemons
remain possible.

**How it failed tonight:** a second daemon ran from the `tlda-unfreeze` worktree
(`/Users/skip/work/tlda-unfreeze/bin/fleet-daemon.mjs`, started 01:57) alongside
the main `tlda` daemon, both on the default (Fly) target. No guard prevented it.

**Fix:** lockfile / PID-guard (or launchd-managed) keyed on (target, watch root);
a second daemon for the same key refuses to start (or takes over and evicts the
old one), loudly. Allow an explicit `--target`/folder override to coexist.

## 2. Bots are singletons (per role)

**Invariant:** one `todd` per role/target. Todd owns the hygiene lanes; duplicate
bots multiply the poke rate.

**How it failed tonight:** **three** `bin/todd.mjs` processes were running from
main plus a stale `todd.mjs` from `tlda-unfreeze`. Managed-bot supervision was
moved into the daemon (commit 159aaf74) but standalone bot processes still
accumulate.

**Fix:** the daemon owns bot lifecycle; standalone bot starts refuse if one is
already supervised; a duplicate is detected and killed, not left to double-poke.

## 3. Hibernation must fire AND be observable

**Invariant:** an alive-but-idle agent (no real activity ≥ threshold) is hibernated.
The whole app assumes this. **Silent non-firing is the disaster** — it must raise an
alarm, not just quietly stop.

**How it failed tonight:** liveness was poisoned by the duplicate daemon (#1), so
`getWouldHibernate()` never saw clean idle agents → the auto-hibernate actor never
fired (zero `[hibernate]` log lines in ~36 min) → agents accumulated → manual kills.
Separately, the actor was already mis-built: the 30s liveness ping was counted as
"activity," resetting every idle agent's clock (fixed this session — but unproven
live because of #1).

**Fix:** (a) confirm the actor fires once #1 is enforced; (b) an explicit health
signal — if N agents are alive + idle > threshold and zero hibernations happened in
the last sweep window, log/alert. Hibernation working must be *checkable*, not
assumed.

## 4. Roster is event-maintained, not reconstructed-per-change

**Invariant:** the live roster is an in-memory structure mutated on each event
(register / die / hibernate / heartbeat). Reads serve from it. The DB is
write-through persistence; the full table is queried only for the rare explicit
history view. **Nothing on a hot path pulls ~1000 live agents.**

**How it failed:** `fleet-store` maintains a *cache of a full scan*, not an
event-maintained set. `upsertAgent`/`markDead` write the DB then `_bustAgentsCache()`
→ the next read re-`SELECT`s + re-hydrates **all ~2200 rows** (incl. ~1250 dead,
~940 hibernating) `ORDER BY last_seen`. Under churn the bust fires constantly →
constant full re-scans. The stated point of the refactor ("event-based set
maintenance so we don't run queries") was not delivered. The only event-maintained
piece is the awake-id set in the server (`_aliveAgents`), which the roster reads
ignore.

**Fix:** hold a hydrated in-memory roster; mutate the one changed agent on each
event; serve `getAllAgents`/`getAliveAgents`/counts from it; pull the full table
only for history. Prove reads stop hitting SQL under churn (before/after query
counts).

## Meta

These were "on to-do lists, reported, told they'd be fixed" — and recurred. The
fix discipline that has to change: **real, tested fixes with a proven invariant**,
not untested claims or cleanups that the next bad merge undoes. Each item above is
"done" only when the bad state is structurally impossible + there is a test.
