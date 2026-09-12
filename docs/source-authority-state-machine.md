# Source authority and reconciliation

The server owns each project's accepted source revision. Linked checkouts,
browser source rooms, and linked remotes are peers that submit changes against a
known revision. No route uses last-writer-wins.

## Authority states

Each project is in one of three source-authority states:

- `uninitialized`: no accepted revision exists;
- `current(revision)`: one immutable revision is authoritative;
- `reconciliation-required`: bootstrap found differing sources and neither was
  selected automatically.

A submission includes its expected base revision. The server accepts it only
when that base is current or when the three-way classification permits a clean
merge. A stale or conflicting proposal leaves authority unchanged and receives
the current revision plus conflict information.

Project mutations are serialized per project so overlapping accepts cannot
produce a partially combined revision.

## Git representation

The source lifecycle stores revisions as Git commits. The commit tree is the
manifest, files are blobs, and the commit ID is the revision ID.

| ref | meaning |
| --- | --- |
| `refs/tlda/source/<project>` | accepted project head |
| `refs/tlda/applied/<binding-id>` | revision applied to a linked checkout |
| `refs/tlda/mirrored/<project>` | revision last mirrored into an author repository |

Advancing the accepted head is a compare-and-swap. Revision identity includes
history and metadata, so two commits with identical file bytes need not have the
same ID. Compare manifests when the question is content equality.

Manifest hashes are Git blob IDs. All participants use the same Git-object
calculation when deciding whether a file changed.

## Outbound checkout state

A linked checkout tracks one accepted revision and allows one source proposal in
flight. Additional filesystem changes are coalesced into a queued proposal.

```text
idle -> in flight -> accepted -> idle
                    |
                    +-> send queued changes against the new revision

in flight -> stale base -> retry once with current revision
                         -> conflict or second stale base -> blocked
```

Text conflicts are reported without rewriting the person's local file. A
non-conflict refusal also stops automatic submission until an authoritative
revision changes the known base. Reconnection merges an unknown in-flight
proposal back into the queue rather than assuming it failed or succeeded.

## Applying accepted revisions locally

The daemon evaluates each changed path using:

- the last synchronized fingerprint (`baseline`);
- whether a local change is pending submission (`pending`);
- whether current bytes differ from the baseline (`drifted`);
- whether current bytes already match the accepted revision (`same`).

| local condition | result |
| --- | --- |
| `same` | leave the path unchanged |
| neither pending nor drifted | apply the accepted bytes or deletion |
| pending or drifted | refuse the local application, report it, and preserve the local bytes |

Pending and drifted are separate signals. A watcher may update its observed
fingerprint before a local edit has been accepted; the pending set preserves
that distinction.

Accepted remote writes are marked so the filesystem watcher does not echo them
back as new local proposals.

## Browser source rooms

The browser editor writes a persisted Yjs source room. A checkpoint submits the
room's full text against its held revision. Successful revisions reconcile into
open rooms immediately and into closed rooms when they reopen.

If a checkpoint fails, the room retains the text and records that the edit has
not reached authority. A later successful checkpoint carries the current room
contents. Conflicts block the room instead of overwriting either side.

## Recovering project history

`tlda project merge` replays tlda's project history into a real author branch.
The shadow history may have rewritten commit IDs because it contains only the
project scope, so commits are paired by normalized patch identity rather than by
SHA.

The operation applies patches in sequence with `git am`, preserving author,
date, and message. Its default mode stops at the first conflict for a person or
agent to resolve. `--ff-only` uses a scratch ref and moves the target branch only
if the entire replay succeeds.

Shadow bookkeeping files are excluded from replay. Only document-scope changes
are applied to the author repository.

## Large source payloads

Source transfers are bounded. The transport must account for encoded request
size, not only raw file bytes, and must reject a file that cannot fit in one
request with an explicit error. A batch limit cannot split a single file unless
the protocol provides a chunked-file operation.

## Verification obligations

Tests of source authority must cross the route they claim to cover. At minimum,
verify that:

- a proposal with the current base advances authority atomically;
- a stale proposal does not mutate the accepted head;
- clean remote changes reach a linked checkout;
- pending or drifted local bytes remain byte-identical after a conflicting
  remote revision;
- browser rooms reconcile non-overlapping changes and surface conflicts;
- reconnects do not lose or duplicate unknown in-flight work;
- replay never applies shadow bookkeeping to the author repository;
- `--ff-only` leaves the target branch unchanged on any failed patch.

Wire-dependent claims require wire-level tests. The existence of a receiver or
registered handler does not prove that a real acceptance path invokes it.
