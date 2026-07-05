# Agent Inbox Modes Merge Readiness

Status as of 2026-07-05: branch-local implementation is rebased onto current
`main` and the focused regression suite passes. Remaining gates are review,
live dogfood, and any release-train deploy policy.

## Branch State

- Worktree: `.worktrees/agent-inbox-modes`
- Branch: `agent-inbox-modes`
- Current head: run `git rev-parse --short HEAD` in the worktree
- Current `main`: `12c572b6`
- Merge base with `main`: `12c572b6`

The branch was rebased onto current `main` with no conflicts. After rebase,
`git diff --name-status main..HEAD` is limited to inbox docs, MCP/server/shared
code, and inbox/roster tests; the previous apparent reversions in daemon
dead-letter, HUD coordinate-frame, and spawn privilege files are gone.

## Implemented Scope

Notification status and inbox view are separate:

- Status is the delivery/wake policy: `available`, `busy`, or `dnd`.
- View is pull-time presentation: `default`, `current-task`, `monitoring`,
  `review`, or `all`.
- `set_inbox_status(status, tag?)` publishes visible status and optional
  advisory tag.
- `inbox(view?)` renders the selected read-time view.
- `my_task` is not exposed as a public MCP tool; agents call `inbox()` directly.

Chat delivery now stamps explicit per-recipient attention metadata:

- `priority`
- `inbox_delivery`
- `inbox_status`
- optional `inbox_status_tag`
- optional `notify_by`

Sender priority is intentionally exact-phrase in this slice:

- `this is important` -> `important`
- `this is urgent` -> `urgent`

Wake policy:

- `available`: normal messages notify.
- `busy`: normal messages batch; `important` and `urgent` notify.
- `dnd`: normal and `important` queue; `urgent` notifies.
- Batched busy wake is delayed and only fires if the recipient is still `busy`
  and the exact unread event is still pending.

Default inbox rendering:

- `NOW`: immediate/notified items and overdue batched items.
- `BATCHED`: pending batched items with delivery timing.
- `BACKGROUND`: queued/watch items.

## Commit Stack

- `0b40acef` Add explicit inbox mode control tool
- `3286e8bd` Show inbox modes in fleet roster views
- `9a3bf6c5` Show recipient inbox modes after chat sends
- `055c9c09` Implement inbox status attention policy
- `da5ddc3b` Render default inbox by attention buckets
- `b7df0c30` Prove inbox attention policy over fleet WS
- `f2bd3948` Route my_task through default inbox view
- `6bfb1eea` Make inbox view formatter match public views
- `ea96e12c` Preserve attention receipts on chat retry
- `96648aa2` Sync inbox modes spec with status implementation
- `ff2848f8` Skip stale batched inbox wakes
- `c041261d` Document inbox modes merge readiness
- `5d269134` Update inbox modes readiness after rebase

The branch may have additional cleanup commits after this document update; use
`git log --oneline main..HEAD` for the authoritative stack.

Reviewer note: the first three commits were the earlier mode prototype. The
later commits reshape the implementation into the status/view split. A cleanup
pass may want to squash/reword this history before merge.

## Verified Locally

Syntax:

```sh
node --check server/unified-server.mjs
node --check shared/inbox-attention.mjs
node --check mcp-server/fleet-tools.mjs
node --check test/inbox-attention-ws.test.mjs
```

Focused regression suite:

```sh
node --test \
  test/inbox-attention-ws.test.mjs \
  test/inbox-mode-tool.test.mjs \
  test/fleet-roster-truth.test.mjs \
  test/fleet-store-metadata.test.mjs \
  test/fleet-store-chat-history.test.mjs \
  test/fleet-table.mjs
```

The suite passes branch-locally. `test/fleet-table.mjs` emits the existing local
warnings about missing `.env` and a daemon singleton held by the shared install;
the tests pass.

## Not Yet Proven

- Not deployed.
- Not live-verified against the real fleet server.
- Not browser-verified; this branch is primarily MCP/server behavior, but roster
  display/status visibility should still be checked.
- The delayed batch wake is process-local and non-durable. That is acceptable
  for this V1 slice, but should not be represented as a durable scheduler.

## Rebase Gate

Completed locally:

1. Rebased onto `main` at `12c572b6`.
2. No conflicts.
3. Re-ran the syntax checks and focused regression suite above.
4. Confirmed `git diff --name-status main..HEAD` no longer shows unrelated
   daemon dead-letter, HUD coordinate-frame, or spawn privilege files.

Repeat this gate if `main` advances before merge.

## Live Dogfood Gate

After rebase and local verification:

1. Start from an agent with default status and confirm `inbox()` shows
   `NOW / BATCHED / BACKGROUND`.
2. Set a recipient to `busy`; send a normal message; verify the sender receipt
   says batched and the recipient inbox shows the item under `BATCHED`.
3. Send `this is important` to the busy recipient; verify it notifies.
4. Set a recipient to `dnd`; send `this is important`; verify it queues.
5. Send `this is urgent` to the dnd recipient; verify it notifies.
6. Retry a chat with the same `_tempId`; verify it returns the same event ids
   and attention receipts without duplicate unread messages.
7. Read a batched item before its timer fires; verify no delayed stale wake
   appears for that event.

## Reviewer Risk Points

- Server chat idempotency now caches `receipts`; verify no caller depended on
  retry responses omitting that field.
- `my_task` is removed from the public MCP tool registry. The internal server
  WS operation is still named `my-task` because `inbox()` uses it as the backend
  fetch primitive; a protocol rename would be a separate migration.
- `inbox(view: "review")` still uses simple explicit regex filtering for
  report/review/gate/evidence terms. That is acceptable for this slice, but is
  not the future turn-search/item model.
- Batch wake timers are non-durable. Restarting the server during the batch
  window drops the delayed wake, while the unread item remains in inbox.
- Priority detection is exact phrase only by design. Do not broaden it during
  merge unless product explicitly asks for natural-language classification.
