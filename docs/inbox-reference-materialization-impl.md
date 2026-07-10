# Inbox Reference Materialization Implementation Packet

Date: 2026-07-05
Status: gate packet for Phase 1 of `docs/inbox-references-vision.md`

## Goal

Implement recipient-local file materialization for fleet chat attachments.

When an agent sends a file reference through chat, the existing sender-side
pipeline uploads the file to the fleet server and rewrites the message as an
attachment token. Phase 1 extends that pipeline so each recipient agent can also
receive a local copy on their own machine through their fleet daemon. The
recipient's agent-facing message/inbox view can then show a local path that its
tools can open.

This is the first concrete build slice of "references should work as
references."

## Current Code Anchors

- Sender-side detection/upload:
  - `shared/message-processing.mjs`
  - `shared/chat-file-processing.mjs`
  - `mcp-server/fleet-tools.mjs` `chat()` path around `processMessageText(...)`
- Server chat event insertion:
  - `server/unified-server.mjs`, `type === 'chat'` handler
  - stores `metadata.inline_attachments`, `metadata.attachments`,
    `metadata.context`, `metadata.source`, delivery/status fields
- Fleet upload and unquote repair:
  - `server/routes/fleet.mjs` `/api/upload`
  - `server/routes/fleet.mjs` `/api/unquote-file`
- Existing daemon RPC patterns:
  - `server/routes/fleet.mjs` `rpcAgent(...)` and `resolveRpc(...)`
  - `bin/fleet-daemon.mjs` `rpcResolveFile(...)`
  - `bin/fleet-daemon.mjs` `rpcRechat(...)`

## Non-Goals

- Do not replace the current upload/browser artifact contract.
- Do not materialize arbitrary URLs or backticked paths.
- Do not write files outside the managed inbox refs root.
- Do not mark the message or inbox item seen because a file was materialized.
- Do not pretend success if the recipient daemon route is absent.
- Do not add sender-selected delivery channels.

## Data Model

### Attachment Metadata

Keep the existing `inline_attachments` array as the sender/server-visible
attachment list. Add stable fields where missing:

```json
{
  "type": "file",
  "id": 0,
  "name": "repro.png",
  "path": "/Users/sender/tmp/repro.png",
  "url": "https://fleet.example/api/file?path=...",
  "mimeType": "image/png",
  "size": 12345,
  "sha256": "..."
}
```

`path` remains the sender-local original path. It is source metadata, not a
recipient-openable path.

### Per-Recipient Reference Metadata

Add a per-event metadata object:

```json
{
  "recipient_refs": {
    "fleet:190facd1": {
      "attachments": {
        "0": {
          "state": "available",
          "path": "/Users/skip/.config/tlda/inbox-refs/fleet-e466eb4b/2026-07-05/event-936409/repro.png",
          "size": 12345,
          "sha256": "...",
          "materialized_at": "2026-07-05T12:34:56.000Z"
        }
      }
    }
  }
}
```

States:

- `pending`: server has accepted the event and wants materialization, but no
  recipient-local result exists yet.
- `available`: recipient daemon wrote the file and returned path/hash/size.
- `failed`: daemon or server failed; include `error`.
- `skipped`: policy skipped materialization; include `reason`.

Use attachment ids as string keys because the metadata is JSON and attachment
ids already appear in `{{att:N}}` placeholders.

## Materialization Root

Use the tlda config directory:

```text
~/.config/tlda/inbox-refs/<source-agent>/<YYYY-MM-DD>/event-<event-id>/<filename>
```

Reasons:

- it matches existing tlda local state conventions;
- it is not project-local, so chat references do not pollute worktrees;
- event-id namespacing avoids filename collisions;
- source-agent/date grouping keeps the directory inspectable.

The daemon must sanitize `filename` to a basename. No path components from the
sender are trusted for the destination path.

## Server Flow

### Chat Insertion

In `server/unified-server.mjs` chat handling:

1. Insert the chat event exactly as today.
2. If `combinedMetadata.inline_attachments` has non-broken file attachments and
   the recipient is an agent, initialize `recipient_refs[to].attachments[id]` to
   `pending` in the event metadata.
3. After replying to the sender and broadcasting the event, queue
   materialization work for each recipient/attachment.

Do not block the chat send on materialization. Chat delivery remains fast; local
refs update asynchronously through `event-update`.

### Materialization Queue

Add a small server-side helper:

```js
queueRecipientMaterialization({
  eventId,
  recipientId,
  fromId,
  attachments,
})
```

For each attachment:

1. Resolve the recipient agent.
2. Route through `resolveRpc('materialize-attachment', recipient)`.
3. If route is `via: 'none'`, patch state to `failed` with the route error.
4. Otherwise call `sendRpc(route.machine_id, 'materialize-attachment', params)`.
5. Patch the event metadata with `available` or `failed`.
6. Broadcast `event-update` with `metadata_patch`.

This mirrors the existing route discipline in `server/routes/fleet.mjs`: no
local fallback when the daemon route is absent.

### RPC Params

```json
{
  "event_id": 936409,
  "attachment_id": 0,
  "source_agent": "fleet:e466eb4b",
  "server_url": "https://...",
  "url": "https://.../api/file?path=...",
  "name": "repro.png",
  "mimeType": "image/png",
  "size": 12345,
  "sha256": "..."
}
```

