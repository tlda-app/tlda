# Staged course releases

The course release command coordinates existing publication paths. It is not a
course-level live pointer. Its immutable manifest records the independently
staged app, chapter, handout, syllabus/index, and book artifacts together with
the native pointer each one activates.

The four commands are:

```sh
node scripts/course-release.mjs plan --contract /path/to/course-release.json
node scripts/course-release.mjs stage --contract /path/to/course-release.json
node scripts/course-release.mjs deploy --manifest /release-root/releases/<id>/release.json
node scripts/course-release.mjs rollback --manifest /release-root/releases/<id>/release.json
```

`plan` is the dry run. It first requires `sourceRevision` to be the course
checkout's `HEAD` and every source-closure path to match that commit. It then
reads source closures, `tlda-requires` hashes, the
optional previous immutable manifest, and current native pointers. It creates no
directory and writes no file. Its output has one `CHANGE` or `KEEP` row for each
artifact.

`stage` runs build commands only for `CHANGE` rows. Commands receive
`TLDA_RELEASE_STAGE` and may also use `{STAGE_DIR}`, `{SOURCE_REVISION}`, and
`{APP_SHA}` in their declared arguments. A check runs against the staged output,
not the live URL. The command then hashes the staged tree and writes one
immutable `release.json`. It does not move any live pointer.

`deploy` first rehashes every changed staged artifact and checks that every
native pointer still has the value recorded during staging. Only after all
preflight checks pass does it replace the listed pointers. It never invokes a
build command. File and whole-value replacements use a pending file plus
same-directory rename; project outputs use the existing publication operation's
copy-off-path, move-aside, and rename sequence. If a later activation fails,
pointers already moved are restored from
the manifest before the command returns an error.

`rollback` refuses unless every changed pointer still names that exact release,
then restores the prior values in reverse activation order. It does not rebuild.

## Release contract

The contract belongs in the course repository. It names outputs and their public
destinations, not hand-maintained document dependencies. Each artifact's
`sources` are roots; Quarto/includes and the existing classroom fixture builder
remain responsible for producing their closure.

```json
{
  "version": 1,
  "sourceRevision": "<course-git-sha>",
  "appSha": "<staged-app-git-sha>",
  "courseRoot": "/path/to/course",
  "releaseRoot": "/path/to/immutable/course-releases",
  "previousManifest": "/path/to/prior/immutable/release.json",
  "artifacts": [
    {
      "id": "app",
      "kind": "app",
      "sources": [],
      "desired": "app.process.pic.internal:5176",
      "activation": {
        "type": "file",
        "path": "/var/lib/tlda-edge/upstream"
      }
    },
    {
      "id": "lecture-1",
      "kind": "chapter",
      "sources": ["lectures/lecture-1.qmd"],
      "build": {
        "command": "quarto",
        "args": ["render", "lectures/lecture-1.qmd", "--output-dir", "{STAGE_DIR}"]
      },
      "checks": [
        { "command": "test", "args": ["-s", "{STAGE_DIR}/lecture-1.html"] }
      ],
      "url": "https://pic.example/syllabus/lecture-1",
      "activation": {
        "type": "directory",
        "path": "/published/lecture-1"
      }
    },
    {
      "id": "homework-1-zip",
      "kind": "handout-zip",
      "sources": ["homework/homework-1.qmd", "bin/make-handout.py"],
      "build": {
        "command": "bin/build-handout",
        "args": ["homework/homework-1.qmd", "{STAGE_DIR}"]
      },
      "checks": [
        { "command": "unzip", "args": ["-t", "{STAGE_DIR}/homework-1.zip"] }
      ],
      "url": "https://pic.example/handouts/homework-1.zip",
      "activation": {
        "type": "directory",
        "path": "/published/homework-1.zip"
      }
    },
    {
      "id": "syllabus",
      "kind": "syllabus-index",
      "sources": ["index.qmd", "_quarto.yml"],
      "build": {
        "command": "quarto",
        "args": ["render", "index.qmd", "--output-dir", "{STAGE_DIR}"]
      },
      "checks": [
        { "command": "test", "args": ["-s", "{STAGE_DIR}/index.html"] }
      ],
      "url": "https://pic.example/syllabus",
      "activation": {
        "type": "directory",
        "path": "/published/syllabus"
      }
    },
    {
      "id": "course-book",
      "kind": "full-book-assembly",
      "sources": ["_quarto.yml"],
      "desired": ["lecture-1", "homework-1"],
      "activation": {
        "type": "json",
        "path": "/published/course-book-members.json"
      }
    }
  ]
}
```

`file` is the edge/front-door target pointer, `directory` is the existing
project-publication swap, and `json` is a whole-value membership replacement.
`symlink` is available for an already-symlinked static destination. The command
deliberately has no generic shell activation hook:
activation must be one of these inspectable native atomic operations.

## Compatibility requirement

A Markdown or QMD root may declare:

```yaml
---
tlda-requires: 0123456789abcdef
---
```

Before writing a staging directory, `stage` runs Git's ancestry check from every
declared requirement to `appSha`. A missing or non-ancestor hash stops staging.
The source Git SHA and app Git SHA remain separate manifest fields; an app deploy
does not invoke Quarto, and a content release does not build an app image.

## Edge cutover

`fly-entrypoint-edge.sh` seeds `/var/lib/tlda-edge/upstream` from
`TLDA_EDGE_UPSTREAM` once. `fly-edge-proxy.mjs` reads that pointer for each new
connection. Replacing it by same-directory rename changes only new connections;
existing TCP and WebSocket connections remain attached to the upstream they
already reached. The edge machine, its Tailscale identity, and production
classroom state do not move.

The first deployment of this edge change follows [Fly deployment](live-deploy.md)
and remains a one-time infrastructure cutover. Do not use the release command to
move a database, enrollment, submission, room, or Tailscale state.
