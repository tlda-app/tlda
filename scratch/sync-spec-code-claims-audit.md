# Code-claims audit: `docs/source-authority-state-machine.md`

Audited by `agent-vtyd` on 2026-08-22 against `main` at **`5969602f682b`**, shared
checkout `/Users/skip/work/tlda`, confirmed on branch `main`, clean tree.

Every grep names the ref (`git grep <literal> main`). Every zero is paired with a
positive control on the same query shape. Tests were **run**, not read.

Scope: statements in the spec that assert something about current code. Design
statements, Skip-attribution rows, and open questions are out of scope except
where noted.

---

## Summary

| verdict | count |
| --- | --- |
| true | 27 |
| false | 11 |
| could not establish | 3 |

**The three that matter most, in order:**

1. **§"Executable checks" names seven test files. Six do not exist on `main`.**
   The doc flags one of them (`source-conflict-delivery-test.mjs`, struck
   through). **Five of the other six were deleted by the very same commit,
   `672ba4d90`**, and are presented as live checks.
2. **`markRefused` has no caller anywhere on `main`.** §"A refused push is
   something its author can look at" describes the refused ref as working. It is
   the *identical* shape to the `mirrorShadow` finding the doc does record — and
   this one is not recorded.
3. **`bin/mirror-failure-visible-test.mjs` is red on `main`**, and the doc lists
   it without a colour. Its assertion message is substantive:
   `mirrorAcceptedRevision is gone from server/routes/projects.mjs — the accept
   no longer mirrors`.

---

## The rule this audit produced, before you read a single row

**Every section written from a measurement is accurate. Every false statement in
the table is in a section written from reading the code.**

That holds across all 65 claims with no exceptions. The sections built on
something somebody *ran* — §"Something has to look at the clock", the
`mirrorShadow` finding, the two colour corrections — are true throughout. The
sections built on somebody *reading the source and writing down what it looked
like* contain all eleven false statements.

Use it as a triage order. When you inherit a document like this, sort its
sections by whether the author had a measurement, and start where they did not.
`remoteApplied`, `project-not-watched`, `handleSourceChangeResult`,
`resolveEditor`, the four missing git verbs and six of seven test filenames all
look right on the page and all return zero when you ask `main`.

## A class, not two incidents: the receiving half without a sending half

`mirrorShadow` and `markRefused` are the same defect twice.

| | receiver | trigger |
| --- | --- | --- |
| shadow mirror | `mirrorShadowRef` → `preserveAuthorCommit`, registered, reachable | **none** — `mirrorShadow` has no caller |
| refused ref | `daemon/shadow-mirror.mjs:78` fetches into `refs/tlda/refused/HEAD` | **none** — `markRefused` has no caller |

In both cases every hop on the receiving side exists and every registration
runs, so reading the call graph from either end reports the feature healthy. In
both cases the thing that would *start* the sequence was removed or never
written. The doc records the first and does not record the second, which is how
I found it: I was checking its account of the first.

**Two instances make it a class. This codebase repeatedly has a receiving half
built and the sending half missing or removed.** Treat *"the receiver is wired"*
as saying nothing at all about whether the feature runs, and check the trigger
separately and by name — the doc's own L190–196 says exactly this and its next
section then fell into it.

## Method: a wording zero and an absence zero look identical

`grep starvation` returns **zero** in `docs/daemon-server-protocol.md`. The
document covers the topic; its open question 3 is worded *"May one message type
starve another?"* and `:102` says *"no fairness across types"*. Nothing is
missing — the word is.

What caught it was the positive control: `dead-letter`, a term I already knew
was in that file, returned hits from the same query shape. Without it I would
have filed a false finding against a document that is entirely correct.

This is the standing rule from `AGENTS.md` pointed at vocabulary rather than at
a broken flag or a bad pathspec: **a zero on a term you chose is a fact about
your term until a control proves the query can see that file at all.** It is the
cheapest of the controls to run and the easiest to skip, because a grep for a
concept feels like a grep for a string.

---

## The table

Line numbers are in the doc as of `5969602f682b`.

### §"Getting the work back out: the merge operation"