The server sends a URL that the recipient daemon can fetch from the fleet
server. The daemon writes the bytes locally and returns:

```json
{
  "ok": true,
  "path": "/Users/skip/.config/tlda/inbox-refs/fleet-e466eb4b/2026-07-05/event-936409/repro.png",
  "size": 12345,
  "sha256": "..."
}
```

## Daemon Flow

Add `rpcMaterializeAttachment(...)` in `bin/fleet-daemon.mjs` and register it in
the RPC dispatch table:

```js
async function rpcMaterializeAttachment({
  event_id,
  attachment_id,
  source_agent,
  server_url,
  url,
  name,
  size,
  sha256,
}) { ... }
```

Behavior:

1. Resolve `url` relative to `server_url`.
2. Fetch the bytes with a timeout.
3. Enforce max size before and after fetch.
4. Compute sha256.
5. If provided `sha256` does not match, fail.
6. Write to the managed refs root using an atomic temp-file rename.
7. Return local path/hash/size.

The daemon should not auto-open files or execute anything. It only writes bytes
under the refs root.

## Message And Inbox Rendering

Rendering should be recipient-aware.

When formatting a message for recipient agent `X`:

1. Check `metadata.recipient_refs?.[X]?.attachments?.[id]`.
2. If state is `available`, render the local `path` as the primary agent-facing
   reference.
3. Keep the attachment token/server URL as fallback/audit metadata.
4. If state is `pending`, render "materializing on this machine..." plus the
   server attachment fallback.
5. If state is `failed`, render the failure reason and keep the server fallback.

Do not rewrite the canonical stored message text per recipient. Store canonical
`{{att:N}}` tokens plus recipient-specific metadata; rewrite at render time.
This avoids creating different durable text for different recipients while
still giving each recipient a local path.

Initial surfaces to update:

- MCP `inbox()` formatting in `mcp-server/fleet-tools.mjs`.
- Fleet browser message rendering can display materialization state later, but
  Phase 1 proof should be the agent-facing inbox/MCP output and metadata update.

## Failure Behavior

- No recipient daemon route: state `failed`, error from `resolveRpc`.
- Fetch fails: state `failed`, include HTTP/error message.
- Size limit exceeded: state `skipped` or `failed` with explicit reason.
- Hash mismatch: state `failed`.
- Attachment missing `url`: state `failed`.
- Recipient is human/browser-only: skip materialization unless a future local
  human daemon contract exists.

The sender receipt can stay simple in Phase 1: chat accepted and upload
complete. Per-recipient materialization status can be inspected from the event
metadata/inbox rendering. A later slice can surface richer sender receipts.

## Tests

### Unit Tests

1. Destination path builder:
   - namespaces by source/date/event id;
   - sanitizes filenames;
   - rejects path traversal.
2. Metadata patch helper:
   - sets `pending`;
   - patches `available`;
   - patches `failed`;
   - does not overwrite another recipient's refs.
3. Agent-facing formatter:
   - `available` renders local path;
   - `pending` renders pending state plus fallback;
   - `failed` renders failure reason plus fallback;
   - unrelated recipient does not see another recipient's local path.

### Server Tests

1. Chat with inline attachment initializes `recipient_refs[target].attachments[id]`.
2. No daemon route patches `failed` and does not pretend local success.
3. Successful daemon RPC patches `available` and broadcasts `event-update`.
4. Human recipient does not schedule agent materialization.

### Daemon Tests

1. `materialize-attachment` downloads bytes from a test server and writes under
   refs root.
2. Filename traversal is stripped.
3. Hash mismatch fails.
4. Oversized file fails/skips according to policy.

### Live Verification

Minimum live proof before claiming complete:

1. Agent A sends Agent B a bare local file path through `chat()`.
2. Browser-visible chat still renders the attachment through the existing server
   artifact path.
3. Agent B's event metadata reaches `recipient_refs[B].attachments[0].state =
   available`.
4. Agent B's `inbox()` or hydrated message shows a local path on B's machine.
5. Reading that local path on B's machine returns the original file bytes/hash.
6. A no-daemon or hibernating route is verified to produce `failed`/pending
   state, not a server-local path.

## Rollout

1. Land daemon RPC and pure helpers with tests.
2. Wire server chat events to initialize/patch recipient refs.
3. Wire MCP inbox rendering to prefer recipient-local paths.
4. Live-test on same-machine first.
5. Live-test across Air/Mini/Fly topology before calling the multi-machine
   contract complete.

## Open Decisions For Gate

- Initial max eager materialization size. Proposed default: 25 MB.
- Whether missing daemon route should be `failed` immediately or `pending` with
  retry on daemon reconnect. Proposed Phase 1: `failed` with clear reason; later
  retry can requeue failed refs.
- Whether browser UI should show recipient-local state in Phase 1. Proposed
  Phase 1: not required; browser remains the server artifact proof surface.
- Whether to include sender receipts for materialization status in Phase 1.
  Proposed Phase 1: no; keep materialization visible in recipient event/inbox
  metadata first.
