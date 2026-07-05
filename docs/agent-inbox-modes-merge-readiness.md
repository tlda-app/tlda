# Agent Inbox Modes Merge Readiness

Status as of 2026-07-05: branch-local implementation and tests are in place,
but this branch is **not merge-ready until rebased onto current `main`**.

## Branch State

- Worktree: `.worktrees/agent-inbox-modes`
- Branch: `agent-inbox-modes`
- Current head: `2ed1f360` (`Skip stale batched inbox wakes`)
- Current `main`: `12c572b6`
- Merge base with `main`: `ee62050a`

The branch is behind/diverged from current `main`. Current `main` contains
HUD/spawn/dead-letter work that is not in this branch. Do not review or merge
the raw `main..HEAD` diff until after rebase; it currently includes apparent
changes to unrelated files such as daemon dead-letter and HUD coordinate code.

## Implemented Scope

Notification status and inbox view are separate:

- Status is the delivery/wake policy: `available`, `busy`, or `dnd`.
- View is pull-time presentation: `default`, `current-task`, `monitoring`,
  `review`, or `all`.
- `set_inbox_status(status, tag?)` publishes visible status and optional
  advisory tag.
- `inbox(view?)` renders the selected read-time view.
- Legacy `my_task` routes through `inbox(view: "default")`.

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

- `ef9d8f33` Add explicit inbox mode control tool
- `ce8fa7bb` Show inbox modes in fleet roster views
- `61b8a8c3` Show recipient inbox modes after chat sends
- `9c6d03f9` Implement inbox status attention policy
- `653504a7` Render default inbox by attention buckets
- `45e381ab` Prove inbox attention policy over fleet WS
- `56e23039` Route my_task through default inbox view
- `85284555` Make inbox view formatter match public views
- `a3c06655` Preserve attention receipts on chat retry
- `e5ca9aef` Sync inbox modes spec with status implementation
- `2ed1f360` Skip stale batched inbox wakes

Reviewer note: the first three commits were the earlier mode prototype. The
later commits reshape the implementation into the status/view split. A rebase or
cleanup pass may want to squash/reword this history before merge.

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
- Not rebased onto current `main`.
- Not browser-verified; this branch is primarily MCP/server behavior, but roster
  display/status visibility should still be checked after rebase.
- The delayed batch wake is process-local and non-durable. That is acceptable
  for this V1 slice, but should not be represented as a durable scheduler.

## Rebase Gate

Before review or merge:

1. Rebase onto current `main`.
2. Resolve conflicts by preserving current `main` HUD/spawn/dead-letter changes.
3. Re-run the syntax checks and focused regression suite above.
4. Inspect `git diff main..HEAD --stat` after rebase; it should no longer show
   unrelated reversions in daemon dead-letter, HUD coordinate-frame, or spawn
   privilege files.
5. Re-run a live temp-server WS proof if conflicts touched
   `server/unified-server.mjs`, `mcp-server/fleet-tools.mjs`, or
   `shared/inbox-attention.mjs`.

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
- `my_task` now delegates to `inbox(view: "default")`; this intentionally
  removes the duplicate legacy formatter. Verify any native-task/task-check
  expectations still work through the default inbox output.
- `inbox(view: "review")` still uses simple explicit regex filtering for
  report/review/gate/evidence terms. That is acceptable for this slice, but is
  not the future turn-search/item model.
- Batch wake timers are non-durable. Restarting the server during the batch
  window drops the delayed wake, while the unread item remains in inbox.
- Priority detection is exact phrase only by design. Do not broaden it during
  merge unless product explicitly asks for natural-language classification.
