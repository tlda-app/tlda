# Inbox References Vision

Date: 2026-07-05
Status: vision/spec capture for release-train gate

## Purpose

This document captures the next inbox project target after the first inbox modes
and delivery-channel slices. The existing inbox spec defines the obligation
surface, modes, receipts, and push/pull notification model. This document adds
the missing layer: references, files, task history, and context hydration should
work as first-class parts of the agent's workspace, not as dead chat prose or
server-only links.

The headline requirement is:

> References should work as references.

When an agent sends another agent a file reference, the recipient should get a
real local reference on their machine. The message should be rewritten for that
recipient to contain a path they can open from their own filesystem, while
preserving the fleet attachment metadata and audit trail.

## Trace Anchors

- 2026-07-04 13:33-15:52 EDT, Skip and `msg-threading`: agent inbox interview.
  Core output: obligation-centered inbox, modes as attention state, interest
  scopes, wake-on-notify, pierce/priority, receipts, manager views, task history,
  and context hydration.
- 2026-07-04 15:36 EDT, Skip and `msg-threading`: stale task nudges should become
  normal server notification-policy events, not Todd-specific behavior.
- 2026-07-05 03:45-04:03 EDT, release-train and `msg-threading`: delivery-channel
  preference implemented as `set_delivery_channel(agent?, channel)`, with
  recipient/manager-controlled wake routing.
- 2026-07-05 04:24 EDT, release-train to `msg-threading`: Skip asked for the full
  inbox vision to be written down, with recipient-local file materialization as
  the top priority.

## Relationship To Existing Specs

This doc extends:

- `docs/agent-inbox-experience-spec.md`: mode-centered inbox, event universe,
  interest scope, notification scope, receipts, and obligation rows.
- `docs/fleet-chat-artifacts.md`: current sender-side attachment contract.
- `docs/set-delivery-channel-spec.md`: recipient/manager-owned delivery channel
  preference.

The current artifact contract gets a sender-local file to the fleet server and
renders it in chat. That remains necessary, but it is not sufficient for agent
work. Agents operate on files from local tools. A server URL or browser chip is
often evidence for a human, but an agent needs a path it can open, diff, read,
pass to a tool, or include in a follow-up report.

## Product Principle

Fleet chat is the social/audit surface. The recipient's workspace is the action
surface.

If a message says "look at this file," the system should make the referred file
available where the recipient can actually work with it. A recipient should not
have to manually download an attachment from the browser, reconstruct a path from
prose, or ask the sender to resend it.

The same principle applies beyond files:

- a task reference should open the task's current document/history;
- a thread reference should hydrate the relevant turns, not dump an entire chat;
- a code/worktree reference should resolve to the local checkout or a materialized
  copy when appropriate;
- a report/evidence reference should be available both as an inbox item and as a
  durable artifact.

## Recipient-Local File References

### Current Sender-Side Contract

Today, a normal `chat()` message containing a bare local path enters the artifact
pipeline:

1. the sender's MCP process resolves the path on the sender machine;
2. the file uploads to the fleet server;
3. the message text is rewritten to attachment tokens;
4. the browser renders images inline or files as chips.

That proves the browser can see the artifact. It does not give the recipient a
local file.

### Target Contract

For every file attachment in a message delivered to an agent:

1. The sender-side upload still happens.
2. The server records attachment metadata: content id, original filename,
   source agent, source path, size, MIME/type when known, and server URL.
3. For each agent recipient that should receive a local reference, the server
   asks that recipient's daemon to materialize the file.
4. The recipient daemon writes the file under a managed inbox references root on
   the recipient machine.
5. The recipient's delivered message view is rewritten to include the
   recipient-local path.
6. The message still preserves the attachment token/server URL as fallback and
   audit metadata.

Example delivered text for an agent:

```text
Please inspect the screenshot:

/Users/skip/.tlda/inbox-refs/fleet-190facd1/2026-07-05/msg-931976/activity-card.png
```

The browser can still render the image from the fleet server. The agent can open
the local path directly.

### Materialization Root

Recipient-local files should live under a managed, namespaced directory, not in
random project roots:

```text
~/.tlda/inbox-refs/<source-agent-or-human>/<date>/<message-id>/<filename>
```

or, if the config directory convention is preferred:

```text
~/.config/tlda/inbox-refs/<source-agent-or-human>/<date>/<message-id>/<filename>
```

Use a message-id namespace so two attachments with the same filename do not
collide. If content-addressed storage is added later, the message namespace can
contain symlinks or small reference files pointing at the content store.

### Delivery States

An attachment should have a per-recipient materialization state:

- `pending`: the file is uploaded to the server, but the recipient daemon has not
  written it yet.
