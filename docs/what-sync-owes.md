# Source synchronization acceptance contract

This document states the properties that every source-sync implementation must
preserve. It is an acceptance contract, not a claim that each property is
currently covered by a passing test.

## Durability floor

Git history is the recovery floor. Work that reached the accepted revision or a
linked remote must remain recoverable unless that history is deliberately
rewritten.

The interval between an edit and its first durable revision must be bounded and
documented. A process crash inside an accept must leave either the old complete
revision or the new complete revision—never a half-published state.

Retries at durability boundaries must be answerable and idempotent. A repeated
operation returns its stored terminal result or safely converges; it does not
silently double-apply work.

A source-room socket closing during an update must not make the edit disappear
without either durable acceptance or a visible failure state.

## Multiple participants

The collaboration topology is `2 + n`: multiple linked daemons and browser
editors use the same authority and reconciliation rules. Adding another
participant must not require a new sync mechanism.

- Disjoint edits from stale peers merge and both land.
- Overlapping edits are refused with legible per-path conflict evidence.
- Files neither side changed, including binary figures, do not create a
  conflict merely because they are present in the project.
- A browser editor is a participant, not a last-writer-wins exception.

## Actionable refusals

A refusal identifies every path that differs and the direction of the
difference:

| evidence | meaning |
| --- | --- |
| declared revision has a path the proposal lacks | the sender omitted a file |
| proposal has a path the declared set omits | the sender proposes a deletion or new root |
| both changed the same path incompatibly | the path requires conflict resolution |

A refusal must leave a durable, queryable trace even when no text file can carry
conflict markers—for example, when two participants replace the same binary.

Adding a document through the application's own document-opening affordance
must make it a first-class project root. A later dependency scan must not
reinterpret that document as a deletion merely because the main document does
not reference it.

The accepted revision advancing is the proof that a proposal landed. Contact,
attempt, or receipt timestamps do not establish acceptance.

## Linked remotes

A linked remote works in both directions:

- accepted browser and checkout edits reach the remote through the ordinary
  project proposal path;
- remote advances enter the same source authority and reach linked participants.

Fan-out follows every accepted revision, not a route-specific flag. A browser
edit concurrent with an incompatible remote edit is refused; a non-overlapping
browser edit is merged and can be published to the remote.

## Scale

Reading one file may inspect a manifest whose size grows with the project, but
it must not read every other file's bytes. Verify this property by making the
other content unavailable and confirming that the target still reads, with a
negative control showing that a file whose own content is unavailable fails.

Large source transfers are bounded in encoded wire bytes. A single file larger
than the transport can carry receives an explicit refusal or uses an explicit
chunking protocol; it is not sent as an oversized one-file batch.

## Required end-to-end checks

An implementation is not complete until route-level tests establish:

1. an edit becomes durable within the documented exposure window;
2. real process termination during acceptance loses no work;
3. replay does not double-apply a terminal operation;
4. closing a source-room connection does not silently lose the last update;
5. multiple daemons and a browser editor converge on disjoint edits;
6. overlapping text and binary edits refuse visibly without overwriting either
   participant's copy;
7. application-added document roots survive rescanning;
8. marker-less refusals remain queryable;
9. remote changes fan out and accepted local changes publish outward;
10. one-file reads do not load unrelated file contents.

Tests must cross the wire or route boundary responsible for the result. Calling
the sender and receiver independently proves the two functions, not the
connection between them.
