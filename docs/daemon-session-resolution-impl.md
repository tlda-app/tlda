# Daemon-owned Codex session resolution implementation spec

Status: implementation spec for gate review. The architecture is approved; this
file makes the build concrete before code changes.

## Objective

Codex respawn must resolve an agent to the bare Codex rollout UUID on the
machine that owns that agent's session files. The server must only route a
respawn request to the right daemon. The daemon, through one JSONL-reader
process, owns the authoritative agent-to-rollout-UUID index and the bounded
catch-up step.

The direct/break-glass path must not implement a second resolver. It runs the
same JSONL-reader process standalone. Same binary, two parents.

Fresh starts do not use this resolver. `fresh` launches immediately. Resolution
is only for resume/respawn.

## Files touched

- `bin/fleet-jsonl-ingester.mjs`
  - Promote the existing ingester child into the standalone JSONL-reader process
    used by both the daemon and direct path.
  - Add an explicit one-shot command/API for cold/direct reads and a drain/advance
    command for daemon cursor catch-up.
  - Acquire the single-reader lock before reading/updating the local identity
    index or cursor/index files.
- `bin/fleet-daemon.mjs`
  - Keep the daemon as parent/orchestrator of the JSONL-reader child.
  - Add daemon-local `resolveCodexResumeHandle(agent, opts)` using the reader
    index, not filesystem fallback scanning.
  - Wire Codex respawn through the daemon-owned resolver.
- `bin/lib/session-identity-store.mjs`
  - Extend persisted records if needed so Codex records can store the canonical
    bare rollout UUID plus path, owner, cwd, and updated timestamp.
  - Preserve the existing `by_fleet_id` index as the durable lookup surface.
- `bin/lib/spawn/index.mjs`
  - Replace Codex respawn's `findCodexRollout()` cascade with injected/shared
    `resolveCodexResumeHandle`.
  - Remove Codex `sessionOverride` from respawn.
  - Keep explicit `--session <uuid>` enrollment path separate from respawn.
- `bin/lib/spawn/resume.mjs`
  - Delete or split out the old Codex respawn cascade:
    caller override -> identity store -> agent row ids -> filesystem scan.
  - Keep Claude session helpers and reusable Codex parsing helpers only.
- `cli/tlda.mjs`
  - For `tlda agent spawn-direct`, use the same JSONL-reader process standalone
    for resume/respawn.
  - Do not invoke the reader for explicit `--fresh`.
- Tests:
  - Update `test/spawn-node-lib-step3.test.mjs` or split a focused
    `test/codex-resume-resolution.test.mjs`.
  - Add daemon-reader tests for cursor advance, direct cold read, typed misses,
    and malformed rollout-basename rejection.

## Current code shape to reuse

The daemon already has the correct broad shape: the JSONL reader is a child
process.

- Parent daemon state in `bin/fleet-daemon.mjs`:
  - `sessionIdentityStore` loaded from `SESSION_IDENTITY_FILE`.
  - `recordSessionIdentity()` writes identity records via
    `upsertSessionIdentity()`.
  - `agentPaths: Map<agentId, jsonlPath>` maps live agents to watched JSONLs.
  - `pathWatchers: Map<jsonlPath, watcherState>` and
    `childWatchers: Map<watchId, watcherState>` track active reader watches.
  - `cursors` persists per-session inode/offset in `daemon-cursors.json`.
  - `syncSessionWatchers(agents)` attaches live JSONL tails.
  - `resolveCodexJsonl(agent)` finds the live Codex rollout path from the
    runtime process and `resolveTranscript()`.
- Reader child in `bin/fleet-jsonl-ingester.mjs`:
  - It owns TailFile/read IO and parsing.
  - It sends `identity` outputs; the parent records them with
    `recordSessionIdentity()`.
  - It sends `flush` with `offset`; the parent updates `cursors`.
  - It already pauses/resumes tails around parent acks.

Implementation should preserve this parent/child division. The parent owns
daemon state and persistence; the reader owns JSONL IO and extraction.

## `resolveCodexResumeHandle` interface

Daemon-side call:

```js
const result = await resolveCodexResumeHandle(agent, {
  mode: 'daemon',
  advanceOnceOnMiss: true,
  retryAfterMs: 1000,
})
```

Direct/break-glass call:

