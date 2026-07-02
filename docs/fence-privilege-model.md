## Fence / privilege and robustness model (target)

**Core: every agent — Skip included — is a row. Daemon privileges are a property of the row, per box. There is NO machine-wide default privilege set and no phantom box-policy floor.**

**Two orthogonal permission domains — split by where the action executes, not what it affects:**
- **Daemon permissions** = anything run *on the box*: files, spawn, exec, git, **and network/deploy** (`fly deploy`, remote push, `~/.fly` creds). Deploy runs locally, so it's daemon-governed even though it hits a remote host. Fly/deploy is a single binary daemon capability — you can use Fly or you can't. No granular Fly sub-permissions locally; one on/off in the daemon profile gates all deploy/Fly access. Fly's own permissions handle anything finer long-term. Enforced by the daemon. **This is the scope of the fence-config fix.** The config + clamp + daemon-local ledger all live here.
- **Server permissions** = actions against the tlda server's own API/DB (`db-write-direct`, fleet registry ops). Enforced server-side. Separate governor; does NOT intersect with daemon permissions.

**Three legitimate live clamps at spawn** (this intersection is CORRECT, keep it):
`granted = spawner's current privileges  ∩  requested  ∩  model-cap-on-this-box`
- spawner clamp = anti-escalation (can't grant more than you have; chains down the spawn tree)
- requested = ≤ what was asked
- model cap = per-box ceiling per model (runaway-prone models capped regardless of spawner)

**Three files/stores, three roles:**
1. **Daemon config — ceilings/authority.** Gitconfig/SSH-style, human-edited, part of the **daemon's** config, **per box**. Holds named profiles (`full`/`app-dev`/`read-only`/`none`, including the binary Fly/deploy on/off capability); model caps per box; **root ceilings keyed by fleet ID** (Skip, todd, named seats → profile; **unknown fleet ID → `none`**). Only roots need pinning.
2. **Project file — default request.** An in-repo config file, checked into the project like `.editorconfig`. It declares the default `requested` level for agents spawned into that project without an explicit capability. It only fills the `requested` slot, so it is still fully clamped by `spawner ∩ requested ∩ model-cap`. A project file can declare `full` and still never escalate past what the spawner row/model cap allow. Convenience, never authority.
3. **Daemon's local agents table — live grant state.** Per box, keyed by fleet ID: each agent's **current granted privileges**. Seeded at spawn from the clamp; a **runtime grant is a clamped write to this row** applied to the live fence with no respawn.

**`none` is truly empty.** An unknown/untrusted fleet ID gets no read roots, no write roots, no plumbing, and no `spawn` privilege. Spawn is a gated daemon privilege: a row without `spawn` cannot create children and cannot bootstrap a fleet. This is separate from the server-side `spawners` table.

**Shipped default daemon grant:** `write_roots: [".", general-temp]`, `read_roots: [".", general-temp]`, `spawn: true`, plus plumbing needed to function: git metadata, worktree metadata, and existing scratch/browser caches. `general-temp` includes `/tmp`, `/private/tmp`, and macOS `$TMPDIR`/`/var/folders/...` temp locations so the default `git worktree add /private/tmp/<x>` approach works without a special convention. The shipped default does **not** include credentials, Fly, deploy, Keychain, `~/work`, or other off-box access; those are user-config additions only.

**Lifetime:**
- Grant is keyed on **fleet ID**, lives on the row → **survives hibernation** (hibernation = no process, row persists).
- Does **NOT** auto-follow **handoff** (successor = new fleet ID, re-derives from its spawner ∩ model-cap). Last night's incapacity was exactly this: a handoff/successor spawned at ~`none`, so its subtree inherited `none`.

**Security placement (hard):**
- **Trust root = the daemon (local), NEVER the server/app.** Server only *requests*; daemon *decides + enforces*. The app must never grant privileges.
- Privilege ledger lives in the **daemon's** local table, NOT the shared server registry — that's what makes "same agent, different privileges on Mini vs Fly" fall out, and keeps the fence working when the shared db is unreachable.
- **Next layer (design-ready, not blocking):** fleet ID becomes **stable + cryptographic** — unforgeable identity the agent *proves*. Build the config/grant storage ready to key on it, but don't block the config fix on it.

**NOT in scope here:** the partial-rename ghost-hell is a **friendly-name** atomicity bug at a different level — do not try to solve it with this work.

**Server permission: `db-write-direct`.** `db-write-direct` is a distinct server permission, separate from daemon permissions. Rationale: writing the server DB directly bypasses the event-emitting API and can leave state half-applied (this is the root of the partial-rename ghost-hell — a bot wrote a rename row without firing the rename events).
- **Off by default.** Only ops/repair seats get it (escape hatch for when the API path itself is broken).
- **Every bot (todd) and every doer is denied it** — they're forced through the API, which writes + emits events atomically.

Keep the server-permission side minimal for now. Skip's long-term intent is to lean on **Fly's** platform permissions for server enforcement rather than a bespoke system, so don't build server-permission machinery now; just note the category and the `db-write-direct` capability. The *enforcement* that identity mutations must go through the event-emitting API is workstream #2 — note it as related, but don't build it now.

**Server-identity gating (kill switch) — separate from daemon fence:**
- Two tables of authorized **server identities**: `spawners`, `hibernators`. Checked at the **RPC boundary**: a spawn/hibernate RPC executes only if the calling server's identity is listed. Not listed → refused.
- Hibernation is THE chaos vector (false-hibernate → respawn → kill); kill/spawn are secondary.
- **File-authored, hot-reload, NO daemon restart** to apply. App/API can NOT write these tables (that's what keeps the switch trustworthy). Emergency use: pull a server from `hibernators` → all destructive action through it halts instantly.

**Persistence:**
- Daemon-local live state (per-box privilege grants etc.) persisted to a **daemon-local file, atomic write-through (temp+rename), reload on start.** A bounce restores rather than resets — defuses the restart-landmine.
- **Format: YAML across the board** (config files AND the state file) — JSON is unreadable. Human-authored config (fence config, spawners/hibernators) is YAML with comments; the machine-written state file is YAML too for uniformity.

**Atomic rename (cross-reference, workstream #2, not this build):**
- `/api/rename` at `server/routes/fleet.mjs:614` does a raw `UPDATE friendly_name` with only `broadcastState()`, skipping `_bustAgentsCache()`/`_syncAgentRegistry()` → partial rename.
- Related known bug: fix routes through `upsertAgent` or adds the cache/registry sync in-transaction.
