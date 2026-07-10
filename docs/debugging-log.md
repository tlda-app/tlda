# Fleet debugging log

Write down every problem encountered + its diagnosis + the fix. Don't work around
silently; record the root cause so it gets fixed and doesn't recur. One entry per
problem, newest first. (Skip's rule 2026-06-28: "anytime something goes wrong you
write it down and figure it out.")

---

## 2026-06-28 — Todd alive but "not doing anything" (wedged orphan the supervisor wouldn't recycle)

**Symptom:** Skip: "Todd isn't doing rotation — Todd isn't doing anything, they're just
not there." `bin/todd.mjs` pid 57542 WAS running (up 28h), but `todd-decisions.jsonl`
had not been written since 2026-06-27 05:04 — Todd had been brain-dead for over a day.

**Root cause (two compounding bugs):**
1. **Reconnect-deaf:** `todd.log` showed a storm of `502` disconnect/reconnect against
   the mini fleet WS (during the spawn cutover's daemon churn). Todd reconnected the
   socket but stopped emitting decisions — it came back *connected-but-deaf*: the WS
   reopened but Todd did not re-establish whatever subscription/state drives the
   decision loop. After the storm it sat connected and idle indefinitely.
2. **Supervisor liveness = pid-exists:** the daemon's bot-supervisor
   (`bin/lib/managed-bots.mjs`, `daemon-owned on machine_id=mini; watching todd, teacher`)
   only respawns a bot when its pid is *dead*. The wedged Todd's process was still
   alive, so the supervisor considered it healthy and never recycled it. A
   wedged-but-alive bot is invisible to the current liveness check.
   Compounding: pid 57542 was an **orphan** (PPID 1) from a pre-cutover daemon; the new
   daemon (16045, spawn-node-lib) saw the live pidfile and deferred to it.

**Acute fix (done):** killed the wedged orphan 57542. The supervisor's next tick saw the
pid dead and respawned a fresh **supervised** Todd (pid 81923, PPID 16045 = live daemon,
running from spawn-node-lib). It re-subscribed, reconnected to the Fly fleet, and
immediately resumed making decisions (queued an "asymptotics" nudge). Process count = 1.

**Root fixes (open — assigned to a dedicated Todd-reliability owner per Skip's "get
someone on top of Todd shit, it should be good"):**
- Supervisor liveness must be **heartbeat/decision-freshness based**, not pid-exists:
  if Todd hasn't emitted a heartbeat/decision within N seconds, recycle it.
- Todd's WS reconnect must **re-subscribe / restore decision state** so a reconnect
  storm can't leave it permanently deaf.
- **Fleet-wide singleton** ("there cannot be more than one Todd per fleet/DB"): the
  per-machine supervisor guards one machine; a DB/fleet-level guard is needed so no
  second machine or checkout can double-supervise (see the 5-duplicate-Todd entry).

**Related feature (same owner):** explicit `rotate` command — "Todd, rotate this guy
out" = a handoff with **no briefing**; the fresh same-role agent is informed by its
**name-keyed role description** ("if this is your name, this is your role"), not a
context brief. For fixed roles (app-tester, historian) the role description IS the brief.

---

## 2026-06-28 — `git` wrapper forkbombs on air after reboot

**Symptom:** on the `air` box, the `git` wrapper recurses (`bare git "$@"` re-invokes
through PATH) after a reboot — forkbombs. Work-around: use `/usr/bin/git` directly.

**Root fix (open):** the `git` shim must call the real binary by absolute path, not
re-dispatch through PATH (which finds itself). One-line fix in the wrapper.

---

## 2026-06-28 — Agents wedging (process alive, stops responding)

**Symptom:** agents show `status: awake` but stop responding — no `inbox()` polling,
no reply to directed chat. Seen on `ops` (awake, ~34m idle) and `app-tester`
(hibernated mid-task without reporting its perf results).

**Why Todd doesn't catch it:** Todd (`bin/todd.mjs`, daemon-managed bot) kicks
idle-with-task agents via `decideTaskKicks` — but a kick is a **chat nudge**. A
wedged agent isn't polling, so it never reads the nudge. Todd can only re-engage
agents that are still listening; it cannot recover a wedged/hibernating one. Recovery
needs a **respawn**, not a message.

**Root cause of the wedge itself:** UNDER INVESTIGATION — process is alive but stopped
making progress. Candidate causes to check: MCP connection dropped (can't send/recv),
harness hang (stuck on a tool call / dialog), disruption from the daemon restart during
the spawn cutover. Diagnose from a live wedged pane before concluding.

**Fix in flight:** spawn-lib task #22 — auto-wake on directed message (address a
non-live agent → respawn-by-session + deliver queued message) + wedged-awake detection
(delivery timeout without `agent-activity` → treat as wake-needed, respawn). Reuses the
existing server `requestWake` path. NOTE: empirically the existing hibernation→requestWake
path did NOT bring back app-tester/ops, so verify that path actually works end-to-end —
it may itself be broken, not just the wedged case.

---

## 2026-06-28 — 5 duplicate Todd instances

**Symptom:** `ps` shows 5 `bin/todd.mjs` processes: 3 from
`.worktrees/spawn-node-lib`, 1 from main `/Users/skip/work/tlda`, 1 from a
`tlda-dev-mirrors` checkout.

**Diagnosis:** Todd is supervisor-kept-alive (managed bot). A supervisor running in
each checkout started its own Todd. Multiple supervisors over one fleet = duplicate
nudges / possible races. Should be exactly one. Likely amplified by the cutover moving
the live daemon to the spawn-node-lib worktree.

**Confirmed cause:** the 3 spawn-node-lib Todds started 04:27–04:28 — the cutover's
server/daemon restarts spawned new Todds without reaping the old ones. All 5 were
orphans (PPID 1). The pidfile (`~/.config/tlda/todd.pid`) tracked only one (57542,
main checkout).

**Cleanup done:** killed the 4 orphans, kept the pidfile-tracked one → 1 Todd.

**Root fix (open):** the bot-supervisor must singleton-guard Todd — on start/restart,
check the pidfile and don't spawn a duplicate, and reap stale Todds from old checkouts.
Otherwise every server/daemon restart re-accumulates them. **Interaction:** the
shared-DB test server must NOT start its own Todd/bot-supervisor, or it would
double-supervise the live fleet (it shares the live DB where the real Todd already runs).

---

## 2026-06-28 — Fenced worktree agents can't `git commit`

**Symptom:** a fenced agent in a worktree fails `git commit` with `Operation not
permitted` on `.git/.../index.lock`.

**Diagnosis:** a worktree's git objects/refs/index live in the PARENT repo's
`.git/worktrees/<name>/` + `.git/objects` + `.git/refs`, which aren't in the agent's
fence write_roots (only the worktree's `.git` gitfile pointer is).

**Work-around used now:** delve commits on the agent's behalf. **Real fix (queued,
spawn-lib):** add the parent repo's worktree git metadata to write_roots for worktree
agents.

---

## 2026-06-28 — Server down-scopes capability full → write/cwd

**Symptom:** spawning with `capability: full` (even as root) yields granted
`write`/`cwd`. A fenced codex agent then can't run (nested sandbox-exec) until fix #10.

**Status:** fix #10 (codex danger-full-access when fenced) shipped, so fenced codex
RUNS. The down-scope itself: flagged to spawn-lib — determine if intended or a
fence-experiment leftover. Not yet resolved.
