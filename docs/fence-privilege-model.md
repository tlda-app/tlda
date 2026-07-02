## Fence / privilege model (target)

**Core: every agent — Skip included — is a row. Privileges are a property of the row, per box. There is NO machine-wide default privilege set and no phantom box-policy floor.**

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
