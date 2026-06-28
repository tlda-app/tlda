# Spawn infrastructure rewrite — design

## In brief

Two things from mapping it:

1. **The "parallel node implementation" was never real.** It's python all the way
   down — the node branch someone started just added a tiny loopback listener that
   calls the *same* code that shells out to python. So this is a real port, not a
   merge of two half-things.
2. **The opaque `[object Object]` failures have a clear cause:** today a spawn's
   result carries no real error; failure is guessed *after* launch by scraping the
   tmux pane for a few regex patterns. Anything unmatched → `[object Object]` and a
   lingering shell.

**The design:** one node module tree the daemon **imports directly** (it's already
node), exposing `spawn(params)` that returns a structured result and throws typed
errors. That single move kills both the coordination tax (change is *in* the daemon)
and the opaque errors (real error codes). Fence stays the existing `fence` binary —
the python only *builds a lease and invokes it*, so that ports cleanly and the
security boundary is untouched. The aliases / only-real-options / no-roster-lies
backlog all fall out as facets of the one clean registry + structured result.

It's a genuine port (~2500 lines of battle-hardened python with real fragile fixes),
so I'm doing it **incrementally with parity gates** — the old path keeps working
until each replacement is proven, so a half-finished port never wedges live spawning.
Step 1 is skeleton + registry + claude-unfenced behind a flag. Full design below;
I'm starting step 1 now.

---

**Goal:** replace the organic ~2500-line `bin/fleet-spawn.py` with one clean node
library the daemon **imports directly**. No subprocess, no python, no "get the
change into the daemon's checkout" coordination. Spawn becomes a module the daemon
calls in-process, with a thin CLI on top for manual `tlda agent spawn` use.

## The key insight

`bin/fleet-daemon.mjs` is already node. Today it spawns by shelling out:

```
rpcSpawn(params) → buildFleetSpawnArgs() → execFileP('tlda', ['agent','spawn-local', …]) → fleet-spawn.py
```

That subprocess hop is the source of two recurring pains:
1. **The coordination tax** — the daemon runs `fleet-spawn.py` from *its* checkout,
   so any spawn change has to physically reach that checkout. We kept treating this
   as a hard blocker. It isn't real; it's an artifact of shelling out.
2. **Opaque failures** — the spawn result doesn't carry a real error. Failure is
   detected *after the fact* by a detached `probeSpawnStartupFailure` that captures
   the tmux pane and regex-matches a handful of patterns. Anything it doesn't match
   surfaces as `spawn failed: [object Object]` or a WS timeout, and the pre-
   registered shell lingers.

Importing a node `spawn()` directly kills both: the change is *in* the daemon's
code, and the function returns a structured result/throws a typed error.

## What spawning actually does (scope, honest)

This is not a thin script. The port must cover, at parity:

- **4 spawn paths:** fresh (new id), refresh (same id, fresh session), respawn
  (resume), respawn-by-session (by JSONL/rollout uuid).
- **3 harness adapters:** claude, codex, goose — each with model resolution,
  command building, and resume-transcript scanning.
- **Identity + registration:** fleet-id/name/tmux-session resolution, name-collision
  check, ws `register` incl. the **shell pre-register** flag, config-name stamping,
  mkcert/TLS for multi-machine.
- **tmux machinery:** session/pane create + respawn-pane runtime guard, fixed window
  size, send-keys path (codex TUI MAX_CANON workaround), prompt injection with
  dialog-dismissal grace windows, fcntl wake-lock (single-flight respawn).
- **Capability / fence / sandbox:** the 4-rung capability model, policy resolution,
  fence **lease JSON** + invoking the `fence` binary, write-roots, the DNS-alias
  NODE_OPTIONS preload for fenced agents.
