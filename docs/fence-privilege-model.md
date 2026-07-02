## Fence / privilege model (target)

**Core: every agent — Skip included — is a row. Daemon privileges are a property of the row, per box. There is NO machine-wide default privilege set and no phantom box-policy floor.**

**Two orthogonal permission domains — don't conflate them:**
- **Daemon permissions** (local, per-box: files, spawn, exec, git). Enforced by the daemon. **This is the scope of the fence-config fix.** The config + clamp + daemon-local ledger all live here.
- **Server permissions** (what an agent may do *to the server*: direct DB write vs API-only, privileged fleet ops). Enforced server-side. Separate governor; does NOT intersect with daemon permissions.

**Three legitimate live clamps at spawn** (this intersection is CORRECT, keep it):
`granted = spawner's current privileges  ∩  requested  ∩  model-cap-on-this-box`
- spawner clamp = anti-escalation (can't grant more than you have; chains down the spawn tree)
- requested = ≤ what was asked
- model cap = per-box ceiling per model (runaway-prone models capped regardless of spawner)

**Two stores:**
1. **Config file — the RULES.** Gitconfig/SSH-style, human-edited, part of the **daemon's** config, **per box**. Holds: named profiles (`full`/`app-dev`/`read-only`/`none`); model caps per box; **root ceilings keyed by fleet ID** (Skip, todd, named seats → profile; **unknown fleet ID → `none`**). Only roots need pinning.
2. **Daemon's local agents table — the STATE.** Per box, keyed by fleet ID: each agent's **current granted privileges**. Seeded at spawn from the clamp; a **runtime grant is a clamped write to this row** applied to the live fence with no respawn.

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
