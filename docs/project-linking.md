# Project linking

`tlda project link <project> <source>` attaches a source to a project. The source
is either a local filesystem path or a Git URL.

For a local checkout, pass the main file or the repository root:

```sh
tlda project link eiv-paper /Users/skip/work/eiv-paper/least-squares.tex
```

The Git root is stored only in this machine's daemon binding. It is never part
of shared project metadata. The daemon watches that checkout and sends
revision-checked source transactions to the server.

For a remote repository, pass its URL:

```sh
tlda project link eiv-paper https://git.overleaf.com/project-id \
  --main least-squares.tex \
  --token "$OVERLEAF_TOKEN" \
  --poll 60
```

The server owns the remote clone and polling. `--main` may be omitted when the
project already has an entry file or the clone contains exactly one LaTeX entry
file.

Linking never replaces a binding. Linking the same project to the same source is
an idempotent no-op. Linking it to a different local path on one machine or a
different Git URL fails before changing the existing binding. Detach the exact
source first:

```sh
tlda project unlink eiv-paper /Users/skip/work/eiv-paper/least-squares.tex
tlda project unlink eiv-paper https://git.overleaf.com/project-id
```

Local daemons and the server-owned remote clone are peers. Neither source has
priority; they submit through the same revision-checked source transaction
boundary.