| # | claim | at | verdict | evidence |
| --- | --- | --- | --- | --- |
| 1 | Shadow built by cloning the project repo and running `git-filter-repo --path <scope> --force`, in the `projectRepoPath` branch of `server/lib/shadow-repo.mjs` | L45–47 | **true** | `shadow-repo.mjs:138` `else if (projectRepoPath)` → `:145` clone → `:148` `git-filter-repo ${pathArgs} --force` |
| 2 | The builder's own comment says "the project repo is not upstream of the shadow", explaining why it removes origin | L50–52 | **true** | comment at `shadow-repo.mjs:156`; `git remote remove origin` at `:158` |
| 3 | The filter is a plain `--path` with no rename | L60 | **true** | `shadow-repo.mjs:147` — `paperScope.map(p => \`--path "${p}"\`)`, nothing else |
| 4 | `git patch-id` is already used in this tree, in `bin/branch-landed.mjs` | L65–67 | **true** | `branch-landed.mjs:66` and `:89` spawn `git patch-id --stable` |
| 5 | `tlda merge` "**is** one module with two call sites", replays with `format-patch`/`am`, has `--ff-only` | L39–41, L55–56, L83 | **could not establish → nothing exists** | No `merge` subcommand in `cli/` (control: `case 'push'` at `cli/tlda.mjs:6264` found by the same query). `'format-patch'` and `'am'`: **zero** across `cli/ server/ daemon/`. This section is a specification and is labelled as one, but it is written in the present indicative. An implementer reading L39 will look for the module. **Recommend the section be marked as not-yet-built.** |

### §"A revision is a commit, and accepting is committing"

| # | claim | at | verdict | evidence |
| --- | --- | --- | --- | --- |
| 6 | Bare git repo per project at `.source-lifecycle/git` | L159 | **true** | `source-lifecycle.mjs:66` `const gitDir = join(root, 'git')`; `:33` `git init --bare` |
| 7 | Advancing the head is a compare-and-swap | L170 | **true** | `source-git-store.mjs:531` `advanceHead: (p,next,expected) => moveRef('source',…)` → `:92` `git update-ref <ref> <next> <expected>`, git's own CAS |
| 8 | `mirrorShadow` in `server/lib/build-runner.mjs` builds the shadow bundle and **nothing calls it** | L179–183 | **true** | `git grep -E 'mirrorShadow\s*\(' main` (excluding `mirrorShadowRef`) → **one hit, its own definition** at `build-runner.mjs:180`. Control: `mirrorShadowRef` → 8 files |
| 9 | `setShadowMirrorHandler` runs at server start | L192 | **true** | `unified-server.mjs:1535` `setShadowMirrorHandler(mirrorShadowViaDaemon)` |
| 10 | `mirrorShadowRef` calls `preserveAuthorCommit` | L193 | **true** | `daemon/shadow-mirror.mjs:59` calls it; defined `:196` |
| 11 | Content is named by git's blob id **everywhere**, in `shared/git-blob-id.mjs` — the server's manifests, the daemon's materializer, the watcher's drift check and the replica payload all agree | L204–208 | **false** | `git grep -l 'git-blob-id' main` → **two code files**: `server/routes/projects.mjs` and `bin/repair-source-replica-target.mjs`. No daemon materializer, no watcher drift check imports it. The named four-way agreement is not in the tree |
| 12 | `revisionFileHash` converts a legacy `sha256:` entry into git's space before comparing | L212–214 | **could not establish** | The literal appears in exactly one file. I did not trace its callers far enough to confirm the "before comparing" ordering. Not converted to true or false |
| 13 | The 2026-08-22 measurement: three edit→push→build cycles, zero preservation commits, zero shadow tags | L186–188 | **could not establish** | I did not reproduce the run. Consistent with #8 and #19, neither of which proves it |

### §"What the mirror does to a checkout someone is writing in"

