# What in-app source editing does not do

Measured 2026-08-22 against `main` at `993553073`, on the Fly server
(`tlda-fly.cormorant-matrix.ts.net`), using throwaway projects only. Nothing here was
established by reading anyone's real work, and nothing here should be re-established that
way — see AGENTS.md §"NEVER DISCUSS HIS PAPERS. VERIFY ON A NEW PROJECT".

**Why this is a document rather than a scratch report.** All three findings are properties
of the running system that nothing else records, and two of them are invisible from the
outside: the app reports success while doing nothing, and a build reports `error` while
serving pages. Rediscovering either costs a day.

## 1. Editing in the app produces no revision, no build, and no version

Driving the editor's own path — `wss://<host>/source-sync/<project>/<file>`, the URL
`sourceSyncPath` builds in `src/shapes/FleetSourceEditorShape.tsx`, writing into
`ydoc.getText('source')`, which is the field the editor itself binds:

- the server echoes the update and broadcasts `{status: "queued", building: true}`
- **it never advances to `synced`**
- the edit **is durable**: reconnecting on a second socket shows the inserted text present
- `sourceRevision`, `acceptSeq`, `lastBuild` and the shadow commit count are **all unchanged**

Measured twice — once on a project with a local checkout, once after `tlda project unlink`
on a populated project, which is the sole-editor case. **Identical both times, so the
checkout is not the variable.**

The control that makes this a real negative rather than a blind reader: `tlda project push`
on the same project moved three of the four fields.

| | in-app edit | `project push` (control) |
|---|---|---|
| `sourceRevision` | unchanged | `b4eb82c4` → `55103eae` |
| `acceptSeq` | unchanged | 4215 → 5970 |
| `lastBuild` | unchanged | 11:53 → 23:24, `success` |
| shadow `commits` | 5 → 5 | **5 → 5** |

**The commit count is flat on both paths.** That is a second, independent failure:
versioning does not increment even on the push path that does build.

**Where it stops** — superseded, see §5. The first version of this section said the handoff
into the git-sync manager "is where it dies". The handoff is fine; the manager runs the
whole chain and the failure is at the far end of it, in the push.

## 2. The room and the published revision are diverging, and neither converges

Reading both sides after an in-app edit and a push:

- **the room** holds the app edits and **does not** contain the pushed line
- **the published revision** holds the pushed content and **does not** contain either app edit

**A person typing in the app is writing into a store that nothing downstream reads.**

This is the finding to carry forward. It is not a lost-data bug — the text is safe in the
room and survives reconnect — which is exactly what makes it hard to see: the editor looks
like it is working, because for the purpose of holding text it is.

## 3. Format creation fails on an unresolvable preamble input, and the build then lies

`ensureFormat` in `server/lib/build-runner.mjs` dumps a `.fmt` from the preamble. When that
fails it logs `Format creation failed: <first line>` and returns `null`; the caller
continues without a format (`No format available — using pretex wrapper`) and **still
publishes a DVI**. So pages serve while the status reads `error`. Both are true at once,
from one cause — this is not a stale badge.

Reproduced on fixtures built for the purpose, running the exact command `ensureFormat`
issues:

| preamble | result |
|---|---|
| `amsmath` only — **control** | FMT OK |
| `\usepackage{this-package-does-not-exist}` | **NO FMT** |
| `\input{no-such-file}` | **NO FMT** |
| `tikz` + `\usetikzlibrary{arrows.meta}` | FMT OK |
| `biblatex` + `\addbibresource` | FMT OK |

Both failures give `! LaTeX Error: File '…' not found.` then `! Emergency stop.`

**The class: the preamble names something unresolvable at dump time.** A package that is
not installed, **or an `\input` target not present in the build directory**.

**The second one is the expensive case.** A file that exists in the project but never
reaches `buildDir` fails identically to a missing package, and nothing about the project
looks wrong. Check what the build copies before concluding a file is absent.

**Run each case in its own directory.** The first pass here shared one, the `rm` between
cases was refused by the work-folder fence, and a **stale `.fmt` made two failures read as
passes**. The control row exists so that a contaminated run is visible rather than
convincing.

**Host caveat.** This table was produced on the Mini against homebrew texlive, not on the
server where builds run. It establishes the failure class and the path from it to the
symptom. It does **not** name which input is unresolvable in any particular server build;
that needs a server build log for a fixture, which finding 4 currently prevents.

## 4. `tlda project link` fails when the repo's newest commit is named `init`

