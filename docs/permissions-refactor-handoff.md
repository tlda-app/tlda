# Permissions refactor — handoff, 2026-07-06

Skip spent a brutal afternoon on the spawn/fence/permissions subsystem. This is
the concrete state so the next driver does NOT restart from zero or re-derive
what's already true.

## READ FIRST — trust level of this doc

Written by `abel`, who is **fenced to a broken cwd-cage** and therefore could NOT:
spawn any agent (fenced `fork` fails), create git worktrees directly, restart the
daemon, or run a real end-to-end spawn. So:

- **VERIFIED** (I ran it and saw the result): the branch commits, `node --check`,
  the full test suite + baseline diff, the ledger DB roundtrip, the CLI help
  output. Trust these.
- **NOT VERIFIED** (I could not run it): a real agent actually launching on the
  branch code; the merge; the daemon reload; that a spawned agent comes up
  unfenced end-to-end. **The next agent must do these and confirm them.**
- **DIAGNOSED but not fixed by me**: the fleet spawn is currently broken machine-
  wide (see "Spawn is broken right now" below). I could not touch it.

Do not treat my unverified claims as done. Where I say "should," I mean I believe
it from reading code, not from watching it run.

## Spawn is broken right now (machine-level, NOT the code)

New fleet spawns/wakes fail. Two modes seen in Skip's terminal:
- `tmux new-session … fork failed: Device not configured` → the mini can't fork.
- `Created/Woke` prints but the agent stays hibernating/dead (never registers).

Diagnostics Skip ran on the mini: `ps axu | wc -l` = **692**;
`kern.num_taskthreads` = 4096; **`kern.tty.ptmx_max` = 511**; `tmux ls` = **6**.
Only 6 tmux sessions but the pty ceiling is 511 — strong sign **ptys are leaked/
exhausted**, so new pty allocation fails. Band-aid to restore spawns:
`sudo sysctl -w kern.tty.ptmx_max=2048` then retry. Real fix: find what leaks
ptys. **This is infra/ops, and it blocks bringing up ANY fleet agent** — but a
plain non-fleet `claude` session in `~/work/tlda` bypasses it entirely and can do
all the remaining work (edit, test, git-merge, daemon reload).

Everything below is verified unless marked otherwise.

## The model Skip wants (his words, this session)
- **Fencing is opt-in.** No fence unless a spawn explicitly asks. (LIVE — done.)
- **One word: `permissions`.** `capability` and `privilege` are dead. (Done on branch.)
- **Named profiles are the ENTIRE model. NO LEVELS.** The read/write/tlda-write/full
  rung ladder "was not supposed to exist" — kill it. Profiles only
  (`readonly/wd/math/app/ops`). ← **the main remaining task.**
- Help/descriptions derive from `daemon.yaml` so nothing drifts. (Done on branch.)
- It must be transparent (spawn says what permissions it gave). (Partly done.)

See `docs/permissions.md` for the authoritative model (regions/profiles/opt-in).

## What is LIVE on main right now
- `1b9b9ebd` — **opt-in fence**: `useFence = requestedPolicy && explicitPolicy`.
  The stored ledger grant can no longer force-cage an agent. Verified on a real
  unfenced agent (`outside`).
- `0d1de46d` — `docs/permissions.md` authoritative doc.

## What is on branch `perms-clean` (verified, NOT yet merged)
Worktree: `/Users/skip/work/tlda/.worktrees/perms-clean`. Commits on top of main:
- `890e62d7` — `tlda agent create/wake` prints its permissions decision.
- `f8bd5dad` — CLI profile help derived from `daemon.yaml`; profiles accept an
  inert `description:` field (allowed + preserved in `normalizeDaemonProfile`).
- `8e7b8122` — **`availability` rename**: the harness/model probe (`probeSpawn*`,
  `spawn-capability-models`, `/api/fleet/spawn-availability`) — the OTHER meaning
  of "capability" — is now `availability`. Do NOT touch these back.