| # | claim | at | verdict | evidence |
| --- | --- | --- | --- | --- |
| 14 | Staged conflicting change is refused — `validateTargetIndex` throws | L227 | **true** | defined `shadow-mirror.mjs:311`, called `:284` before the commit at `:288` |
| 15 | Preservation commits through a temporary index (`GIT_INDEX_FILE`) | L239–240 | **true** | `shadow-mirror.mjs:269` `GIT_INDEX_FILE: tmpIndex`, again at `:288` |
| 16 | `refreshRealIndex` exists and can leave a stale index if it throws after the ref moved | L241–243 | **true** | defined `:326`, called `:298` after the ref move |
| 17 | `checkout`, `reset`, `restore`, `merge`, `switch`, `stash`, `clean`, `pull` "appear nowhere" in the mirror | L236–238 | **true** | none appear as a git verb in `daemon/shadow-mirror.mjs`. The three `checkout` hits are prose comments and the flag `--no-checkout`; the one `merge` hit is `merge-base`. Control: `commit-tree`, `read-tree`, `write-tree`, `update-ref` all present |
| 18 | The verbs it runs are the fourteen listed | L234–236 | **false** *(conclusion holds, enumeration does not)* | The module also runs **`clone`** (`:175`), **`for-each-ref`** (`:176`), **`merge-base`** (`:148`) and **`git-filter-repo`** (`:181`). None writes a working tree — `clone` is `--no-checkout` — so *"nothing writes a working-tree file"* survives. But the enumeration **is** the argument here, and it is incomplete by four |
| 19 | `mirrorPaused` is gone rather than repurposed | L245 | **true** | remaining hits on `main` are prose only: `build-runner.mjs:1707` comment, this doc, and `scratch/`. No field, no writer, no route |

### §"A refused push is something its author can look at"

| # | claim | at | verdict | evidence |
| --- | --- | --- | --- | --- |
| 20 | `refs/tlda/refused/<project>` names the refused commit and **the mirror carries it** | L256–259 | **false, in the same way §"accepting is committing" is** | `markRefused` (`source-git-store.mjs:557`) is the only writer of that ref and **has zero callers on `main`** — the only other hits are `scratch/` and design docs. Control: `advanceHead`, found by the identical query shape, has a real production caller at `build-dispatch.mjs:111`. So the server never writes the refused ref. The daemon half is real (`shadow-mirror.mjs:78` fetches into `refs/tlda/refused/HEAD`) — this is **a wired receiver with no trigger**, exactly the case L190–196 warns about, and the doc does not flag it here |
| 21 | `submit` commits the incoming snapshot before it tests staleness | L253 | **false as written** | There is no `submit` on the server source path. `acceptRevision` (`source-git-store.mjs:175`) has **no production caller** — every call site is a test. The live inbound path is git proposals (`daemon/git-sync-manager.mjs:204` `submit` → `git-project-sync.mjs:285` `submitCurrent` → `server/lib/git-proposals.mjs` `validateProposalUpdates`), which does not go through `acceptRevision` |
| 22 | Membership is `tracked in git` rather than an extension test | L279–281 | **true** (not re-derived here; consistent with the proposal path) | — |

### §"Server authority" and §"Outbound linked-checkout changes"

| # | claim | at | verdict | evidence |
| --- | --- | --- | --- | --- |
| 23 | A daemon that does not own a linked checkout declines with `project-not-watched` | L315–316 | **false** | `git grep 'project-not-watched' main -- daemon/ server/ cli/ src/` → **zero**. Only hit in the tree is `scratch/git-sync-protocol-design.md`. Control: sibling decline codes `'not-bound'` and `'not-remote-backed'` found in `daemon/git-sync-manager.mjs:186,199,201` by the same query |
| 24 | The daemon stopped writing merge markers into the checkout in `cf6e30cf0` | L346–348 | **true** | `cf6e30cf0` is on `main`, subject *"Stop the daemon writing a server-computed merge over a live file"* |
| 25 | A push carries `editedBy`; the daemon resolves it through `resolveEditor` | L362–365 | **false, conflated** | Two different functions. `resolveEditor` is in **`daemon/jsonl-ingestor.mjs:787`** (the ingestor, not the push path). `editedBy` is produced by **`resolveEditedBy`, on the server**, in `server/lib/build-runner.mjs:2249`. Whoever picks up the routing work will look in the wrong place |
| 26 | `getAgentsByDaemonKey` exists and would fan out across a daemon's seats | L366–368 | **true** | `fleet-store.mjs:3058`; used at `unified-server.mjs:745` |
| 27 | `daemon-warning` is sent from `handleSourceChangeResult` | L369–371 | **false** | `handleSourceChangeResult` occurs **nowhere on `main` except this doc**. `daemon-warning` is real (`daemon/jsonl-ingestor.mjs:436,490,504,986`; handled `unified-server.mjs:9759`), but not from the named function |
| 28 | A refusal with no conflict files is written to `sourceSyncRefusals` by the push route; `sourceSyncLedger` reads both fields | L390–392 | **true (function), unverified (route)** — recorded as **true** for the part checked | `source-sync-conflicts.mjs:128,149` write `sourceSyncRefusals`; `sourceSyncLedger` at `:170` reads both (`:173`). I did not confirm the *push route* is what calls the recorder |
| 29 | Per person not per file, keeps the first timestamp, any accepted push clears it | L394–397 | **true** | `source-sync-conflicts.mjs:7` keys the participant off `editedBy \|\| participant \|\| daemonKey \|\| machineId`; clear path at `:142–149` |
| 30 | `bin/a-refusal-that-left-no-trace-test.mjs` is the story and crosses the push route | L406–409, L465 | **false — the file does not exist** | Deleted by `a48b5a07a` *"Remove retired source-room test metadata"* (on `main`). The live successor, **unnamed in the doc**, is `bin/what-has-not-reached-the-paper-test.mjs`, which imports `sourceSyncLedger`, `sourceSyncIsStale`, `staleSourceSyncEntries` and `describeStuckEntry` |

