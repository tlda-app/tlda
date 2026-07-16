# Old-Agent Permission State Audit

Date: 2026-07-16
Owner: perm-migration-doer
Scope: read-only audit plus proposed migration. No live state changed.

## Current Valid Profiles

Current daemon profiles are from `~/.config/tlda/daemon.yaml` and `tlda agent --help`:

- `wd`
- `math`
- `app-dev`
- `ops`

The active local permission ledger is `~/.config/tlda/fleet-daemon.db`.
`~/.config/tlda/permission-ledger.db` and `~/.config/tlda/daemon-permissions.sqlite` are zero-byte stale files on this machine.

## Root Cause

The skipped migration was from old policy/scope names (`cwd`, `unsandboxed`, `write`, `read`, `full`, `none`, `break-glass`) to daemon profile names (`wd`, `math`, `app-dev`, `ops`): wake now reuses `local_agent_process_recipes.permission_profile` as `--permissions <profile>`, but old rows stored `spawn_policy.name`, so hibernating seats can wake with an unknown profile.

## Code Paths

Current wake path:

- `cli/tlda.mjs`: when waking without explicit `--permissions`, reads `stored.process.permissionProfile`; if set, passes it as `requestedPermissions`; then validates it against `daemonConfig.profiles`.
- `agent-launch/local-agent-ledger.mjs`: durable local wake recipe stores `permission_profile`.
- `agent-launch/permission-ledger.mjs`: active durable grants are in `fleet-daemon.db.permission_grants`.

Code still capable of emitting old names or profile requests:

- `cli/tlda.mjs`: CLI spawn/wake reads `--permissions` into `permissionArg`, reuses stored `process.permissionProfile` on wake, validates that name against `daemon.yaml`, and passes it as both `permissionProfile` and `requestedPermissions`.
- `server/routes/fleet.mjs`, `server/unified-server.mjs`, and `mcp-server/fleet-tools.mjs`: fleet HTTP, WS, and delegate-spawn paths pass profile requests as `requestedPermission` / `requestedPermissions`; they do not pass `permissionProfile`.
- `agent-launch/agent-launch.mjs`: the daemon launcher resolves requested permissions to an exact configured permission class and forwards it to node spawn as `permissionClass`, not `permissionProfile`.
- `agent-launch/index.mjs`: fresh spawn previously persisted `permissionProfile: params.permissionProfile || params.requestedPermission || (params.breakGlass ? 'break-glass' : null)`. When no explicit profile was supplied, `params.requestedPermission` could be a derived policy/scope name rather than a daemon profile.
- `agent-launch/local-agent-ledger.mjs`: legacy backfill imported `JSON.parse(row.spawn_policy)?.name` into `permission_profile`, preserving old names from legacy `permission_grants`.

Prepared code diffs on this branch, not merged:

- In `agent-launch/index.mjs`, local recipe storage now persists the first configured profile name found in `params.permissionProfile`, `params.permissionClass`, or `params.requestedPermission`; it does not persist unconfigured legacy names like `break-glass`, `cwd`, or `unsandboxed`.
- In `agent-launch/local-agent-ledger.mjs`, legacy backfill now maps old `spawn_policy.name` values through the migration map before writing `permission_profile`.
- Unknown profile names in legacy backfill deliberately pass through unchanged. The migration only rewrites known old names and current profile names; an unknown value should remain visible and fail loudly at wake validation rather than being silently guessed into a grant.

## Ledger Classification

`local_agent_process_recipes` has 1,395 rows:

| class | profile | rows |
|---|---:|---:|
| valid current | app-dev | 32 |
| valid current | math | 8 |
| valid current | wd | 7 |
| valid current | ops | 5 |
| obsolete | unsandboxed | 1,103 |
| obsolete | cwd | 147 |
| obsolete | write | 42 |
| obsolete | none | 40 |
| obsolete | full | 5 |
| obsolete | read | 4 |
| obsolete | break-glass | 2 |

`permission_grants` has 1,392 rows. Grant `spawn_policy.name` still contains old region names by design in many rows; the wake breakage is specifically the local durable recipe profile column.

## Current Roster Wake Risk

Roster source: `GET https://tlda-fly.cormorant-matrix.ts.net/api/fleet-roster-truth?limit=500`, called from the active `getFleetServerUrl()` config. This is the Fly-backed server roster, not local `fleet.db`. The response returned `shown=118`, `matched=118`, totals `16 awake / 102 hibernating / 0 dead / 118 total` on the refresh after the first report. The earlier audit run saw the same total with `15 awake / 103 hibernating`; one seat changed state while the audit was in progress.