```js
const result = await resolveCodexResumeHandle(agent, {
  mode: 'direct',
  readerCommand: 'cold-read',
  retryAfterMs: 1000,
})
```

Success:

```js
{
  ok: true,
  kind: 'codex',
  fleetId: 'fleet:...',
  resumeId: '<bare-rollout-uuid>',
  jsonlPath: '/Users/.../.codex/sessions/YYYY/MM/DD/rollout-...-<uuid>.jsonl',
  cwd: '/launch/cwd',
  source: 'identity-store' | 'live-reader' | 'direct-cold-read'
}
```

Typed miss:

```js
{
  ok: false,
  code: 'identity-ingestion-pending' | 'missing-resume-handle',
  fleetId: 'fleet:...',
  retry_after_ms: 1000,
  detail: {
    advanced_once: true | false,
    active_tail: true | false,
    reason: 'no-record' | 'no-live-tail' | 'conflicting-owner' | 'invalid-uuid'
  }
}
```

The resolver returns a bare UUID in `resumeId`. It never returns or accepts a
full rollout basename as a resume handle.

## Authoritative index

Canonical key:

- `fleet_id`

Canonical value:

- bare Codex rollout UUID
- JSONL path
- cwd from `session_meta`
- harness kind `codex`
- updated timestamp

Persistent store:

- `sessionIdentityStore.sessions[uuid]` remains the record table.
- `sessionIdentityStore.by_fleet_id[fleet_id]` remains the fleet lookup index.
- A Codex record's `session_id` is the bare rollout UUID.
- The path is the full rollout JSONL path.

Update sources:

- Continuous daemon reader:
  - Existing watch messages parse Codex records through `parseCodexRecord()`.
  - Existing `extractIdentityFromRecord()` outputs `fleet_id` when registration
    or fleet env evidence appears.
  - Parent `recordSessionIdentity()` persists `{ session_id: uuid,
    harness_kind: 'codex', jsonl_path, fleet_id, cwd, classified: false }`.
- Fresh Codex spawn:
  - After the new process registers, the daemon reader should observe the same
    rollout through the live tail and store the UUID.
  - Fresh launch may still return a resume handle after observed registration,
    but fresh launch itself must not depend on pre-resolution.
- Direct cold read:
  - The same reader process runs standalone over local Codex rollouts and emits
    the same identity records/result shape.
  - This is for direct resume/respawn only, not fresh.

## Single-reader protection

There must never be two JSONL-reader processes advancing the same local rollout
files/index at the same time.

Lock:

- Use an advisory lock in the tlda config directory, for example
  `~/.config/tlda/session-reader.lock`.
- The daemon-held reader child acquires this lock before it starts normal watch
  work and holds it for the life of the reader process.
- Any writer of `session-identity.json` or `daemon-cursors.json` remains in the
  daemon parent, but the reader lock still serializes reader processes so two
  parents do not feed conflicting reads into the same local index.

Daemon mode:

- `bin/fleet-daemon.mjs` starts exactly one `bin/fleet-jsonl-ingester.mjs` child.
- If the daemon child cannot acquire the reader lock, daemon startup/readiness
  fails loud; do not silently run without the reader.

Direct/break-glass mode:

- Before starting standalone cold-read mode, the direct path attempts to acquire
  the same reader lock.
- If the lock is held by a live daemon reader, direct resume/respawn must not
  start a second reader.
- Preferred behavior: if a reachable daemon exists for the target machine, route
  to that daemon/resolver instead of direct local resolution.
- If no daemon route is available and the lock is held, fail loud with a typed
  single-reader error such as:

```js
{
  ok: false,
  code: 'reader-already-running',
  retry_after_ms: 1000,
  detail: { lock: '~/.config/tlda/session-reader.lock' }
}
```

Fresh direct starts still skip the resolver and do not need the reader lock.

## Bounded not-yet-indexed race

On daemon Codex resume:

1. Look up the agent in the in-memory/persisted identity index by `agent.id`.
2. If a valid Codex record exists, return its bare UUID.
3. If missing, do not scan `~/.codex/sessions`.
4. Ask the existing reader child to advance/drain the active tail once for the
   agent's watched rollout:
   - Use `agentPaths.get(agent.id)` to find the live JSONL path.
   - Use `pathWatchers.get(jsonlPath)` to find the watch.
   - Add a reader message such as `{ type: 'drain-once', watchId }`.
   - The reader resumes/flushes pending TailFile/parser work and replies when
     queued batches and the next flush are processed.
   - Parent handles any `identity` outputs normally through
     `recordSessionIdentity()`.