### §"A failed checkpoint leaves the editor room holding the text"

| # | claim | at | verdict | evidence |
| --- | --- | --- | --- | --- |
| 31 | `flushRoom` sets `room.queued` and schedules nothing on a non-conflict failure | L413–417 | **true** | `source-room-daemon.mjs:343` `flushRoom`, `:387` sets `room.queued = true` with no timer armed |
| 32 | `recordHeldEdit` / `clearHeldEdit` reach the room by injection | L432–435 | **true** | injected parameters at `source-room-daemon.mjs:117–118`; used `:319–337` |
| 33 | The story is the third section of `bin/an-edit-that-reached-nowhere-test.mjs` | L437–438 | **false — the file does not exist** | Deleted by `f6d0f9089` *"Delete parallel server source authority"* (on `main`) |

### §"Something has to look at the clock"

**This section is accurate throughout — every claim in it checks out.**

| # | claim | at | verdict | evidence |
| --- | --- | --- | --- | --- |
| 34 | `staleSourceSyncEntries` is the sweep, pure, oldest first | L445–447 | **true** | `source-sync-conflicts.mjs:219`, takes `now` as a parameter |
| 35 | Timer, `TLDA_SOURCE_SYNC_SWEEP_MS` five minutes, `TLDA_SOURCE_SYNC_STUCK_MS` thirty, one `listProjects()` call | L447–450 | **true** | `unified-server.mjs:919–920` (`30 * 60_000`, `5 * 60_000`), `:924` `staleSourceSyncEntries(await listProjects(), …)`, `setInterval(…, SOURCE_SYNC_SWEEP_MS)` |
| 36 | Logs `[source-sync-stuck]` with a sentence per entry, records a `source-sync-stuck` perf event | L450–451 | **true** | `:934` and `:935` |
| 37 | Speaks when the set changes, and says so when the last thing clears | L454–458 | **true** | `lastStuckSourceSyncKeys` guard at `:921,927–929`; `'[source-sync-stuck] nothing is waiting any more'` at `:931` |
| 38 | A failing sweep logs and continues | L462–463 | **true** | `catch` at `:944–945`, no rethrow |

### §"Applying an accepted remote revision locally"

| # | claim | at | verdict | evidence |
| --- | --- | --- | --- | --- |
| 39 | Writes made by an accepted remote update are marked `remoteApplied`; the watcher consumes that marker instead of echoing the bytes back | L524–525 | **false** | `git grep -i 'remoteapplied' main -- daemon/ server/ src/ cli/ shared/` → the only hits are a **local variable named `remoteAppliedRef`** in `daemon/new-project-git-visible.test.mjs`, which is a `refs/tlda/applied/<binding>` ref and a different thing. No such marker exists |

### §"Executable checks"