Reconciliation note: a smaller `limit=48` call is page-limited and returns a `nextCursor`; it is not a full-roster count. The local `~/.config/tlda/fleet.db` is not usable here (`fleet.db` itself is absent; only old shm/wal sidecars remain), so the Fly roster is ground truth.

Hibernating seats that would wake broken today:

- 47 with local profile `unsandboxed`
- 5 with local profile `cwd`
- 2 with local profile `break-glass`
- 3 with no local ledger row/current durable seat

The 91 other obsolete local recipe rows are not on current awake/hibernating roster seats:

- `write`: 42 historical rows, no current roster row
- `none`: 40 historical rows, no current roster row
- `full`: 5 historical rows, no current roster row
- `read`: 4 historical rows, no current roster row

Under the proposed `--apply`, the script maps these rows explicitly:

- `write` -> `wd`
- `read` -> `wd`
- `none` -> `wd`
- `full` -> `ops`

Risk rows:

| id | name | old | proposed | reason |
|---|---|---:|---:|---|
| fleet:3220febb | abstract-writer | cwd | wd | cwd-scope rename |
| fleet:e16b7157 | activity-delivery-owner | unsandboxed | app-dev | app/tlda work |
| fleet:0813dd6e | app-librarian | unsandboxed | app-dev | app/tlda work |
| fleet:e4147be6 | app-recovery | unsandboxed | app-dev | app/tlda work |
| fleet:dd94552f | cheap-recovery-docs-phone | unsandboxed | app-dev | app/tlda work |
| fleet:4caff211 | cheap-recovery-ui | unsandboxed | app-dev | app/tlda work |
| fleet:a58b3254 | chief | unsandboxed | ops | chief/staff recovery seat |
| fleet:fcb1df26 | cmu-workshop | unsandboxed | app-dev | tlda cwd |
| fleet:f2ca20b5 | commit-auditor | unsandboxed | app-dev | tlda cwd |
| fleet:740ef772 | fable | cwd | wd | cwd-scope rename |
| fleet:0feae685 | fresh-partner | unsandboxed | app-dev | general work cwd |
| fleet:66660cc3 | icantevengetafuckinglist | unsandboxed | app-dev | tlda recovery work |
| fleet:5314cf72 | improvements-owner | unsandboxed | app-dev | general work cwd |
| fleet:2981c43d | inbox-lock-owner | unsandboxed | app-dev | app/tlda work |
| fleet:6310ef6b | inv-3b | unsandboxed | app-dev | app/tlda work |
| fleet:415a48fc | inv-4c | unsandboxed | app-dev | app/tlda work |
| fleet:f9cb1d72 | launchd-recovery | unsandboxed | ops | launchd/infra recovery |
| fleet:9c06d1ba | liveness | unsandboxed | app-dev | tlda recovery work |
| fleet:e13bfec6 | mend | unsandboxed | app-dev | tlda cwd |
| fleet:6837ba70 | mini-repair-owner | unsandboxed | ops | machine repair |
| fleet:9b83459d | mint-local-1784083134 | unsandboxed | app-dev | tlda cwd |
| fleet:5459098d | mint-seat-1784083701 | unsandboxed | app-dev | tlda recovery cwd |
| fleet:d555ddc5 | mint-seat-1784083915 | unsandboxed | app-dev | tlda cwd |
| fleet:10ec0810 | mint-verify3-1784081825 | unsandboxed | app-dev | tlda cwd |
| fleet:96f0c30e | mint-verify4-1784082881 | unsandboxed | app-dev | tlda cwd |
| fleet:a6f747bb | mint-verify5-1784083096 | unsandboxed | app-dev | tlda cwd |
| fleet:e9fb87b7 | mint-verify7-1784083695 | unsandboxed | app-dev | tlda cwd |
| fleet:a11c5040 | mittenzzzzzzy | unsandboxed | app-dev | tlda cwd |
| fleet:4c52d400 | mlzz | cwd | wd | cwd-scope rename |
| fleet:48267ff8 | ops-disconnect-emergency | unsandboxed | ops | ops/daemon recovery |
| fleet:02e72b7e | ops-fix | unsandboxed | ops | ops seat |
| fleet:48631ada | recovery-activity-reviewer | unsandboxed | app-dev | tlda recovery work |
| fleet:2d20ff53 | recovery-chief-sol | unsandboxed | ops | chief/recovery seat |
| fleet:2ae0aa3a | recovery-continuity-watch | unsandboxed | app-dev | tlda recovery work |
| fleet:2f9b2ca5 | recovery-identity-seat-owner | unsandboxed | app-dev | tlda recovery work |
| fleet:recovery-mint-v2 | recovery-mint-v2 | missing | blocked | no local ledger row; no current durable seat |
| fleet:recovery-mint-v3 | recovery-mint-v3 | missing | blocked | no local ledger row; no current durable seat |
| fleet:recovery-mint-verify | recovery-mint-verify | missing | blocked | no local ledger row; no current durable seat |
| fleet:5710ee65 | recovery-ops-launchd | unsandboxed | ops | launchd/infra recovery |
| fleet:0b275f8c | recovery-readiness-state-owner | unsandboxed | app-dev | tlda recovery work |
| fleet:12c649ba | recovery-wake-owner | unsandboxed | app-dev | tlda recovery work |
| fleet:e69f02b7 | skip-sol-anchor-0714 | unsandboxed | app-dev | general work cwd |
| fleet:7289e532 | sol-breakglass-final-proof | break-glass | ops | break-glass proof |
| fleet:eab729d5 | sol-breakglass-live-proof | break-glass | ops | break-glass proof |
| fleet:723e87fd | sol-breakglass-proof-2230 | unsandboxed | app-dev | general work cwd |
| fleet:f2482c64 | sol-local-permission-proof | unsandboxed | app-dev | permission proof |
| fleet:6854e79d | sol-local-permission-proof-2 | unsandboxed | app-dev | permission proof |
| fleet:556059a2 | sol-mcp-proof | unsandboxed | app-dev | tlda cwd |
| fleet:ac8068bf | stripper | cwd | wd | cwd-scope rename |
| fleet:150c2fe4 | synth-belief-fable-2 | cwd | wd | cwd-scope rename |
| fleet:94ee0a97 | todos-hopefully | unsandboxed | app-dev | tlda cwd |
| fleet:162234e4 | todos-lead | unsandboxed | app-dev | tlda cwd |
| fleet:5be6acc4 | v476-cli-proof | unsandboxed | app-dev | tlda cwd |
| fleet:8bde9d3b | wake-ledger-reliability-owner | unsandboxed | app-dev | tlda cwd |
| fleet:ac1dd9c0 | week-from-hell-was-hell | unsandboxed | app-dev | non-ops work |
| fleet:yolo | yolo | unsandboxed | ops | explicit yolo/break-glass seat |
| fleet:b680e579 | yuck | unsandboxed | app-dev | tlda cwd |