- `available`: the daemon wrote the file; metadata includes the recipient-local
  path and content hash/size.
- `failed`: materialization failed; metadata includes a clear reason and the
  server URL remains available.
- `skipped`: policy said not to materialize, for example too large or disallowed
  type.

The sender's receipt should include this state when useful:

```text
Delivered to app-tester.
Attachment materialized on recipient machine:
/Users/skip/.tlda/inbox-refs/fleet-190facd1/2026-07-05/msg-931976/repro.png
```

If materialization is pending:

```text
Delivered to app-tester.
Attachment upload complete; recipient-local materialization pending.
```

### Eager, Lazy, And Prefetch

Start with a conservative hybrid:

- Small files attached to direct messages or `NOW` inbox items materialize
  eagerly.
- Large files, bulk directories, and background/watch items materialize lazily
  when the recipient opens the item.
- Modes can request prefetch. For example, `review` can prefetch report evidence,
  while `focus` can leave background attachments as server chips until opened.

This matches the inbox model: notification scope decides what interrupts, and
view policy decides how much context to hydrate.

### Daemon Boundary

The server must not pretend it can write to the recipient's filesystem. In the
real deployment, agents run on different machines. Recipient-local
materialization must go through the recipient's daemon.

If there is no daemon route to the recipient machine, the state is `pending` or
`failed`, not "success with a server-local path." A server-side `/api/file?path=`
URL is not a recipient-local reference.

### Security And Policy

Materialization should be explicit to the attachment pipeline. Do not scan all
message prose and fetch arbitrary URLs.

Initial policy:

- materialize only files that passed through the fleet attachment pipeline;
- record content hash and byte size;
- enforce size limits by mode or global config;
- store under the managed refs root;
- avoid executable auto-open behavior;
- keep original filename for ergonomics, but namespace by message id;
- preserve source agent and original source path in metadata.

## References Beyond Files

The file case is the first concrete instance of a broader rule: references in
agent chat should carry enough structure for the recipient to act.

### Task References

Tasks should have a durable backing document. The desired shape is a versioned
markdown task document that records:

- current goal and owner;
- manager/delegator;
- success criteria;
- current status;
- latest report/checkpoint;
- blockers and next action;
- links to relevant threads, reports, files, and commits.

The inbox item is the current projection of the task. The task document is the
durable artifact. Git/history answers "what did this task used to say?" without
requiring agents to scrape old chat.

Possible layout:

```text
tasks/current/<task-id>.md
tasks/archive/<task-id>.md
```

or a project-local equivalent when the task belongs to a concrete worktree.

### Thread References

An inbox row should not force the agent to read an entire raw chat. It should
hydrate the relevant turns.

Useful query shape:

```text
last 3 turns matching: "resolveChipTokens"
last 2 turns in: task:fleet:190f-mr6p8ib8
last turn from: release-train with: "gate"
```

The result should show complete turns around the match, not only snippets. It
should also preserve receipts: hydrating one matched range should mark that
range seen only if the caller requested a non-peek read.

### Project And Worktree References

Longer term, the project itself becomes part of the reference system. If an
agent points to a worktree file, commit, diff, screenshot, or generated report,
the recipient should get the most useful local representation:

- same-machine path when both agents are on the same filesystem;
- recipient-local materialized copy when the file is an artifact;
- repo-relative path plus commit/worktree metadata when the recipient has the
  checkout;
- server URL/browser chip as fallback evidence.

This should be explicit metadata, not best-effort prose parsing.

## Inbox Model Additions

The existing inbox spec defines the core obligation rows. Recipient-local
references add several fields to inbox items and hydrated views:

- `attachments`: server-visible attachment metadata;
- `recipient_refs`: per-recipient materialization records;
- `hydrate_policy`: eager, lazy, or prefetch;
- `context_query`: the thread/search query that can hydrate the supporting
  turns;
- `task_doc_ref`: task markdown backing document when present;
- `evidence_refs`: screenshots, logs, diffs, reports, or generated files needed
  to evaluate the item.

For example:

```json
{
  "id": "item:report-r482",
  "kind": "report",
  "priority": "now",
  "summary": "Browser evidence missing for reconnect test",
  "thread_ref": "task:fleet:190f-mr6p8ib8",
  "context_query": "last 3 turns matching evidence OR screenshot",
  "attachments": ["att:0"],
  "recipient_refs": {
    "fleet:190facd1": {
      "state": "available",
      "path": "/Users/skip/.tlda/inbox-refs/fleet-e466eb4b/2026-07-05/msg-931976/reconnect.png"
    }
  }
}
```

## Receipts

Recipient-local materialization must not blur the receipt model.

