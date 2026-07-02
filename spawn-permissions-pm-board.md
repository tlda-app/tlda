# Spawn/Permissions PM Board

Owner: chief:day
Date: 2026-07-01

## Operating Rule

Default app agents must stay able to work. Permission experiments happen through
explicit `spawn-direct --policy ...` or `spawn-direct --privileges ...` runs
until the profile has smoke evidence.

`privileges` are the permission interface. A privilege profile names concrete
allow/deny rules and must be proven by smoke. There is no target-model shorthand:
`capability` is deprecated surface to remove, not evidence and not a parallel
authority vocabulary.

No permission profile is real until the same launch path proves:

- expected allowed work succeeds,
- expected denied paths fail,
- the spawn trace records the grant, lease, wrapper, and Codex args,
- the fence denial log is inspected when something fails.

## Current Evidence

### Direct policy path bug

Status: fixed in working tree, verified by live direct smoke.

Observed failure:

- `spawn-direct --policy cwd --capability write` parsed `--policy` but did not
  use its value to build `spawnPolicy` / `privilegeSet`.
- Explicit policy runs were suppressed by `FENCE_TEMPORARILY_DISABLED`, so they
  did not reliably exercise a fence.
- The spawn library did not load the real tlda config by default, so
  `agentSandbox.policyOptions.cwd.git = "write"` was ignored.
- The generated fence settings used `git:"read"` and inserted `**/.git/**` into
  `denyWrite`.

Fixes in working tree:

- `cli/tlda.mjs`: direct spawn compiles `--policy` / `--privileges` into the
  actual requested spawn policy and privilege set.
- `bin/lib/spawn/permissions.mjs`: explicit policy or privilege-set runs force a
  lease even while default spawns remain break-glass unfenced.
- `bin/lib/spawn/index.mjs`: spawn policy resolution loads the real tlda config
  unless a test injects a config.
- `bin/lib/spawn/harness/codex.mjs`: `danger-full-access` emits
  `--dangerously-bypass-approvals-and-sandbox`.
- `bin/lib/spawn/index.mjs` and `bin/fleet-daemon.mjs`: spawn trace logs policy,
  grant, fence wrapping, and command args.

Verification:

- Repro direct smoke: explicit fenced cwd launch denied
  `.git/refs/heads/tlda-direct-fence-smoke.lock`; Playwright passed.
  Source anchor: `get_thread(agent: "fleet:d54e48b2",
  since: "2026-07-01T23:12:00Z")`, message at 2026-07-01 19:14:22
  from `direct-fence-smoke-1782947548` to `chief:day`.
- Fixed direct smoke: explicit fenced cwd launch with `git:"write"` succeeded:
  `.git/refs/heads/tlda-direct-fence-smoke2.lock` write/remove status 0,
  `tlda-dev pw acquire` status 0, `tlda-dev pw status` status 0.
  Source anchor: `get_thread(agent: "fleet:76368c79",
  since: "2026-07-01T23:16:00Z")`, task done at 2026-07-01 19:17:59
  for `direct-fence-smoke2-1782947775`; local pane capture of
  `fleet-direct-fence-smoke2-1782947775` showed the command statuses before
  task completion.
- Settings probe after fix: default Codex has no lease; explicit cwd has a
  lease; `git:"write"`; no `**/.git/**` deny remains, only
  `~/.git-credentials` remains denied as a secret.

## Profiles To Make Real

### app-dev

Current implementation status: named `--privileges app-dev` now compiles to an
explicit privilege set instead of using the old label as evidence. The launch
still projects as trusted/full for Codex classifier/Yolo behavior, but the fence
lease carries explicit cwd read/write rules and no broad `/` write grant.

Must allow:

- git refs/branches/worktrees in the app checkout,
- `tlda-dev pw acquire` and `tlda-dev pw status`,
- temp/runtime/cache writes used by Codex, node, Playwright, and tlda tooling,
- normal npm/node build/test commands for the checkout.

Must deny:

- private SSH keys,
- cloud credential files,
- `~/.config/tlda/fleet.db*`,
- `~/.git-credentials`,
- broad destructive paths outside the granted work surface.

Acceptance smoke:

```sh
tlda agent spawn-direct --fresh app-dev-smoke-$(date +%s) \
  --kind codex --model gpt --cwd /Users/skip/work/tlda \
  --privileges app-dev
```

Inside the spawned agent:

```sh
pwd
id -un
printf '0000000000000000000000000000000000000000\n' > .git/refs/heads/tlda-app-dev-smoke.lock
rm -f .git/refs/heads/tlda-app-dev-smoke.lock
git branch tlda-app-dev-smoke-branch
git branch -D tlda-app-dev-smoke-branch
./cli/tlda-dev.mjs pw acquire
./cli/tlda-dev.mjs pw status
test ! -r ~/.ssh/id_rsa
test ! -w ~/.config/tlda/fleet.db
```

### math-projects

Must allow:

- source edits in approved math project roots,
- build/temp files required by tlda paper workflows,
- tlda feedback/chat tools.

Must deny:

- app repo writes unless explicitly included,
- secrets/cloud credentials,
- fleet DB writes.

