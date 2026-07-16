# RC Process Guidance

This document records binding RC/process rules from the 2026-07-16
stabilization work. It is not a deploy runbook; `docs/live-deploy.md` remains
the live deploy procedure. These rules govern the RC worktree, heavy-process
coordination, process attribution, and rollout accounting.

## Source Pointers

- `chiefplz` message `1350992`: terminal permission proof accepted with
  caveats; RC serializer full-window rule; pre-rollout
  `permission_intersection` schema fact.
- `chiefplz` messages `1350705` and `1350663`: heavy-process rerun and process
  attribution corrections.
- `chiefplz` message `1350129`: process guidance should be tracked, not just
  held in chat.
- `chiefplz` message `1351137`: rollout-accounting gap accepted; rerun
  permission-profile backfill during rollout after pausing mints/lifecycle
  writes.
- Stabilizer message `1351127`: live reproduction of the post-backfill
  NULL-profile gap on `permissions-canon-reader`.
- Earlier heavy-process grants on 2026-07-16, including the 10:31 EDT
  grant/release protocol window around message `1346649`, establish the
  fleet-wide heavy-slot convention.

## RC Serializer

The RC serializer token covers every RC-worktree activity window: picks,
builds, browser/live proofs, migrations, and cleanup. It is not limited to
commits.

No overlapping RC-worktree activity window may begin until the current holder
releases the token. Queued picks or proof windows must wait, then verify the
RC HEAD before and after their activity.

This rule was adopted after two chief-ordered activities overlapped on
2026-07-16: serialized RC picks occurred during a live-proof window. The proof
remained valid only because the later picks were file-disjoint from the proof
paths; the overlap itself is now forbidden.

## Heavy-Process Lease

There is one fleet-wide heavy-process slot for build, browser, and rig work.
The lease must be explicitly granted before starting heavy work.

Release is terminal. Every rerun requires a fresh grant; an earlier grant does
not implicitly renew because the same lane needs another build, browser proof,
or rig cycle.

Rig requests must have an approved plan before the lease is granted. The plan
must identify what surface is being exercised, what evidence will prove the
result, and what cleanup/release will close the window.

The lease holder must report cleanup and release explicitly. Cleanup reports
must identify owned processes and artifacts rather than assuming they belong
to the lane.

## Process Attribution

Attributing a process requires command line, cwd, and parent-process evidence.
Do not attribute by port number, common service name, or filename-shaped
heuristic alone.

This rule follows the 2026-07-16 correction in which a process listening on
ports that looked like a Vite preview was actually the long-running `fable`
MCP server (`/Users/skip/work/tlda/mcp-server/index.mjs`) with a different
parent and cwd. Port-number heuristics were insufficient and nearly led to
the wrong process being treated as cleanup residue.

## Permission Rollout Accounting

The permission arc has pre-rollout live state that must be recorded in rollout
and rollback evidence.

First, the live daemon ledger on the Mini acquired the nullable
`permission_intersection` column on 2026-07-16 at approximately 15:08 EDT,
when the RC CLI opened the live ledger during the accepted lifecycle proof.
This was an expected forward schema migration, but it happened before rollout
and must be included in rollout and rollback accounting.

Second, the pre-rollout live system can still mint new rows after the
06:55 EDT permission-profile backfill. The live reproduction was
`permissions-canon-reader`: the seat was spawned around 13:55 EDT by the
still-live pre-RC path, had NULL `permission_profile`, refused wake through
the RC CLI with the migration-pointer message, and woke through the live CLI.

Therefore the permission rollout window must include this order:

1. Pause mints and lifecycle writes.
2. Re-run the idempotent permission-profile backfill migration, including the
   recipe-join disambiguation.
3. Verify zero NULL-profile rows for legitimate seats and zero unresolved
   legitimate seats.
4. Record the already-added nullable `permission_intersection` column and the
   second census/apply in rollout and rollback evidence.
5. Only then roll code and restart the relevant live processes.

Do not add a compatibility fallback for NULL-profile rows. The rollout must
repair state and then run the corrected code.