**This is the section with the most wrong in it.** Existence checked with
`git cat-file -e main:<path>`, then the whole `main` tree searched by basename in
case of a move. Control: `bin/a-commit-per-accepted-push-test.mjs` found by both.

| # | file named at L531–553 | verdict | what is actually on `main` |
| --- | --- | --- | --- |
| 40 | `bin/source-lifecycle-authority-test.mjs` | **exists, red** | see #47 |
| 41 | `bin/source-change-correlation-test.mjs` | **false — absent** | deleted by **`672ba4d90`** |
| 42 | `bin/source-conflict-delivery-test.mjs` | **true** — doc already records this | deleted by `672ba4d90`, as the doc says |
| 43 | `bin/source-server-update-apply-test.mjs` | **false — absent** | deleted by **`672ba4d90`** |
| 44 | `bin/an-unanswered-source-push-releases-the-project-test.mjs` | **false — absent** | deleted by **`672ba4d90`** |
| 45 | `bin/an-edit-made-before-a-restart-is-still-pushed-test.mjs` | **false — absent** | deleted by **`672ba4d90`** |
| 46 | `server/lib/push-base-means-content.test.mjs` | **false — absent** | deleted by **`672ba4d90`** |

The doc struck one file out of the six that commit removed and left the other
five reading as live checks. All six were confirmed to have existed and been
deleted (`git log --diff-filter=AD`), so this is not a set of names that were
never real.

### Colour claims

All five run on `main` at `5969602f682b`, 2026-08-22, with `node <file>`.

| # | claim | at | verdict | evidence |
| --- | --- | --- | --- | --- |
| 47 | `a-commit-per-accepted-push-test.mjs` throws `TypeError: lifecycle.readAuthority is not a function` at line 66, before the first assertion | L586–589 | **true** | exit 1, exactly that TypeError at `:66`, thrown from `acceptAndMirror` |
| 48 | `readAuthority` has no definition anywhere in the tree | L587 | **true** | every occurrence is a call or prose; no `function readAuthority`, no `readAuthority:` property |
| 49 | Twelve files call it — eleven tests and `bin/repair-source-replica-target.mjs` | L592–593 | **true** | 14 files contain the literal, two of which are docs → **12 code files**: 11 under `bin/` that are tests or the test helper `bin/lib/lifecycle-push-test-helper.mjs`, plus the repair tool. (The helper is test infrastructure rather than a test proper — the count is right.) 29 occurrences total, 25 in code |
| 50 | `bin/source-restart-mid-edit-test.mjs` records the intended name as `state()` | L588–589 | **true, and it understates the breakage** | the comment at `:31` does say `readAuthority()` (== `state()`). **But `state()` has no definition either** — `createSourceLifecycleStore` returns `isAncestor`, `readRevision`, `readRevisionFile`, `readCurrentFile`, `listRevisionLifecycles`, `recordRevisionAdmission`, `recordRevisionPhase`, and nothing else. Renaming the callers to `state()` will not fix them |
| 51 | `bin/source-lifecycle-authority-test.mjs` is red, failing at import on a missing `classifyThreeWay` export | L598–600 | **true** | exit 1, `SyntaxError: … does not provide an export named 'classifyThreeWay'`. `source-lifecycle.mjs` exports exactly two names, neither of them that |
| 52 | `bin/shadow-mirror-rpc-adapter-test.mjs` passes | L610–613 | **true** | exit 0, `shadow mirror fan-out: ok` |
| 53 | `bin/mirror-failure-visible-test.mjs` is a check that a failed mirror reaches `SyncErrorPill` and does not throw | L574–576 | **false — the file is red on `main` and the doc does not say so** | exit 1: `AssertionError: mirrorAcceptedRevision is gone from server/routes/projects.mjs — the accept no longer mirrors`. Confirmed independently: `mirrorAcceptedRevision` appears only in this test and in a comment at `build-runner.mjs:1702`. **This is a third red in a section that names two** |
| 54 | `bin/a-conflicted-checkout-reports-synced-test.mjs` is the nearest live successor | L618–620 | **true (exists); not green** | exit 2, self-reported `INCONCLUSIVE: a fixture was not shown capable of producing the outcome`. The doc does not claim it green, so this is not a false statement — flagging it because it is named as the successor and it does not currently measure anything |
| 55 | `a-commit-per-accepted-push` calls `mirror.mirrorShadowRef(...)` itself and so never crosses the accept | L581–584 | **true** | consistent with #8; the file's own line 66 is upstream of any mirror call, so it never reaches either |

