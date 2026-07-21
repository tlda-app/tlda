# Project linking

`tlda doc link` connects an existing Git working copy to a tlda project. The
working copy remains the canonical authoring directory; tlda does not create a
second repository or require a source-only subdirectory.

For a LaTeX project, `link` requires `--dir` to name the Git repository root and
records that path as the project's `sourceDir`. The initial push and subsequent
daemon pushes use the shared source collector. It includes authored TeX,
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
tlda doc link eiv-paper \
  --dir /Users/skip/work/eiv-paper \
  --main least-squares.tex \
  --title "EIV Paper"
```

Acceptance requires all of the following:

- the local Git root is recorded as `sourceDir`;
- `.git` and non-source files are absent from the source manifest;
- the managed daemon watches the working copy and establishes source ownership;
- the normal build pipeline succeeds; and
- the resulting document opens through the ordinary live viewer.