- `f774d880` — **`permissions` rename**: `capability`/`privilege` → `permissions`
  everywhere in the permission meaning. Files renamed (`permission-ledger.mjs`),
  SQLite schema (`permission_grants`/`permission_set`), constants
  (`PERMISSION_LEVELS`, `PERMISSION_OPERATIONS`), client+server fields.

### Verification done on the branch
- Full test suite diffed against a HEAD baseline: **zero new failures** from the
  rename (normalized failure sets match byte-for-byte). The one changed test
  asserts the new `read, write, and description` profile-field error message.
- Fresh `permission-ledger` DB opens clean on the renamed schema; sync + worker
  write/read roundtrip pass.
- CLI runs; `tlda agent permissions` help lists the real `daemon.yaml` profiles.
- Correctly PRESERVED (different meanings, not renamed): `availability`, the
  MCP-protocol `capabilities` handshake field, WM viewport `capabilities`, and
  legacy string parsing (`workspace-write`/`full-access`/`read-only`).

### NOT yet done / gate not passed
- **Real spawn gate**: intended to spawn a throwaway agent on the branch code and
  confirm it comes up unfenced with the transparency line, BEFORE merge. BLOCKED:
  `outside` (the unfenced hand) hibernated mid-task and is unresponsive. Needs an
  unfenced launcher to run:
  `node .worktrees/perms-clean/cli/tlda.mjs agent create <throwaway> --cwd /tmp`
- **Pre-existing red tests**: ~13 spawn tests fail on BOTH main and the branch —
  they assert the OLD default-fence behavior that opt-in no longer arms. These
  are fallout from the opt-in fence decision, not the rename. They should be
  updated to match opt-in (a spawn only fences when it asks).

## Remaining work (the plan, per item)
1. **Eliminate levels** (Skip's live directive). Remove, in `perms-clean`:
   - CLI: the `tlda agent permission <agent> <level>` command (dispatch at
     `cli/tlda.mjs` ~2992, `cmdAgentPermission` ~2820, `usageAgentPermission`
     ~2349, `permissionLevelNamesForError` ~2440, the `--permission` level flag,
     the `permission` entry in the subcommand list ~1788, and usage strings that
     mention `read|write|tlda-write|full`). Keep `tlda agent permissions <profile>`
     and `--permissions <profile>` — those are the profile surface.
   - **Excise `--policy`** (and never introduce `--fence`). Skip: "in what world is
     anything named policy?" The spawn flag is `--permissions <profile>`, one word.
     Wire it so naming a profile via `--permissions` IS the explicit fence request
     (i.e. `--permissions <profile>` sets what `explicitPolicy`/`--policy` used to).
     No profile = unfenced. Commands: unfenced `tlda agent create NAME --cwd …`;
     profiled `tlda agent create NAME --permissions ops`.
   - Internal `server/lib/spawn-policy.mjs`: the rung ladder (`PERMISSION_LEVELS`,
     `meetSpawnPolicies`/clamp, level-based model ceilings) is the redundant
     authorization axis. Replace level-based authorization with
     profile-only resolution. This is the load-bearing part — do it with the
     spawn tests + a real spawn, not blind. If model ceilings must stay, express
     them as profiles, not levels.
2. **Merge** `perms-clean` → main (fast-forward; branch is linear on main tip).
3. **Reload the daemon** so the new code is live. It's launchd-managed
   (`com.tlda.fleet-daemon.plist`) — `launchctl kickstart -k` relaunches it from
   the committed checkout with a clean env (the safe path; Skip restarted it
   fine earlier). Then confirm one real MCP/fleet spawn works. Rollback is ~30s.
4. **Add `description:` to `daemon.yaml`** (ONLY after the description-allowing
   code is live, or the current daemon throws on the unknown key). Ready-to-paste
   (add a `description:` line under each profile; Skip may reword):
   ```yaml
   readonly:
     description: read-only — reads its working dir, writes nothing
   wd:
     description: working-directory cage — reads/writes only its cwd (+ temp, agent state)
   math:
     description: math work — reads/writes ~/work, never the tlda app
   app:
     description: app dev — reads/writes cwd plus browser & dev caches
   ops:
     description: the whole machine minus secrets — the most open profile
   ```
5. **Spawn command → per-agent files in a temp folder.** Skip's design, verbatim:
   the launch command is an unreadable wall of inline env vars (`FLEET_ID=…
   GIT_AUTHOR_NAME=… NODE_EXTRA_CA_CERTS=… TLDA_SERVER=…` — assembled in
   `bin/lib/spawn/*`). Write them to files **scoped to the agent id**, in a temp
   folder (a `~/tmp`-style dir), named:
   - **`<agentId>-environment`** — that agent's spawn environment; the launch
     command **sources this file** instead of inlining the vars.
   - **`<agentId>-permissions`** — that agent's resolved permissions (this is
     effectively the fence lease, which today is written as
     `TLDA_SANDBOX_LEASE_FILE=…/claude-cwd-lease-<hash>.json` — rename/relocate it
     to the `<agentId>-permissions` convention).
   Naming both by agent id **so you can debug**: to see what any agent actually got,
   read its two files. Result: short readable launch command + inspectable per-agent
   state. (Ties into the transparency goal — same principle, on disk.)
