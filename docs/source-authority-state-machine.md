# Source authority and linked-checkout synchronization

The server owns the accepted source revision. A linked checkout is a peer:
its daemon submits local changes against the last accepted revision and applies
accepted changes from other peers. There is no last-writer-wins fallback.

## Server authority

Each project authority is in exactly one of these states:

- `uninitialized`: no accepted source revision exists.
- `current(revision)`: `revision` is the accepted immutable snapshot.
- `reconciliation-required`: bootstrap found different server and submitted
  source, so neither is silently chosen.

```mermaid
stateDiagram-v2
    [*] --> uninitialized
    uninitialized --> current: bootstrap(null, matching or empty server source)
    uninitialized --> reconciliation_required: bootstrap(null, differing server source)
    current --> current: submit(expected = current)\naccept immutable snapshot
    current --> current: submit(expected != current)\nreject stale-base; authority unchanged
    reconciliation_required --> reconciliation_required: ordinary submit rejected
```

The compare-and-set rule is the whole server decision: a mutation is accepted
only when its `expectedRevision` equals the current revision. A stale submission
does not mutate authority. It receives the current revision plus per-file
three-way classifications derived from its base, current, and incoming
snapshots.

Project source operations are serialized per project before this rule runs.
After an accepted mutation, the server durably sends that exact accepted
revision and changed bytes to every connected daemon except the daemon that
originated it. A daemon that does not own a linked checkout declines with
`project-not-watched`.

## Outbound linked-checkout changes

For each linked project, the daemon tracks one accepted revision and permits one
source submission in flight. Additional local filesystem changes are merged
into one queued payload.

```mermaid
stateDiagram-v2
    [*] --> idle
    idle --> in_flight: local change\nsubmit(expected = accepted revision)
    in_flight --> queued: another local change
    in_flight --> idle: accepted\nadvance accepted revision
    queued --> in_flight: accepted\nadvance revision; submit merged queue
    in_flight --> retrying: first stale-base\nlearn current revision; retry once
    retrying --> blocked: second stale-base
    retrying --> idle: conflict markers written locally\nwait for human save
    blocked --> idle: authoritative project sync supplies a new revision
    in_flight --> queued: connection lost\nmerge unknown request into queue
    queued --> in_flight: reconnect + authoritative revision seed
```

The retry is bounded to one stale-base response. If the server supplied a
textual merge conflict, the daemon writes those markers into the linked
checkout and stops deciding. The person's next save is a new ordinary
submission. A second stale-base without a writable conflict blocks automatic
submission until an authoritative project sync changes the known revision.

Known follow-up: non-conflict source-change rejections now surface as critical
daemon warnings, but the warning goes to the server owner and not to whoever
made the push that was rejected. So the person who can fix it is the one person
not told.

The ownership shape it was waiting on has since landed, and the remaining work
is smaller than "route it to the owner" sounds — but not as small, and the
recipient is the part to get right rather than the plumbing:

- **Notify the actor, not the machine.** A push carries `editedBy`, which is a
  fleet agent id: the daemon resolves it through `resolveEditor`, which returns
  the agent whose session touched the file. That is one recipient and it is the
  right one.
- **Do not fan out by daemon key.** `getAgentsByDaemonKey` exists and is the
  tempting route, but a daemon serves many agents, so that turns one person's
  rejected push into a broadcast to everyone seated on their machine.
- **The warning does not carry the actor yet.** `daemon-warning` is sent from
  `handleSourceChangeResult`, which sees the server's response rather than the
  push that caused it, so `editedBy` has to be threaded back through the
  correlation that holds the in-flight payload. That is the actual work, and it
  is a change to a delivery path rather than a one-line recipient edit.

Whoever takes it: this is a change to who receives a notification, which is
closer to a product decision than a sync fix, so it wants a judgement before it
lands rather than after.

## Applying an accepted remote revision locally

The local decision is per changed path. Let:

- `baseline` be the fingerprint recorded when the watcher last knew the path
  was synchronized;
- `pending` mean the watcher has observed a local edit that has not yet been
  submitted;
- `drifted` mean the current filesystem fingerprint differs from `baseline`;
- `same` mean the current bytes already equal the accepted remote bytes.

| Local condition | Text file | Binary file |
| --- | --- | --- |
| `same` | Leave unchanged | Leave unchanged |
| neither `pending` nor `drifted` | Apply accepted bytes | Apply accepted bytes |
| `pending` or `drifted` | Write local/remote conflict markers | Refuse and emit a critical warning |

Deletion uses the same rule: an unchanged path is deleted; a pending or drifted
text path receives local content versus an empty remote side; a binary delete
conflict is refused and surfaced.

`pending` and `drifted` are deliberately independent. A filesystem watcher
updates its recorded fingerprint when it observes an edit, so checking only
fingerprint drift can misclassify that observed-but-not-yet-submitted edit as a
clean baseline. The pending set preserves that state until submission.

Writes made by an accepted remote update are marked `remoteApplied`; the watcher
consumes that marker instead of echoing the same bytes back to the server.
After a successful apply, the daemon advances to the accepted `sourceRevision`.

## Executable checks

The implementation is checked at the same boundaries:

- `bin/source-lifecycle-authority-test.mjs`: authority bootstrap,
  compare-and-set acceptance, stale-base evidence, and
  reconciliation-required.
- `bin/source-change-correlation-test.mjs`: one in-flight submission, queue
  merging, bounded retry, blocking, and reconnect behavior.
- `bin/source-conflict-delivery-test.mjs`: stale-base conflicts are written into
  the linked checkout and automatic retry stops.
- `bin/source-server-update-apply-test.mjs`: a clean accepted server edit reaches
  a linked checkout, while a watcher-observed pending local edit produces
  conflict markers instead of being overwritten.

The live acceptance gate is the same final transition: start from one accepted
revision, pause the owning daemon, make divergent local and server edits, then
resume it. The linked checkout must contain both sides as conflict markers.

## A push cannot carry a file larger than one request

`sourceFileBatches` bounds a push at 20 MiB of raw bytes. Two things about that
bound are not true, and a 488-file course book with 33 MB CSVs found both on
2026-08-12.

**The bound is in the wrong units.** The request body is base64 inside JSON, so
20 MiB of raw bytes leaves as roughly 27 MiB on the wire, against a server that
accepts `express.json({ limit: '50mb' })`. The bound and the limit measure
different things, so staying under the bound says nothing about staying under the
limit.

**And a file bigger than the bound cannot be batched at all.** The batcher starts
a new batch only when the current one is non-empty — correct, because a file
cannot be split — so a 33 MB file becomes a 33 MB batch and about 44 MB of body.
That is under the server's limit and above what it survives: the observed result
was a request timeout followed by the box being unreachable, health included.

So the bound works for the small files and is structurally unable to help with
the large ones. Whatever replaces it, three things have to be true rather than
one: the bound measures encoded bytes, a single oversized file has an answer that
is not "a batch of one", and a file the transport cannot carry is refused with a
sentence saying so rather than by taking the server down.

Until then, a project containing a file of that size cannot be pushed, and the
failure is a dead box rather than a rejection.