- Upload to server means the artifact exists for browser/audit use.
- Materialized means the recipient daemon wrote the file locally.
- Delivered means the recipient's delivery channel received the notification.
- Seen means the recipient loaded the inbox item or explicit event/thread range.
- Handled means the obligation was resolved, delegated, snoozed, or closed.

These are different facts. A file can be materialized before the agent sees the
item. A message can be delivered while materialization is still pending. A
recipient can inspect a file without marking the whole thread handled.

## Priority And Mode Interaction

Reference hydration should follow the same mode policy as notifications.

- `focus`: materialize only direct/current-task references eagerly; leave
  background references lazy.
- `inbox`: materialize `NOW` references and show lazy chips for background.
- `monitoring`: prefetch gate evidence, reports, and `WAITING ON ME` artifacts.
- `review`: prefetch report evidence and supporting diffs/screenshots.
- `incident`: prefetch current incident logs, screenshots, and mitigation
  artifacts.
- `available`: materialize broadly, subject to size/type limits.

Pierce/urgent delivery can request eager materialization, but it should remain
auditable. "This is important" changes delivery priority; it does not bypass
security or size policy.

## User-Facing And Agent-Facing Shape

### Sender Experience

The sender still writes naturally:

```text
I reproduced it. Screenshot: /tmp/reconnect-fail.png
```

The sender should get a receipt that distinguishes:

- message accepted;
- attachment uploaded;
- recipient delivery queued or sent;
- recipient-local materialization pending/available/failed.

### Recipient Agent Experience

The recipient sees the inbox item with an immediately usable path when available:

```text
NOW
[1] app-tester sent reconnect failure evidence.
    File: /Users/skip/.tlda/inbox-refs/fleet-app-tester/2026-07-05/msg-931976/reconnect-fail.png
    Actions: open-file | open-thread | mark-handled
```

If pending:

```text
[1] app-tester sent reconnect failure evidence.
    File: materializing on this machine...
    Fallback: fleet attachment att:0
    Actions: refresh | open-thread
```

### Browser/Human Experience

The browser remains a ground-truth visual surface. Images still render inline;
files still render as chips. The new behavior should add per-recipient local
reference state where appropriate, not remove browser evidence.

## Implementation Phases

### Phase 1: Recipient-Local Attachments

Build the smallest useful reference system:

- add per-recipient materialization metadata to attachment records;
- add server-to-recipient-daemon RPC to write an uploaded attachment under the
  refs root;
- rewrite recipient MCP/inbox/chat rendering to show the local path when
  available;
- preserve server URL/chip fallback;
- add tests for same-machine and no-daemon route behavior;
- verify live with two agents on different machines when possible.

### Phase 2: Inbox Hydration Queries

Add structured context hydration:

- open an inbox item by item id;
- hydrate `last N turns matching <query>`;
- preserve peek versus seen semantics;
- show exact event/thread range covered by the hydrated view.

### Phase 3: Task Documents

Back current tasks with versioned markdown task documents:

- create/update task docs from task create/update/report events;
- link inbox task rows to task docs;
- archive closed tasks without losing history;
- make old task lookup a history operation, not chat archaeology.

### Phase 4: Mode-Aware Prefetch

Use the existing attention mode as the policy point for eager/lazy/prefetch:

- `review` and `monitoring` prefetch evidence;
- `focus` stays narrow;
- `incident` prefetches active incident artifacts;
- receipts report what was queued, materialized, delivered, seen, and handled.

### Phase 5: Project-World References

Generalize files into project/worktree references:

- repo-relative file references with commit/worktree metadata;
- diff/report/screenshot bundles;
- current task follows current task document;
- historical tasks and artifacts are searchable from the project world.

## Open Questions

- Which refs root should be canonical: `~/.tlda/inbox-refs` or
  `~/.config/tlda/inbox-refs`?
- Should recipient-local paths be written into the stored message, or should the
  stored message keep canonical attachment tokens while each recipient render
  computes its local rewrite?
- What size limit separates eager materialization from lazy materialization?
- Should materialization be retried automatically when a recipient daemon comes
  online, or only when the recipient opens the inbox item?
- How should directory/bundle references be packaged: zip/tar, manifest, or
  multi-file attachment group?
- Which references should be visible to the sender as receipts, and which should
  remain recipient-private workspace details?

## Non-Goals For The First Build

- Do not replace the existing upload/browser artifact contract.
- Do not introduce sender-selected delivery channels; recipient/manager
  delivery preference remains the authority model.
- Do not parse arbitrary URLs or paths out of code blocks and materialize them.
- Do not write files outside the managed refs root.
- Do not mark an inbox item seen merely because its attachment was
  materialized.
- Do not scan all chat history on every inbox render; all views must be
  maintained or queried intentionally.