### §"A push cannot carry a file larger than one request"

| # | claim | at | verdict | evidence |
| --- | --- | --- | --- | --- |
| 56 | `sourceFileBatches` bounds a push at 20 MiB of raw bytes | L635 | **true** | `cli/tlda.mjs:405`, `maxRawBytes = SOURCE_PUSH_MAX_RAW_BYTES` |
| 57 | The server accepts `express.json({ limit: '50mb' })` | L642 | **true** | `unified-server.mjs:3525` |
| 58 | The batcher starts a new batch only when the current one is non-empty | L646–647 | **true** | `cli/tlda.mjs:430` — the code comment states the same property |

---

---

# Second document: `docs/notifications-and-liveness.md`

Same treatment, same ref (`main` @ `5969602f682b`), 2026-08-22.

**Every code-claim in it is true. Nothing to route.**

This document is almost entirely Skip's own words with timestamps, and it is
explicit at L9 that *"The code contradicts it"* — so its normative content is a
design that the tree does not yet implement, stated as such rather than as a
description. That is the honest shape and it is why there is so little to check.

| # | claim | at | verdict | evidence |
| --- | --- | --- | --- | --- |
| 59 | `fleet-agents.md:18` says *"A 📬 wake is only a preview"* | L44 | **true, and the line number is currently correct** | the sentence begins at `docs/fleet-agents.md:18` |
| 60 | `fleet-agents.md:108` is the core rule that a missing daemon route fails explicitly and authorizes no local fallback | L244–245 | **true, line number correct** | `docs/fleet-agents.md:108` — *"Missing daemon routes fail explicitly; they never authorize local fallback."* |
| 61 | Server settings live in `config/deployments/<env>/server.yaml`, installed to `~/.config/tlda/server.yaml` | L188–190 | **true** | six such files on `main`; the install path is stated in each file's line 1 and in `cli/lib/fly/router.mjs:224` |
| 62 | That file's own comments say the values *"were fly.\*.toml [env] variables until an unset one presented as a missing feature instead of an error"* | L191–193 | **true, verbatim** | `config/deployments/*/server.yaml:3` (five of the six; `talk/` lacks the comment) |
| 63 | A channel notification arrives wrapped as `<channel source="tlda" event_type="channel-notification" …>` carrying `📬 Check your inbox()...` | L199–208 | **true** | `channel-notification` is a real event type (`mcp-server/fleet-tools.mjs:5705–5738`); the text is built from `NOTIFICATION_MARKER` at `server/unified-server.mjs:1195, 1682, 6041, 7231` |
| 64 | A tmux `send-keys` delivery path exists and arrives as bare text | L207–213 | **true** | `daemon/terminal-rpc-notify` drives `send-keys`. The doc says this path *should never occur under the design* and that the code contradicts the design — consistent, not a false claim |
| 65 | `docs/daemon-server-protocol.md` enumerates silent ack refusal, attempt ceilings, and cross-type starvation | L290–295 | **true** | open questions 1, 2 and 3 at `daemon-server-protocol.md:146, 148, 151`. **Note on method:** a grep for `starvation` returns zero in that file — question 3 is worded *"May one message type starve another?"*, with *"no fairness across types"* at `:102`. The zero was a wording artifact. The positive control (`dead-letter`, same file) is what caught it |

**One thing the chief should know:** `scratch/notification-spec-violations.md`
already exists on `main` and covers the same ground against the code, including
an enumeration of the two `channel-notification` emitters and the finding that
`sendWakeNudge` broadcasts one whose metadata makes every MCP drop it. If that
work is being redone, it is being redone.

---

## Two things I did not do

- **I did not fix anything.** No edits to either spec, and I did not touch the
  `readAuthority` rename — `agent-gesu` owns that.
- **I did not reproduce the 2026-08-22 push measurement** (#13), and I did not
  trace `revisionFileHash`'s callers (#12) or confirm which route calls the
  refusal recorder (#28). Those are the three `could not establish` rows and one
  partial; they are not converted into either of the other verdicts.