**Corrected 2026-08-23. The first version of this section said `link` could not create a
working project at all. That was wrong, and the error was mine:** both my probe fixtures
were built with `git commit -m init`, which is the one commit message that triggers this.
Reproducing it twice in two directories proved only that I had made the same fixture twice.
The controlled test — same fixture, message the only variable:

| repo's only commit message | `tlda project link` |
|---|---|
| `init` | **fails**, `adopted ref … produced no versions` |
| `initial content` | **succeeds**, project builds and serves |

**The mechanism is a filter applied after a limit.** `listVersions` in
`server/lib/shadow-repo.mjs` runs `git log -n <limit>` and *then* drops entries whose
message is exactly `init` — the intent being to skip the shadow repo's own synthetic init
commit. `adoptShadowHistoryRef` (`server/lib/build-runner.mjs`) calls it with `limit: 1`.
So for a repository whose newest commit is named `init`, the one row the query returns is
the row the filter removes, the result is empty, and adoption throws.

This is AGENTS.md §"A search path translates the query and runs it" in a different file: a
predicate evaluated after `LIMIT` does not make a query slow, it makes it wrong, and it is
wrong only for particular inputs — which is why it survives.

**A real user hits this**, since `init` is an ordinary first-commit message. But it is a
narrow input-dependent failure, not a general inability to create projects.

When it does fail it leaves a **half-created project**: listed by `GET /api/projects`, but
with `sourceRevision=null`, `acceptSeq=null`, `pages=0`, `buildStatus=unknown` and no
shadow commits — and `tlda project push` from its own checkout then answers
`Error: Project not found`.

**This is not the same fault as the flat commit count in finding 1**, which the first
version of this section speculated it might be. Finding 1 is measured on projects that
adopted history successfully.

## 5. Root cause: an app-owned working tree is never based on the project's head

**The source room's working tree is created by `git init` and never reparented.** So a
commit built on its HEAD descends from nothing the server knows. The pre-receive check in
`server/lib/git-proposals.mjs` asks whether the project's head is an **ancestor** of the
proposed revision, and rejects every proposal the source room makes. Read directly off the
box by running the push by hand from the working tree:

```
remote: WrongHead 3059317276065b47453b8285b3e940a3e43cd489
```

**And the rejection is silent the whole way up**, which is why this was expensive to find:

- `pushRevision` **matches** `WrongHead` and returns `{ ok: false, status: 'WrongHead' }` instead of throwing
- `settle()` passes that value along
- `onSettled` in `git-sync-manager.mjs` **discards the return entirely**

A thrown error is logged; a returned one is not. Across 2,327 server log lines covering
several failing edits there was nothing about the project at all. The fault was found by
reading git refs on the server, not by reading logs, because there were none to read.

**The watcher path is NOT affected, and that distinction is the useful part.** A person's
checkout is not app-owned and already descends from the project head, so it never trips the
ancestor check. Measured on the deployed code: a plain file edit on disk in a bound checkout
— no app, no `queuePaths` — produced a submission and a proposal ref against a remote
carrying the same pre-receive rule. **Editing files on disk syncs; editing in the browser
does not.** Same manager, two entry points, one of them broken.

**Fixes on branch `inapp-build-version`, typecheck clean, not deployed** (server-side, and a
deploy freeze was in force):

- `3225bc503` — move HEAD to the fetched project revision for an app-owned tree. One
  functional line. Counterfactual: unfixed → no submission and no ref, silently; fixed →
  submitted, ref lands. Same harness, same rule, one variable.
- `5be6546a4` — log a returned `{ ok: false }` proposal result. Separate on purpose.
- `94569675b` — the `init` adoption bug in §4.

**Two hypotheses died on the way, each by counterfactual before any code was written**, and
both are worth knowing because each looked settled:

- *A stale `appOwnedWorkingTree` making `git add -u` stage nothing.* The elimination pointed
  straight at it and **the code's own comment predicts exactly that failure**. Killed by
  making the file tracked so `-u` would necessarily see the edit — and it still did nothing.
- *A never-settling promise wedging the `serialized()` chain.* A documented shape in this
  repo with a prior live instance. Killed by waiting longer: the chain completes in about
  ten seconds and the "hang" was a 7-second cutoff in my own harness.

**The lesson both share is the one this repo keeps relearning:** a confident static reading
with a false premise produces a fix that moves the symptom. Every one of these was settled
by running something.

## State left behind by this investigation

- The throwaway `syncdrift-21a4e891-50619` is **left unlinked**. The original reason given
  here — that `link` was broken — was wrong (see finding 4); relinking it is fine.
- Two empty projects, `soleedit-1787441352` and `soleedit2-1787441452`, are artifacts of
  finding 4. They are kept as evidence of it rather than deleted.