## Proposed Migration

Do not execute without stabilizer approval.

Backup:

```sh
ts=$(date +%Y%m%d-%H%M%S)
cp ~/.config/tlda/fleet-daemon.db ~/.config/tlda/fleet-daemon.db.bak-perm-profile-$ts
cp ~/.config/tlda/fleet-daemon.db-wal ~/.config/tlda/fleet-daemon.db-wal.bak-perm-profile-$ts 2>/dev/null || true
cp ~/.config/tlda/fleet-daemon.db-shm ~/.config/tlda/fleet-daemon.db-shm.bak-perm-profile-$ts 2>/dev/null || true
```

Run the dry-run script:

```sh
node .worktrees/perm-migration/scripts/migrate-permission-profiles.mjs
```

Apply only after approval:

```sh
node .worktrees/perm-migration/scripts/migrate-permission-profiles.mjs --apply
```

Verification:

```sh
sqlite3 ~/.config/tlda/fleet-daemon.db "
  SELECT permission_profile, COUNT(*)
  FROM local_agent_process_recipes
  GROUP BY permission_profile
  ORDER BY COUNT(*) DESC;"

tlda agent wake abstract-writer
tlda agent check-ready abstract-writer --timeout 30
tlda agent hibernate abstract-writer
```

Sample a second unsandboxed-to-app-dev row and one ops row after approval:

```sh
tlda agent wake app-tester
tlda agent check-ready app-tester --timeout 30
tlda agent hibernate app-tester

tlda agent wake ops-fix
tlda agent check-ready ops-fix --timeout 30
tlda agent hibernate ops-fix
```

Approval note: this verification briefly changes the live roster Skip sees, because it wakes and then hibernates real seats (`abstract-writer`, `app-tester`, `ops-fix`). That should be included explicitly in the approval request.

Revert plan:

```sh
tlda agent hibernate abstract-writer || true
tlda agent hibernate app-tester || true
tlda agent hibernate ops-fix || true
cp ~/.config/tlda/fleet-daemon.db.bak-perm-profile-$ts ~/.config/tlda/fleet-daemon.db
```

The three missing durable-seat rows need separate state recovery or archival; the migration script reports them and does not invent rows.