- **Resume scanning:** parse `~/.claude/projects/**.jsonl` and
  `~/.codex/sessions/**/rollout-*.jsonl` for the agent's own first `Registered
  fleet:` line; synthetic-tail stripping.
- **Model registry:** aliases, goose-verified set, codex models, `--list-models`.

Each carries documented fragile fixes (death-loop guard, devchannels grace window,
synthetic-tail strip, first-registration-only scan, DNS alias). A naive rewrite
re-introduces those bugs — so this is an **incremental, parity-gated port**, not a
big-bang.

## Reuse first: `shared/spawn-librarian.ts` is the lifecycle brain

Before writing any lifecycle/liveness/failure logic, **adopt the existing one.**
`shared/spawn-librarian.ts` (366 lines, tested, **wired into nothing** today — only
its own test imports it) already models exactly the state layer this rewrite needs:

- `LivenessState = alive | dead | spawning | wedged | unknown` — the truthful-liveness
  / roster-lie fix.
- `SpawnFailureReason = launch-failed | register-timeout | policy-denied | name-bounced`
  — **typed failure reasons = the opaque-`[object Object]` fix**, already enumerated.
- `SpawnLibrarian` class: `awaitRegister`, `observeRegister`, `failPending`,
  `observeLiveness`, `observeActivity`, `observeDelivery`, `livenessState`, `decideWake`.
- Helpers: `buildSpawnBounceItem`, `resolveSpawnCollision`, `specMismatch`.

The python and the server each reinvent a worse, ad-hoc version of this. **The rewrite
wires `SpawnLibrarian` in as the brain** rather than re-spec'ing it. That means the
node lib below is almost entirely **mechanics** — `spawn-librarian` has no `exec` and
launches nothing; it only tracks state. So the genuinely-new code is: launch tmux,
build harness commands, ws-register, fence. The lifecycle/typed-errors come from the
librarian. (If the librarian is missing a state or reason the mechanics need, extend
*it* — don't fork a parallel state model.)

## Target architecture

A node module tree (proposed `bin/lib/spawn/`), consumed by the daemon and a thin CLI.
The lib produces events the `SpawnLibrarian` observes; the librarian owns lifecycle:

```
bin/lib/spawn/
  index.mjs        # spawn(params) orchestrator: fresh|refresh|respawn|session
  models.mjs       # registry — single source of truth (aliases, goose-verified,
                   #   codex); serves --list-models AND the capability probe
  identity.mjs     # fleet-id/name/session resolution, name-collision check
  register.mjs     # ws register incl. shell pre-register; config/TLS resolution
  harness/         # each engine isolated behind ONE adapter interface; an
    claude.mjs     #   adapter knows nothing about permissions/fence — it builds
    codex.mjs      #   a command, the orchestrator applies the resolved policy.
    goose.mjs      #   adapter: resolveModel, buildCmd, findResume, afterResume…
  tmux.mjs         # session/pane/send-keys/capture/wake-lock/prompt-injection
  permissions.mjs  # capability rung → policy resolution. PURE LOGIC, no exec,
                   #   no harness knowledge. Just decisions: what's allowed.
  fence.mjs        # takes a RESOLVED policy → builds lease JSON → invokes the
                   #   existing `fence` binary. Mechanics only; no policy logic.
  resume.mjs       # JSONL/rollout transcript scanning, synthetic-tail strip
  capabilities.mjs # NEW: probe which harnesses/models actually run on THIS box
  cli.mjs          # thin argv front-end for manual `tlda agent spawn`
```

### The API the daemon imports

```js
import { spawn } from './lib/spawn/index.mjs'

const result = await spawn({
  mode: 'fresh' | 'refresh' | 'respawn' | 'session',
  name, model, kind, cwd, effort, permissionMode,
  capability, agentId, sessionId, attach: false,
})
// → { ok: true, fleetId, tmuxSession, harness, model }
// → throws SpawnError { code, message, detail } on failure (no [object Object])
```

`rpcSpawn` in the daemon becomes a thin wrapper around this — same RPC surface to
the server, but the result/error is now structured and returned synchronously where
possible. The post-launch `probeSpawnStartupFailure` stays (some failures only show
in the pane after boot) but it's now the *second* line of defense, not the only one.

### Fence is not a security rewrite

The python doesn't implement sandboxing — it **builds a lease JSON and invokes the
`fence` binary** (`fence --settings lease.json -- zsh -lc '<cmd>'`). The node port
builds the same JSON and invokes the same binary. The security boundary (the `fence`
runner) is untouched. This is the part I was most worried about, and it turns out to
be config construction, which ports cleanly.

## How the backlog gets solved here (as facets, not loose threads)

- **Clean one-word aliases** (`gpt55`): `models.mjs` is the one registry; aliases are
  normalized there. (Down-payment already on `batch-integration`: `a30f9d10` dropped
  dead `fable`, added `gpt55`.)
- **Only-real options + capability defaults:** `capabilities.mjs` probes the box
  (which of claude/codex/goose/cursor are installed + authed; which goose models are
  verified). The picker reads it per-box and the default picks the best available.
- **No roster lies / mark dead on all failures / no opaque errors:** structured
  return + typed errors mean a failed spawn marks the shell dead deterministically,
  and the error has a real code instead of `[object Object]`.
- **Shell pre-register:** baked into `register.mjs` as a first-class path.

## Incremental plan (parity-gated — spawning never breaks)

1. **Skeleton + registry + claude unfenced.** Stand up the module tree, port
   `models.mjs`, `identity.mjs`, `register.mjs` (incl. shell), `tmux.mjs`, and the
   claude harness for the common cwd/unfenced case. Daemon imports `spawn()` behind a
   flag; a real claude agent spawns through the node path at parity.
2. **Codex + goose harnesses.** Port both adapters behind the same interface.
3. **Fence + capability + resume.** Port the lease builder + DNS alias, the resume
   scanners, the capability probe.
4. **Reliability + shell hardening.** Truthful liveness, mark-dead-on-all-failures,
   typed errors; carry the live e2e shell proof.
5. **Cutover.** Flip the daemon to the node path unconditionally, delete
   `fleet-spawn.py` and the `spawn-daemon-local-entry` loopback stub, drop the python
   from `tlda agent spawn-local`. No backward-compat shims.

Each step keeps the old python path working until its replacement is proven, so a
half-finished port never wedges live spawning.

## Open choices (small — flagging, not blocking)

- **Module location:** `bin/lib/spawn/` (next to the daemon, which imports it) vs
  `shared/spawn/`. Leaning `bin/lib/spawn/` since the daemon is the primary consumer.
- **CLI:** keep `tlda agent spawn-local` as the command name, now backed by
  `cli.mjs` instead of python.

Neither blocks step 1.