6. **Consolidate into one home, files where the code runs.** Skip: spawn/permission
   code runs in the DAEMON, so it belongs in the daemon folder — not `server/`.
   Move `server/lib/spawn-policy.mjs` (the shared brain, imported by daemon+cli+
   server) into `bin/lib/spawn/`; update all importers. Goal: one implementation,
   no "is it the server or the daemon?" confusion. (There were ~three overlapping
   implementations historically — the graveyard of `perm-*`/`ledgerauth-*`/
   `perms-model-xserver` branches. Do NOT resurrect those; this branch is the
   clean line.)
7. **Reliability is the priority Skip named: "agents must be wakeable into a state
   in which they can act."** Right now they are NOT (pty exhaustion + roster lies —
   see top). "Make it never happen again." This is bigger than the permissions
   rename and is infra/ops-lane, but it's the thing that actually blocks Skip. The
   pty leak on the mini and the fence-that-traps-agents are both instances. Owner:
   ops/reliability, not the permissions cleanup.

## Skip's directives this session, condensed (so he never repeats them)
1. Fencing OPT-IN, never default. (done, live)
2. ONE word `permissions`; excise `capability`/`privilege` from the whole codebase,
   not just user-facing. (done on branch)
3. Profiles are the ENTIRE model. **NO LEVELS** — the read/write/full ladder was
   never supposed to exist. Kill it. (task #1)
4. Named, working-directory-based profiles (`readonly/wd/math/app/ops`) with the
   `ops` grant for `fleet:skip`. (exists in daemon.yaml)
5. Help + descriptions derive from `daemon.yaml`; inert `description:` per profile.
   (done on branch)
6. Every spawn is transparent about what permissions it got. (partly done)
7. Documented so agents stop fabricating (`docs/permissions.md`). (done)
8. `fleet-env` file instead of the inline env wall. (task #5)
9. One implementation, files where the code runs (daemon). (task #6)
10. Merge when done. Deploy freely; rollback is ~30s.
11. Reliability: agents must be spawnable/wakeable into a working state, and it must
    stay that way. (task #7 — the real blocker)

## Hazards / judgment calls already resolved
- `capability` has THREE meanings; only the permission one was renamed. The other
  two (availability probe, MCP-protocol) were reverted after being caught. Don't
  re-rename them.
- The daemon reads working-tree files directly — do NOT edit spawn code in the
  SHARED checkout mid-flight; work in the worktree, merge atomically.
- Fleet is unreliable right now (agents hibernating unresponsive — `outside`,
  and Skip reports he "can't wake `releast`"). Verify any helper actually
  responds before relying on it (a sent message is not a taken job).
