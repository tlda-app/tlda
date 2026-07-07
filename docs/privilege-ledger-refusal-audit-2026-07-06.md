# Privilege-Ledger Refusal Audit, 2026-07-06

Scope: read-only P2 audit of requester ids that hit
`has no daemon privilege ledger entry`. No ledger rows were read from local
`~/.config/tlda/fleet.db`, no daemon-local privilege database was modified, and
no bypass or relaxation is proposed.

Evidence surfaces used:
- Fleet log search for the exact refusal string over the last seven days.
- Bounded fleet thread reads where available.
- Code inspection of the daemon gate and sanctioned seed paths:
  - `bin/lib/spawn/privilege-ledger.mjs:495` (`grantFor`)
  - `bin/fleet-daemon.mjs:3301` (spawn request calls `grantFor(requester)`)
  - `bin/lib/spawn/privilege-ledger.mjs:666` (`applyDaemonGrants`)
  - `bin/lib/spawn/privilege-ledger.mjs:689` (`applyGrandfatherInfill`)

Coverage limit: `search_logs` returned 100 matches for the exact string and
truncated the newest page. Many matches are self-referential activity logs or
agent summaries that quote earlier failures. This audit classifies the
requester ids/classes visible in the returned fleet records, not every repeated
copy of the same failure card.

## Mechanism Confirmed

The refusal checks the spawn requester, not the target:

1. `rpcSpawnSession` requires `requester.id`.
2. It calls `privilegeLedger.grantFor(requester)` before resolving a child grant.
3. `grantFor` throws `SPAWN_PRIVILEGE_NO_LEDGER_ENTRY` when the requester id has
   no row in `privilege_grants`.
4. Only after the requester grant resolves does the daemon preallocate/write the
   child grant. Failed launches delete preallocated child rows.

So the security interpretation is correct: an unknown requester cannot mint
child privileges. The fix is to seed legitimate requester identities through the
sanctioned paths, not to bypass `grantFor`.

Sanctioned seed paths:
- `daemon.yaml` `grants`, applied at daemon startup by `applyDaemonGrants`.
- `applyGrandfatherInfill`, applied on daemon welcome, for eligible existing
  non-human fleet agents from the authoritative fleet roster.
- normal successful spawn, which writes the launched/preallocated child grant.

`bin/backfill-identity-ledger.mjs` is not a fix for this failure class; it is the
MCP/session identity ledger, not daemon `privilege_grants`.

## Refused Requester Classification

| Requester | Evidence anchor | Context | Classification | Disposition |
| --- | --- | --- | --- | --- |
| `fleet:c5d9da7e` (`todd`) | Repeated `fleet:tlda -> todd` failure cards on 2026-07-04 22:32, 2026-07-05 02:09, 03:36, 06:01, 06:24, 08:37, 10:16, 20:02, and 2026-07-06 00:04. | Todd tried task recovery / wake flows for hibernated agents; failure card says requester `fleet:c5d9da7e` has no daemon privilege ledger entry. | Durable control/requester identity. | Seed through explicit `daemon.yaml` grant after owner approval. Do not rely on grandfather infill if Todd is a bot/control identity rather than an ordinary spawned worker. |
| `fleet:todd` (legacy Todd identity) | Todd thread shows older messages from `fleet:todd`, then later `fleet:c5d9da7e`. | Legacy control identity appears in same role lineage as current Todd. No exact refusal card for `fleet:todd` was in the reviewed exact-error snippets, but it matters for grant shape. | Durable control identity, legacy alias/lineage. | If Todd keeps both ids live, grant both explicitly or retire the legacy id deliberately. Do not let one ungranted alias break recovery. |
| `fleet:root` | Exact-error search shows `fleet:tlda -> root` cards on 2026-07-04 16:44 and 2026-07-05 02:07/05:04; `codoxetine` also reported live spawn smoke blocked because `fleet:root` had no daemon privilege ledger entry on 2026-07-03 19:01-19:03. | CLI/operator spawn smoke used root as requester. | Human/control or local-operator identity, depending on route. | Requires an explicit control/operator grant if this is a supported live spawn route. If root is only an accidental fallback identity, fix requester propagation instead of granting broad root power. |
| `fleet:skip` | Sandbox reports on 2026-07-04 14:59 and 17:43 say sandbox launch was refused because `fleet:skip` / synthetic caller lacked sandbox daemon privilege entries. | Sandbox daemon setup, not the live daemon. | Human/control identity in an isolated sandbox. | Expected unless sandbox config provisions the human/operator grant. Add sandbox-local `daemon.yaml` grant in test setup if real spawn is required; do not infer live grant state. |
| `fleet:fbc77a82` | `delegate-fix` 2026-07-05 10:56-10:57 and release-plane/session-arch follow-ups quote `spawn refused: fleet:fbc77a82 has no daemon privilege ledger entry`. | Real sandbox spawn+delegate e2e used a throwaway MCP identity as requester; durable task write was proven, but real child pickup was gated by requester privilege. | Ephemeral throwaway requester. | Refusal is correct by default. Test should provision a sandbox grant intentionally or assert the refusal as the expected security boundary. Do not seed live. |
| `fleet:no-entry-*` / `fleet:noentry` | `ledgerauth` live-deny and rehearsal commands on 2026-07-03 deliberately used unledgered requester ids such as `fleet:no-entry-live-*` / `fleet:noentry`. | Negative tests for the privilege ledger. | Deliberate throwaway denial identity. | Correct refusal; keep as test coverage. Never seed. |
| Synthetic sandbox callers (unnamed/generated) | Sandbox reports on 2026-07-04 13:17, 14:59, and 17:43 describe synthetic callers/owners lacking sandbox daemon privilege entries. | Sandbox proof harnesses, not live production recovery. | Ephemeral or sandbox-local control identities. | Provision explicitly in sandbox setup when the test is meant to prove successful spawn. Otherwise classify as expected denial. |