Acceptance smoke: pending exact project-root list from config and one selected
math project.

### full / ops

Must allow:

- machine maintenance and deployment tasks explicitly assigned to ops.

Must deny:

- nothing by fake fence; if it is truly ops/full, the safety boundary is role and
  audit, not pretending a narrow fence exists.

Acceptance smoke: pending, separate from app-dev.

### deploy

Must allow:

- the live deploy preflight command,
- the repo build command,
- Fly CLI auth/status/config reads for `fly.live.toml`,
- Fly CLI state/cache paths needed by the live deploy path,
- git read access required to report the deploy commit.

Must deny:

- arbitrary machine writes outside the deploy work envelope,
- private SSH keys,
- unrelated cloud credential files,
- `~/.config/tlda/fleet.db*`,
- `~/.git-credentials`.

Current implementation status: named `--privileges deploy` compiles to explicit
cwd read/write rules plus Fly state/cache paths. It does not grant broad `/`
write in the explicit fence settings. Actual `fly deploy -c fly.live.toml`
requires explicit deploy approval; permission smokes should use non-destructive
preflight/status/build checks first.

Verification:

- Direct deploy-profile launch: `deploy-profile-smoke-1782950282`
  (`fleet:318d159f`) launched through `spawn-direct --privileges deploy` with a
  fence wrapper, Codex bypass/Yolo args, `git:"write"`, explicit privilege set,
  and write roots limited to cwd plus Fly state/cache paths.
- Live preflight guard: `node scripts/live-deploy-preflight.mjs` correctly
  refused the dirty working tree. Source anchor:
  `get_thread(agent: "fleet:318d159f", since: "2026-07-01T23:59:00Z")`,
  message at 2026-07-01 19:59:36.
- Fenced continuation passed without live deploy: `npm run build`,
  `fly auth whoami`, `fly status -c fly.live.toml`,
  `test ! -r ~/.ssh/id_rsa`, and
  `test ! -w ~/.config/tlda/fleet.db`. Source anchor:
  `get_thread(agent: "fleet:318d159f", since: "2026-07-02T00:00:00Z")`,
  message at 2026-07-01 20:02:08 from `deploy-profile-smoke-1782950282`.

Acceptance smoke:

```sh
tlda agent spawn-direct --fresh deploy-smoke-$(date +%s) \
  --kind codex --model gpt --cwd /Users/skip/work/tlda \
  --privileges deploy
```

Inside the spawned agent:

```sh
pwd
git rev-parse --short HEAD
node scripts/live-deploy-preflight.mjs
npm run build
fly auth whoami
fly status -c fly.live.toml
test ! -r ~/.ssh/id_rsa
test ! -w ~/.config/tlda/fleet.db
```

Non-destructive Fly build-only can be added after the cheap smoke passes:

```sh
fly deploy -c fly.live.toml --remote-only --build-only
```

## Routed Spawn Parity

Direct spawn is the local primitive. Routed spawn is acceptable only when it
produces the same launch plan for the same request:

- same requested privilege profile,
- same granted privilege profile,
- same lease/no-lease decision,
- same `git` setting,
- same Codex yolo flag,
- same app-dev smoke result.

Do not deploy routed permission changes until the direct smoke passes first.

Current routed status:

- `./cli/tlda.mjs agent spawn --fresh routed-deploy-profile-smoke-$(date +%s)
  --kind codex --model gpt-5.5 --cwd /Users/skip/work/tlda
  --privileges deploy` failed before launch with
  `spawn policy resolution failed: unknown spawn capability "deploy"`.
- Diagnosis: direct spawn uses the current checkout, but routed spawn resolves
  privileges in the already-running mini daemon. The daemon log shows a live
  heartbeat for PID `99974`, while `tlda daemon status` reports no pidfile; this
  session cannot signal PID `99974` (`operation not permitted`). A full-capability
  daemon-restart worker `fleet:62b67243` owns restarting/reloading that daemon
  and rerunning the routed parity smoke.
- After Skip restarted the daemon, routed deploy-profile spawn succeeded:
  `routed-deploy-profile-smoke-1782952667` (`fleet:4c641ba2`) launched with
  `capability=write/cwd`.
- Routed deploy-profile smoke passed without live deploy: `pwd`,
  `git rev-parse --short HEAD`, `npm run build`, `fly auth whoami`,
  `fly status -c fly.live.toml`, `test ! -r ~/.ssh/id_rsa`, and
  `test ! -w ~/.config/tlda/fleet.db`. Source anchor:
  `get_thread(agent: "fleet:4c641ba2", since: "2026-07-02T00:37:00Z")`,
  message from `routed-deploy-profile-smoke-1782952667` reporting pass results.

## Current Gaps

- Tests in `test/spawn-node-lib-step3.test.mjs` are stale relative to the
  break-glass/default-unfenced state and need a focused cleanup pass.
- The direct-spawn smoke is proven; routed-daemon parity still needs a fresh
  proof after the code lands in the daemon process.
- The app-dev profile name must become the standard spelling. Existing
  `--policy cwd --capability write` usage is deprecated compatibility syntax to
  remove.
