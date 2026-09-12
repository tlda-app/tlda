# The 23 old-accept tests: what dies, what moves {#test-sort}

**Measured on `main`.** `processProjectPush` has **8 production references and 121 test
references** across 23 files. Instrument check: control symbol `zzz_does_not_exist` → 0,
`dispatchBuild` → 31, so the zeros below are real.

**The finding that decides this: most of these files are not tests of the old
implementation. They are the written specification of what sync owes Skip, and several
quote him directly in their header comments.** Delete them with the old path and the new
path ships with no statement of what it must do — which is the "ruined by subsequent
work" outcome, arriving green.

## Move to the new carrier — these are user stories, and the story survives the cut (16)

The mechanism they reach through dies. The promise they assert does not.

| file | the promise it holds |
|---|---|
| `an-edit-that-reached-nowhere` | how long an edit is exposed before anything can lose it — quotes Skip: *"I shouldn't be risking a paper"* |
| `collaborators-and-an-editor` | his 2+n threshold: *"two daemons plus the editor is starting to be a real collaboration"* |
| `collaborators-on-one-project` | the daemon rows of that same matrix |
| `a-document-he-clicked-is-not-a-deletion` | a live bug he reported 2026-08-13: clicking a document read as a deletion |
| `a-refusal-that-names-what-differed` | his pushes failing all night on the same three lines, four times in 2.5h |
| `a-refusal-that-left-no-trace` | the person nobody knew was stuck |
| `a-paper-with-figures-in-it` | a figure nobody touched classified unmergeable — every text-only story passed while this was broken |
| `one-file-out-of-a-big-book` | the 1492-file classroom book; whole-snapshot reads exceeded V8's max string length |
| `the-room-and-a-git-remote` | the Overleaf configuration he asked for directly |
| `a-remote-pull-tells-nobody` | a collaborator pushes to Overleaf and no checkout is told |
| `two-participant-source-convergence` | two participants converge |
| `typing-when-the-socket-goes-away` | you type a character and the socket carrying it goes away |
| `source-restart-mid-edit` | a restart mid-edit does not lose the work |
| `durable-source-acceptance` | an accept survives a crash at each boundary |
| `source-operation-ingress` | a replayed request does not double-apply |
| `linked-remote-divergence` | a linked remote that has diverged |

**`source-restart-mid-edit` needs its window re-derived rather than repointed blindly.**
Its dangerous window is *snapshot → write bytes → record revision*. The new path has no
snapshot, so the window changes shape — but "a process that dies mid-edit does not lose
the work" is still owed, and someone has to say where the new window is.

## Dies with the mechanism (4)

| file | why it goes |
|---|---|
| `source-transaction-snapshot-cost` | asserts what the rollback snapshot copies. There is no snapshot on the new path — the concern is structurally gone, not merely relocated |
| `source-manifest-contract` | the manifest contract. A bundle carries a tree and no manifest. **Largest single holder of the 121 references — check before deleting whether any assertion is about preservation rather than manifests** |
| `overleaf-sync-remote-provenance` | provenance through the old serialized push. Re-derive against the new accept if Overleaf keeps a carrier |
| `project-parts-push-live-render` | live render off the push route specifically |

## Needs a decision, not a default (3)

| file | the question |
|---|---|
| `source-lifecycle-http-test` | no header comment; tests the HTTP authority surface. Some assertions are about the lifecycle store, which survives |
| `source-room-daemon-test` | the room's checkpoint path. The room still checkpoints — only the call underneath changes |
| `source-edit-lint-event-test` | the app-side half of the source-edit event machinery. `emitSourceEditEvent` is one of the six effects and it survives |

## The standing check

**A test that quotes Skip in its header is a specification, not a fixture.** If a file in
the "dies" column turns out to quote him, it moves to the "moves" column and the promise
gets re-derived against the new carrier. Nine of the sixteen above do.
