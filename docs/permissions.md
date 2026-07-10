# Agent permissions — the one authoritative model

**Read this before you say anything about fencing, permissions, or how a spawn is
sandboxed.** Almost every wrong thing an agent has ever told Skip about this
subsystem was invented instead of read. This file is the ground truth. If the
code and this file disagree, that is a bug in one of them — fix it, don't route
around it. Don't paraphrase from memory.

> One word: **permissions**. Not "capability", not "privileges". Those are dead
> language being removed from the codebase. If you see them in code, they are on
> the list to delete, not vocabulary to copy.

---

## The whole model in four sentences

1. A **permission profile** is a named read/write policy (e.g. `wd`, `math`,
   `ops`) built out of named **path regions** (e.g. `cwd`, `work`, `apps`,
   `secrets`, `machine`).
2. Profiles and regions are defined in one place: **`~/.config/tlda/daemon.yaml`**
   on the machine where agents run (the Mac mini).
3. **Fencing is opt-in.** An agent runs *unfenced* (full, normal access) unless a
   spawn **explicitly asks** for a fence. Nothing else — no stored grant, no
   default — puts an agent in a fence.
4. When a spawn *does* ask for a fence, it gets the **named profile** it asked for
   (or the one granted to that agent in `daemon.yaml`), and the spawn reports
   which profile it used.

That is the entire model. There is no second system.

---

## The path regions (from `daemon.yaml`)

A region is just a named list of path globs. The real definitions live in
`daemon.yaml` under `regions:`; the load-bearing ones:

| region | what it covers |
|---|---|
| `cwd` | the agent's working directory only |
| `temp` | `/tmp`, `/private/tmp`, `/var/folders/*/*/T` |
| `work` | `~/work/**` |
| `apps` | `~/work/tlda/**` |
| `agent-state-read` / `agent-state-write` | the harness's own state (`~/.codex`, `~/.claude`, `~/.config/tlda`, caches) |
| `browser-runtime` | playwright runtime + chrome-for-testing |
| `daemon-db` | `~/.config/tlda/fleet.db*` (write-denied even to broad profiles) |
| `secrets` | ssh/gpg/aws/gcloud keys, `.env*`, `*.pem`/`*.key` — **write- and read-denied to every profile** |
| `machine` | `**` (the whole machine) |

## The permission profiles (from `daemon.yaml`)

Each profile is `read: {allow, deny}` and `write: {allow, deny}` over regions.
The real definitions live in `daemon.yaml` under `profiles:`. As currently
configured:

| profile | reads | writes | in one phrase |
|---|---|---|---|
| `readonly` | cwd, temp, agent-state | *(nothing)* | look but don't touch |
| `wd` | cwd, temp, agent-state | cwd, temp, agent-state | **the working-directory cage** |
| `math` | `~/work`, temp, agent-state | `~/work` (but **not** the app), temp, agent-state | math work, can load fleet tools, hands off tlda writes |
| `app` | cwd, temp, daemon-files, browser-runtime, agent-state | same | app dev + browser testing |
| `ops` | **machine** (`**`) | **machine** (`**`) | whole machine, minus secrets/daemon-db |

Every profile denies `secrets`. Every writing profile also denies `daemon-db`.

> **`ops` is not a cage.** `ops` = the whole machine minus secrets. It is the
> *most* open profile, not a restrictive one. (An agent once told Skip "ops is a
> cwd cage." That was fabricated. This table is why.)

## Grants

`daemon.yaml` `grants:` maps an agent id to a profile it should get **when it is
fenced**. Currently:

```yaml
grants:
  fleet:skip: ops
```

A grant is the profile to use **if a fence is requested for that agent**. Since
fencing is opt-in, a grant by itself does **not** fence anyone.

---

## What happens on a spawn (behavior contract)

- **No fence requested → unfenced.** Full normal access. This is the default.
- **Fence requested → fenced with the named profile.** The spawn resolves the
  profile (the requested one, else the agent's grant) and applies it.
- A stored grant **cannot** silently fence an agent that didn't ask. (This used
  to happen and was the source of the "I can never opt out" nightmare; it is
  fixed — see history below.)

### How to spawn — the two commands

- **Unfenced (full access):** `tlda agent create NAME --cwd ~/work/tlda`
  No `--permissions` flag = no profile = unfenced. This is the default.
- **With a permission profile:** `tlda agent create NAME --permissions ops`
  Naming a profile via `--permissions` is the request; the agent gets that profile.

The flag is **`--permissions <profile>`** — one word, the same word as everywhere
else. There is no `--policy` and no `--fence` flag (both are excised).

### How you tell what an agent actually got

Every spawn prints the permission decision and where it came from, e.g.
`permissions: none (no fence requested)` or
`permissions: ops (requested)` / `permissions: ops (from grant fleet:skip)`.
If you want to know an agent's permissions, read that — do not guess from its
name or its cwd.

---

## Where this lives in the code

The spawn/permissions decision runs in the **daemon** (the process that launches
agents), so the code lives with the daemon, not the server:

- `bin/lib/spawn/permissions.mjs` — resolves the launch policy (the opt-in fence
  decision lives in `resolveLaunchPolicy`).
- `bin/lib/spawn/fence.mjs` — builds the actual fence/seatbelt invocation.
- `bin/lib/spawn/privilege-ledger.mjs` — the per-agent grant store the daemon
  reads at spawn time; seeded from `daemon.yaml` `grants:`/`profiles:`.
- `~/.config/tlda/daemon.yaml` — the operator-owned source of truth for regions,
  profiles, and grants.

*(Consolidation in progress: any permissions logic still sitting under `server/`
is being moved here so there is exactly one home. If you find two copies, the
daemon copy is authoritative.)*

---

## History (so nobody re-derives the wrong story)

- The fence used to be **forced on** even with a global "off" switch, because a
  stored per-agent grant carrying a privilege-set re-armed it at spawn time
  (`privilegeSet && fenceEnabled`). That's why the named profiles "never worked"
  and Skip could not opt out. Fixed 2026-07-06: `useFence` is now
  `requestedPolicy && explicitPolicy` — only an explicit ask fences.
- Do not reintroduce a default-deny fence. Fencing is **opt-in**, by Skip's
  explicit and repeated decision.