5. Re-check the identity index once.
6. If still missing, return typed miss:
   `code: 'identity-ingestion-pending'`, `retry_after_ms: 1000`,
   `detail.advanced_once: true`.

If there is no active tail for that agent, return a typed miss with
`detail.reason: 'no-live-tail'`. Do not fall back to an all-files scan on the
daemon resume path.

## Direct/break-glass path

`tlda agent spawn-direct --fresh ...`:

- Do not run the resolver.
- Launch fresh immediately.

`tlda agent spawn-direct <existing-agent>` resume/respawn:

- First enforce single-reader protection. Do not run the standalone reader if the
  daemon reader already owns the lock.
- Start the same JSONL-reader process as a standalone child/CLI helper.
- The reader does a cold local read of Codex rollouts on that machine and builds
  the same identity index/result shape.
- The spawn helper calls the same `resolveCodexResumeHandle` logic against that
  reader output.
- This path is allowed to cold-read because there is no daemon parent and no
  live cursor state. The resolver logic remains identical; only the reader mode
  differs.

## What gets deleted or stopped

- Codex respawn `sessionOverride` support in `spawnRespawn()`.
- Passing caller-provided `session`, `session_id`, or `resume_id` into Codex
  respawn resolution.
- Codex respawn use of agent-row `session_id/session_ids` as authority.
- Codex respawn global filesystem scan in `findCodexRollout()`.
- Any server-side attempt to resolve, normalize, or inspect Codex sessions.

Keep separate:

- Explicit `--session <uuid>` enrollment remains a direct session operation, not
  respawn resolution.
- Claude resume helpers remain as-is unless separately assigned.

## Migration and rollout

- Existing `session-identity.json` records with Codex UUIDs remain valid.
- Existing agent rows may still contain `resume_id`, `session_id`, or
  `session_ids`; Codex respawn must not trust them as authority.
- First daemon run after deploy rebuilds/refreshes Codex ownership through the
  reader as live agents write registration/identity events.
- Direct path can recover a local hibernated Codex agent by cold-reading local
  rollouts with the same reader process.
- Rollout basename values such as `rollout-2026-...-<uuid>` must be rejected as
  resume ids and may only be parsed by the reader as a file path source for a
  bare UUID.

## Test plan

Unit tests:

- `resolveCodexResumeHandle` returns bare UUID from a Codex identity record.
- `resolveCodexResumeHandle` rejects a full rollout basename as an input/handle.
- Codex respawn no longer passes `sessionOverride` to the resolver.
- Missing index with active tail sends one `drain-once`, records identity output,
  then succeeds.
- Missing index with active tail and no identity after drain returns
  `identity-ingestion-pending` with `retry_after_ms`.
- Missing index with no live tail returns typed `missing-resume-handle` or
  `identity-ingestion-pending` with `reason: 'no-live-tail'`.
- Ambiguous/conflicting owner evidence returns typed miss, not a wrong UUID.
- Direct reader cold-read produces the same success result shape as daemon mode.
- Direct reader cold-read refuses with `reader-already-running` when the daemon
  reader holds the single-reader lock.
- Direct `--fresh` does not start the reader/resolver.

Integration/acceptance:

- Respawn `frontier`; verify the command contains `codex resume <bare UUID>`.
- Respawn `appstyle`; verify the command contains `codex resume <bare UUID>`.
- Try the failing negative case: a full rollout basename cannot reach
  `codex resume`.
- Fresh UI spawn still succeeds through server -> daemon routing.
- Multi-machine split: server routes only by target machine/env; daemon resolves
  local rollout UUID; no server-local `~/.codex/sessions` access.

## Open hook confirmation

The code currently confirms the daemon is already using a reader child:
`bin/fleet-jsonl-ingester.mjs`. The spec assumes implementation will extend that
child rather than introduce a second reader. `ops-fix` has been asked to confirm
the hook names before implementation:

- `agentPaths`
- `pathWatchers`
- `childWatchers`
- `cursors`
- `sessionIdentityStore`
- `recordSessionIdentity`
- `syncSessionWatchers`
- `resolveCodexJsonl`

If `ops-fix` corrects these names before coding, update this spec before the
implementation patch.
