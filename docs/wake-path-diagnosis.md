# Wake-path diagnosis — why chatting a hibernating agent doesn't wake it

**Date:** 2026-07-06. **Author:** plzplzhelpme (lead). **Status:** root cause CONFIRMED
(code + live behavior). Fix not yet landed.

## Symptom (Skip, live)
Chatting a hibernating agent (`releast`) — even with **urgent** priority, which
bypasses batching — did **not** wake it. No warning to Skip, no error to the
requester (me). The agent just stayed "hibernating." CLI `tlda agent wake releast`
woke it in ~18s.

## The split (Skip's framing, correct)
- **Notification / batching is NOT the failure.** It's working as designed: a
  `busy`/DND agent batches, and the sender is *told* the message is deferred — like
  texting someone on Do Not Disturb. Intended behavior. Keep it.
- **The wake is the failure.** "Waking = respawning" — a hibernating agent has **no
  process** (no "light sleep"), so waking it means respawning from its session. That
  respawn is what silently fails on the chat path.

## Root cause (confirmed)
The daemon spawn RPC **requires a `requester` identity**, and the server's
wake→respawn callers **don't pass one**.

1. `bin/fleet-daemon.mjs` `rpcSpawn` (~L3210):
   ```js
   if (!requester?.id) {
     const err = new Error('spawn refused: daemon RPC requester identity is required')
     err.code = 'SPAWN_PERMISSION_NO_REQUESTER'; throw err
   }
   ```
   The throw is caught two lines down and returned as
   `{ ok: false, error: 'spawn policy resolution failed: …requester identity is required' }`
   — **not** an exception to the caller.

2. Server wake→respawn callers omit `requester`:
   - chat-wake: `unified-server.mjs:4159` — `sendRpc(daemonKey, 'spawn', { name: agentId, respawn: true })`
   - task-renudge: `unified-server.mjs:644` — identical, no `requester`.

   Both get `{ ok: false }` back. Neither checks `spawnResult.ok`. Line 4159 then
   even records a **false** `agent woken` lifecycle event (`:4162`).

3. Because `{ ok:false }` is a value, not a throw, the `catch` that would chat Skip
   `⚠️ Couldn't wake <agent>` (`:4165–4178`) **never fires** → the failure is fully
   silent (no warning, no error, nothing useful in the daemon log — `rpcSpawn`'s
   requester-reject path doesn't log either).

## Why CLI works but chat doesn't (the divergence)
- **CLI `tlda agent wake`** → `runFleetSpawn` (`cli/tlda.mjs:2064`) imports
  `bin/lib/spawn/index.mjs` and spawns **in-process**, resolving the grant against a
  locally-built ledger. It **never calls the daemon `rpcSpawn`**, so the requester
  gate doesn't apply. → works.
- **MCP explicit spawn** (`unified-server.mjs:~1259`) builds `spawnRequest` **with**
  `requester: { id, name, … }` from `caller`. → works.
- **Chat/delegate wake** (4159 / 644) → daemon `rpcSpawn` **without** requester. → fails.

This is a **permissions-refactor regression**: the refactor tightened `rpcSpawn` to
require a requester identity, but the two server wake callers were never updated to
supply one. Classic "build on top of what's there" gap — the paths diverged.

## Fix (two parts — matches Skip's mandate)

### A. Make wake actually work — WITHOUT a drive-by privilege change
Naive fix ("just pass a requester") has a **trap**: on a respawn, `rpcSpawn`
re-derives the grant from the *requester* (`resolveSpawnGrant`, ~L3232) and then
**overwrites the woken agent's ledger entry** with it (L3324–3330). It never loads
the woken agent's *own* stored grant. So passing e.g. a server-owner (ops) requester
would let the server **redefine an agent's permissions on every wake** — a silent
privilege change (relates to known bug [[privilege-respawn-server-driven]]).

Correct fix:
1. Server wake callers pass **both** the woken agent's identity (`agent_id: agentId`)
   **and** a requester (server-owner) — the requester authorizes *whether* the wake is
   allowed; it must not redefine the agent.
2. Daemon `rpcSpawn`: for a **respawn of an already-ledgered agent**, resolve the grant
   from **that agent's existing ledger entry**, not the requester's — preserve the
   agent's permissions across a wake. Only genuinely fresh spawns derive from the
   requester. (Decision for Skip: is "wake preserves the agent's own grant" the intended
   rule? It should be — a wake is not a re-permissioning.)
3. Fix both callers (4159 chat-wake, 644 task-renudge). Verify: chat a hibernating agent
   → it respawns with its *own* permissions unchanged; no CLI needed.

Note: the CLI wake also does **not** preserve the stored grant today — `tlda agent wake
releast` with no `--permissions` launched it "unfenced/full." So grant-on-wake is a
cross-path correctness gap, not unique to the chat path.

### B. Make failure VISIBLE (never silent again) — Skip's core ask
- **Check `spawnResult.ok`** in both wake callers. On `ok:false`, surface it — don't
  drop it and don't write a false "agent woken" event.
- **Surface to the requester**, not just (or instead of) the server owner — Skip:
  "the warning should be to who asked." The agent/human who chatted gets the failure.
- **In the MCP return status**: a chat/delegate that triggers a wake should carry the
  wake outcome back in its result, so the caller sees "wake failed: <reason>".
- **In the UI**: an agent-level status/error surface (convergent, per the 6/27
  agent-wedged event pattern) so a failed wake is visible on the roster, not invisible.

### C. Simplify + rename (Skip's mandate; separate, larger)
- Unify on **waking** language; retire "spawn/respawn" as the antiquated term where it
  means "bring an agent back."
- Collapse the indirection layers between chat → notification → wake so the path is
  understandable. Batching stays as a clean opt-in (it's correct), just not buried in
  layers.
- Candidate for a delegated clean-factoring once the shape is agreed.

## Evidence log
- `releast` (`fleet:c16d9c53`) hibernating, no tmux session on Mini. Chat + urgent →
  stayed hibernating, no warning/error. `tlda agent wake releast` → awake in 18.7s,
  called `inbox()`. → respawn works; the chat path to it is what's broken.
- Machine: this is `mini.local` (where agents run); daemon pid 33260 healthy, WS to
  server live (chats flow), but received no *successful* spawn for the chat-wake.