## Findings

1. The repeated live user-impacting refusal is Todd: `fleet:c5d9da7e` is the
   requester behind automated task recovery failures. That is a durable
   control/requester identity, so the likely fix is an explicit `daemon.yaml`
   grant, not a code bypass.

2. `fleet:root` is a separate control/operator-route problem. Granting it may be
   appropriate only if root is an intended live requester. If it is a fallback
   produced by missing requester propagation, the fix is to pass the real
   requester identity into the daemon.

3. Sandbox/throwaway ids are doing their job by failing closed. The fix for tests
   is test setup: seed sandbox grants deliberately when a successful real spawn
   is part of the proof. Do not global-seed throwaway ids.

4. The existing code already has the right security shape: unknown requester
   means no spawn. The release risk is operational seeding/infill coverage for
   legitimate requesters, not a missing permissive fallback.

5. `applyGrandfatherInfill` can cover ordinary existing non-human agents, but it
   is not the right default for humans/control identities. Todd/root/Skip-style
   identities should be explicit grants so their authority is visible and
   reviewed.

## Proposed Remediation, Still Read-Only

1. Add an ops/session-arch gate task to inspect the authoritative Fly-backed
   roster and daemon grant config for:
   - `fleet:c5d9da7e` (`todd`)
   - any still-live `fleet:todd` legacy Todd route
   - `fleet:root`
   - supported human/operator ids such as `fleet:skip`

2. For each durable control identity, decide:
   - intended to spawn/recover agents: add an explicit `daemon.yaml` grant with
     the least profile that supports that route;
   - accidental fallback: fix requester propagation and leave it ungranted.

3. For ordinary non-human agents that should have been covered by grandfather
   infill, investigate why `applyGrandfatherInfill` did not write a grant:
   missing from authoritative roster, `dead=1`, `human=1`, wrong config/env, or
   daemon not restarted/reloaded after the ledger code landed.

4. For sandbox tests, add local sandbox grants in the test harness when the
   acceptance proof requires successful spawn. Keep negative unledgered-requester
   tests.

5. Do not change `grantFor`, do not add a "default grant", and do not use the
   identity-ledger backfill script as a daemon-privilege repair.

## Verification Performed

- Read P2 plan requirements in `docs/release-corrected-plan-2026-07-06.md`.
- Read the privilege-ledger diagnosis section in
  `docs/agent-unresponsiveness-diagnosis.md`.
- Searched fleet logs for the exact refusal string over seven days.
- Read the daemon privilege gate and seed-path code.
- Wrote this audit without modifying daemon config, privilege stores, fleet
  state, or UI.
