# The sync model

tlda admits source changes through three routes and publishes them through one
revision-checked project history.

| route | source |
| --- | --- |
| disk | A person or agent edits tracked files in a linked checkout; the daemon settles and proposes the change. |
| browser | CodeMirror updates a persisted Yjs source room; the room settles through the project proposal path. |
| remote | A linked Git remote is polled or pulled explicitly. |

Testing “sync” requires exercising the route whose behavior changed. Success on
one route does not prove the others.

## Work branch and revision chain

Each project uses two Git refs for different objects:

```text
refs/heads/tlda/<project>     author's complete tracked work branch
refs/tlda/project/<project>   published document revision chain
```

The work branch contains the author's whole tracked tree and is the branch a
daemon-managed checkout stands on. The revision chain contains only document
roots and their transitive dependencies. It is internal and is never presented
as a branch to check out.

Keeping these refs distinct lets a settle make the author's branch clean without
publishing unrelated tracked material.

## Settling a linked checkout

When the checkout is on its daemon-managed work branch, a settle:

1. stages tracked changes in an isolated index;
2. commits the complete tracked tree to the work branch;
3. advances the branch and resets the real index to the new tip;
4. derives and pushes the filtered document revision.

The isolated index preserves anything the author staged independently. Resetting
the real index after the branch moves is required for a clean working tree.

If the checkout is on another branch, tlda does not commit or push. It returns
`not-on-work-branch` and identifies the branch required for managed sync.

Untracked files are not submitted until the author adds them to Git.

## Published revision contents

The revision starts from declared document roots. If none are declared, tlda
uses supported document roots discovered in the tree. It then walks each root's
dependency closure.

Tracked files outside every document closure stay on the work branch but are
absent from the published revision. A successful settle reports files omitted
for this reason.

## Browser source rooms

The source editor reads a persisted Yjs room for each `(project, file)`, not a
local checkout file directly.

`reconcileRoomToRevision` brings rooms forward whenever a revision lands and
when a closed room is reopened. Reconciliation performs a three-way merge
against the revision the room previously held:

- non-overlapping browser and external edits merge;
- incompatible edits block the room and surface a conflict;
- unsaved browser text is not silently overwritten.

The room's app-owned working tree is allowed to publish without a human standing
on its work branch, but its proposal must still descend from the current project
revision.

## Remote changes

A remote configured during project linking is part of the daemon binding and may
be polled at the configured interval. Explicit pull remains available when
automatic polling is not configured.

Remote changes advance the same project revision used by disk and browser
proposals. Open source rooms reconcile when the head changes.

## Conflicts

Every proposal names its expected base revision. If the project advanced first,
tlda merges compatible changes and refuses incompatible ones. A refusal is
reported to the originating surface; it is not converted into success merely
because the local room or checkout retained the edit.

## Verification

The sync demonstration and route-specific tests should establish, for each
route:

- the source change reaches the server;
- the project revision advances;
- the rendered document rebuilds when applicable;
- work-branch and revision-chain contents differ only as designed;
- conflicting edits are refused visibly;
- unrelated tracked files and staged work are preserved.
