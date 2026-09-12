# In-app source editing boundaries

The browser source editor participates in tlda's revision-checked sync path. It
does not directly edit a collaborator's local checkout or bypass Git history.

## What the editor writes

Each open `(project, file)` pair has a persisted Yjs source room. The editor
writes the room; the server settles room changes through the same project
proposal path used for other source ingress.

When a project revision changes, the room is reconciled in both cases:

- immediately, if the room is open;
- when restored, if it was closed when the revision changed.

Reconciliation uses a three-way merge. It does not overwrite unsaved room text
with the newest revision.

## What the editor does not do

- It does not write directly into a person's working tree.
- It does not make untracked local files part of a project revision.
- It does not bypass the expected base revision when publishing an edit.
- It does not silently choose a side when browser and remote edits conflict.
- It does not imply that a remote push succeeded merely because the room saved
  its local state.

## Conflicts and refusals

If the room and current project revision changed incompatibly, the room becomes
blocked and the editor surfaces the refusal. A newer keystroke may prevent an
older response from replacing the editor buffer, but it must not hide a real
save failure.

The browser path is exempt from the rule requiring a person to stand on the
daemon-managed work branch because `.source-room/working` is an app-owned tree.
It is still subject to revision ancestry and proposal admission checks.

## Local checkout interaction

A linked checkout submits tracked disk edits through its daemon-managed work
branch. Browser edits advance the server revision independently. When the local
checkout next settles, tlda reconciles that newer revision; incompatible
concurrent edits are reported as a conflict rather than overwritten.

For the complete three-route model—disk, browser, and remote—see
[The sync model](the-sync-model.md).
