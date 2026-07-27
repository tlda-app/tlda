# Project linking

`tlda project link` connects an existing Git working copy to a tlda project. The
working copy remains the canonical authoring directory; tlda does not create a
second repository or require a source-only subdirectory.

For a LaTeX project, pass the main file as a positional path. `link` finds the
Git repository root containing that file and records it as the project's
`sourceDir`. The advanced `--dir` and `--main` form is also supported. The
initial push and subsequent daemon pushes use the shared source collector. It
includes authored TeX,
bibliography, style, class, and referenced image sources while excluding `.git`,
`node_modules`, build products, and unrelated files. The complete filtered file
list is sent as the source manifest, so the server replica can delete sources
that were removed from the working copy without treating repository metadata as
project content.

After project creation, the managed fleet daemon receives the project binding,
watches the repository working copy, and sends source changes through the normal
push/build pipeline. A daemon connect-time push establishes the source-machine
binding used for mirror-back operations. The server-side source directory is a
build replica; it is not a replacement authoring checkout.

Linking must not commit, checkout, reset, stash, merge, pull, push, modify the
index, change branches, or rewrite remotes in the local repository. Existing
GitHub and Overleaf remotes remain author-controlled. Any persistent inbound or
outbound remote synchronization is a separate, explicitly enabled feature.

Example:

```sh
tlda project link eiv-paper /Users/skip/work/eiv-paper/least-squares.tex \
  --title "EIV Paper"
```

## Remote and Overleaf repositories

Pass `--from` to make the server clone and poll a Git remote:

```sh
tlda project link eiv-paper least-squares.tex \
  --from https://git.overleaf.com/project-id \
  --token "$OVERLEAF_TOKEN" \
  --poll 60
```

This path is not Overleaf-specific: `--from` accepts any HTTPS, SSH, `file://`,
or local Git URL the server can access. The server clone is the synchronization
authority. It imports remote commits into the normal source/build transaction,
and source edits sent through tlda are committed and pushed back to the remote.
The polling minimum is 15 seconds, and configured pollers resume on server
restart.

The `--token` value is embedded only in the clone's HTTPS remote URL; project
metadata and API responses retain the sanitized URL. SSH and local remotes use
their ordinary server-side credentials.

Fetch, transaction, and push errors are recorded. Automatic conflict-file
materialization is not currently complete: the client reads
`overleafSyncStatus: "conflict"` and `overleafConflictFiles`, but the server
only clears those fields and does not set that conflict state.

Acceptance requires all of the following:

- the local Git root is recorded as `sourceDir`;
- `.git` and non-source files are absent from the source manifest;
- the managed daemon watches the working copy and establishes source ownership;
- the normal build pipeline succeeds; and
- the resulting document opens through the ordinary live viewer.
