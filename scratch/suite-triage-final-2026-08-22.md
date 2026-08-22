# All 58, attributed

agent-gesu, 2026-08-22, `main` at `7e51cee92`. Every file re-run alone at
concurrency 1. Evidence: `scratch/suite-serial-rerun-2026-08-22.log`.

## final

**54 of 58 fail alone.** The suite's own concurrency accounts for 4, and even
those passed at load 7.66–12.40 — so it is inter-file contention, not load.

Fourteen causes. The count in each row is the whole of that cause.

### The suite cannot be a gate as it stands, and here is the shortest reason

**Twenty-three of the 58 assert nothing about the code.** Fifteen cannot start,
one cannot evaluate its own assertions, three pin a renamed identifier, two
measure the shell that ran them, one says its fixture was not capable, and one
walks a directory instead of the package. Every one shows as red, which is the
opposite of what is true — a red light on a test that never ran.

---

### 1. Cannot start — deleted lifecycle API · **15 files**

`f6d0f9089` (2026-08-20 16:50 EDT). Blind since. Verdicts as requested:

**Behaviour the system still owes (10):** `a-commit-per-accepted-push`,
`two-participant-source-convergence`, `an-accept-the-daemon-is-never-told-about`,
`a-retry-that-lands-once`, `a-refusal-that-names-what-differed`,
`a-figure-does-not-refuse-a-rebase`, `one-file-out-of-a-big-book`,
`source-restart-mid-edit`, `a-second-build-slot-that-exists`,
`server/lib/build-instance.test.mjs`.

**Unclear (2):** `a-ref-that-does-not-outrun-its-record`,
`source-lifecycle-authority`.

**Deleted mechanism (3):** `a-bootstrap-does-not-repeat-over-real-history`,
`replica-command-not-retained`, `server/lib/source-lifecycle.test.mjs`.

Attached: `bin/lib/lifecycle-push-test-helper.mjs` (helper), and the non-test
casualty `bin/repair-source-replica-target.mjs`.

### 2. Same deletion, stranded on the old CLI push · **2 files**

`cli-push-reporting-and-batching` (expects the CLI to POST `…/source-room/files`;
it contains that string zero times), `cli-markdown-push-source-set`.

Underneath the second: **`cli/lib/source-files.mjs` is a dead module behind a
dead import.** All five exports appear in `cli/tlda.mjs` exactly once — the
import line — and nowhere else on `main` except two tests. One of those tests,
`test/source-manifest.test.mjs`, is **green**, so dead code currently reads as
covered.

### 3. Same deletion, correctly reporting a real absence · **1 file**

`mirror-failure-visible` — `mirrorAcceptedRevision` is gone. `68cd40874` added
the accept-side call; `f6d0f9089` deleted it four commits later.

### 4. Cannot evaluate its own assertions · **1 file**

`login-preserves-binding-regression` — slices `unified-server.mjs` between
anchors; two of four no longer exist. **Fourteen assertions never run**: register
and login must not wipe `session_id`, `session_ids`, `cwd`, `machine_id`,
`env_name`, `daemon_key`, `resume_id`. Invariant unverified. Silent hole, red
light on it.

### 5. Pins an identifier where it means a property · **3 files**

`canvas-clip-camera-physics`, `book-member-identity`, `project-link-git-boundary`.
Repaired in `71d5435f5` on branch `suite-matcher-drift-repair`; the first and
third now pass. `book-member-identity` stays red on two expectations that are
**not** a rename — `<ProvenancePanel>` and `<ProvenanceInline>` now render with
no props at all, reading the ribbon from the editor store. Dropping those two is
a coverage decision, so it is left open.

### 6. Measures the shell that ran it · **2 files, two different mechanisms**

- **`test/cli-managed-restart-help.test.mjs`** — writes its own `daemon.yaml`
  declaring only `stable`, then spawns the CLI with `{...process.env, HOME,
  TLDA_CONFIG_DIR}`. It isolates `HOME` and the config dir and **not `TLDA_ENV`**,
  which is `testing` in any agent shell. Proven: **exit 1 inherited, exit 0 with
  `TLDA_ENV` unset**, same box, seconds apart.
- **`bin/a-scratch-section-still-builds-test.mjs`** — `~/.claude/bin` is **first**
  on every agent's PATH and shadows the whole TeX toolchain: `pdflatex`,
  `xelatex`, `lualatex`, `latexmk`, `biber`, `bibtex`, `makeindex`, all symlinked
  to `tex-build-wrapper`. Format creation fails, no DVI. Proven: **exit 0 with
  the real `pdflatex` first on PATH, exit 1 as the fleet runs it.**

  Four test files across the 375 reach `build-runner`; only this one gets far
  enough to build. **Anyone comparing suite results between an agent shell and a
  human shell will get different answers.**

### 7. No preview server · **5 files**

`brush`, `inbox-notes`, `inbox-structural`, `inbox-typed-rows`, `ribbon-inbox` —
all `ERR_CONNECTION_REFUSED` at `https://localhost:51xx/`, alone as well as in
the suite. None of them has measured the app.

### 8. Pass alone — inter-file contention · **4 files**

`daemon/project-link-git-http`, `server/lib/agent-model-backfill-wire`,
`server/lib/amend-notify-wire`, `test/bot-manager-supervision`. The two wire
tests die on `ENOTEMPTY` removing their own `mkdtemp` directory while the server
they spawned is still writing to it. **This is the only group the suite's
concurrency explains.** (`/tmp/tlda-fence-env` holds 3,088 entries; nothing
sweeps it.)

### 9. Flaky · **1 file**

`server-originated-claude-mint-real-daemon` — red in your suite run (28.2s), red
in my serial run (63.1s), **green twice since**, nothing changed. The only file
that has given different answers to the same question on the same tree.

### 10. Says so itself · **1 file**

`a-conflicted-checkout-reports-synced` — prints `FIXTURE NOT CAPABLE` and exits
`INCONCLUSIVE`. Honest, and measuring nothing.

### 11. Daemon / mint fixtures · **5 files**

`agent-wake-grant-regression`, `mint-seat-retry-real-daemon`, `spawn-collision`,
`spawn-mailbox-outcome`, `suggestions-test`. **Not identity-dependent** — I ran
the counterfactual with `TLDA_ENV`, `FLEET_DAEMON_KEY`, `FLEET_ID`, `FLEET_NAME`,
`FLEET_MINT_ID`, `FLEET_LOCAL_ID`, `FLEET_HARNESS`, `FLEET_TMUX_SESSION`,
`TLDA_MACHINE_ID` stripped and **none of them flips**. `suggestions-test` does
leak `FLEET_DAEMON_KEY` into the bot it spawns and the mismatch is really in its
log, but removing it does not change the outcome, so that is not what fails it.
These want a daemon-fixture owner.

### 12. Cannot pass on this machine · **1 file**

`test/live-source-caller-boundary` — shells out to **`rg`, not installed here**;
`execFile` rejects with `ENOENT` and the test asserts `code === 1`. Its own query
run by hand returns exit 1 with no matches, so the thing it checks for is
genuinely absent and it still cannot say so. Also the shape `AGENTS.md` forbids —
a test whose job is to prove nobody has done something.

### 13. Measures a directory, not the package · **1 file**

`bot-package-surface` — reports `@tlda/bot` missing the symbol **`'a'`**,
"imported by" two **full tlda checkouts parked inside
`/Users/skip/work/tlda-bots`**. The walk reads those copies of the test file and
its own `IMPORT_RE` matches its own source. Nothing is missing from `@tlda/bot`.

### 14. Genuine defects, real assertions over real code · **14 files**

These are the ones that carry evidence about behaviour.

| file | expected → actual |
|---|---|
| `test/search-grammar-categories.test.mjs` | `alpha ! beta` → `JuxtapositionError`. The executor rejects syntax autocomplete advertises |
| `test/thread-card-controls.test.mjs` | `0` → `1` occurrences of `class="code-block-lang">bash</span>`. A bash tool call is labelled twice on the card |
| `scripts/drag-coordinator-terminal.test.ts` | `{cancel: 1}` → `{cancel: 0}`. `lostpointercapture` never reaches the cancel path |
| `server/lib/project-files-store-offloop.test.mjs` | `['./a.tex','z.tex']` → `['a.tex','z.tex']`. Path normalization |
| `test/filter-subscriptions.test.mjs` | `true` → `false`. Team filters do not keep the parent relation |
| `bin/delegate-spawn-shell-reservation-test.mjs` | `/server shell reservation required/` → `'compiled permission set is required'`. A different guard fires first |
| `bin/delegate-spawn-shell-e2e-test.mjs` | a rejection → none. Missing expected rejection |
| `bin/doctor-yolo-seat-binding-regression-test.mjs` | `null` → a live row. A thrown bind/readback failure does not remove the local ledger row |
| `packages/bot/liveness-probe.test.mjs` | `1` → `2` sockets after connect |
| `bin/timer-routing-regression-test.mjs` | timer routing payload mismatch |
| `bin/semantic-operation-render-test.mjs` | `/Open thread/` absent from rendered card HTML |
| `bin/literate-story-extractor-test.mjs` | a converted collaborator test is not discovered as a literate story source |
| `bin/cli-project-completion-boundary-test.mjs` | `true` → `undefined` |
| `bin/cli-command-family-completion-boundary-test.mjs` | its own 28s timeout on `project unlink` |

---

## What this means for the gate

**Fourteen files are real signal. Twenty-three are noise wearing a red light.
The rest are fixtures and environment.**

Nothing here says the suite cannot become a gate. It says that today a red run
tells you almost nothing without a per-file reading, and that two files answer
differently depending on whose shell invoked them — which is the property a gate
cannot have.

**The cheapest thing that would change that**, and it is not my call: make the
23 stop reporting red. A test that cannot run should say so in a way that is
distinguishable from a test that ran and failed. Group 1 alone is 15 of them and
is already yours to route.

## Standing caveats

- I did not run the full 375-file suite at concurrency 4. The orphan-server
  question is answered only for these 58, where a completed serial run left
  **zero**.
- Group 11 needs a daemon-fixture owner; I established what it is not, not what
  it is.
- I fixed nothing outside `71d5435f5`, and pushed and deployed nothing.

---

## Two findings that came out of the triage and are bigger than it

### A guarantee whose bounding document says it was carried, and no carrier exists

`bin/a-retry-that-lands-once-test.mjs` was added in `17f767e24` on **2026-08-18
16:50:21 EDT**, one commit, never amended. `f6d0f9089` landed **2026-08-20
16:50:54 EDT** — two days later to the minute. Its header, lines 3–14, verbatim:

> **A retried push must land once.**
>
> The operation journal — `prepareOperation` / `finishOperation`, `requestId` and
> `deliveryId` dedup, crash-safe replay — had exactly one production caller,
> inside `processProjectPushSerialized`. So the new carriers had none of it, and
> deleting the old path without moving it is the single way this strip ends worse
> than it started: the app looks fine, and a guarantee that survived a crash
> quietly no longer exists.

`docs/what-the-old-push-did.md` — the enumeration `AGENTS.md` names as the bound
on what this deletion may take with it — says that dedup **is carried across**, to
`acceptUnderOperationJournal`, "both carriers". **Every carrier it names has zero
occurrences in `server/`, `daemon/`, `cli/` or `bin/fleet-daemon.mjs`:**
`acceptUnderOperationJournal`, `acceptSourceSnapshot`, `applyAcceptedSourceEffects`,
`runSerializedProjectSourceOperation`, `carryForward`, `persistSnapshot`,
`advanceSourceHead`. Whole-tree, the first three appear only in `docs/` and
`scratch/`. Positive controls on the same command shape: `createSourceLifecycleStore`
3 files, `recordRevisionPhase` 5.

The doc was last touched in `e3ba10559`, **2026-08-20 05:54 EDT — eleven hours
before the strip.** So the document that exists to bound the deletion currently
tells anyone who consults it that a guarantee is fine, and the guarantee has no
carrier by that name.

### But the property itself survived, by a better mechanism

**A retried push lands once.** Established from the code with controls, no live push:

1. **The daemon compares the tree, not the commit** — `daemon/git-project-sync.mjs:165`:
   `if (parent && rev-parse ${parent}^{tree} === tree) return { commit: parent, changed: false }`.
   An unchanged resend never reaches `commit-tree`, so the revision sha is stable.
2. **The revision is in the ref name** — `refs/tlda/proposals/<daemonId>/<branch>/<revision>`
   (`git-proposals.mjs:28`), so a resend writes the same ref.
3. **Admission is keyed and constrained** — `admitBuild` opens with
   `store.get(project, revision)` (`build-queue.mjs:147`), `admit()` re-checks inside
   a transaction, and `build_submissions` carries **`UNIQUE(project, revision)`**
   (`build-queue-store.mjs:23`). A second submission of one revision is
   unrepresentable.

Controls run in a throwaway repo:

| check | result |
|---|---|
| same content → same tree sha | **YES** |
| `commit-tree` twice on that tree, 1s apart | **NO** — different shas |
| re-push of an existing sha to its own ref | **`[up to date]`**, zero new objects |

The middle row is why step 1 is load-bearing rather than an optimisation.
Corroboration that this is designed: `recoverProposalBuilds()` re-admits every
proposal ref on every server start, which would duplicate every pending build if
admission were not keyed.

**Two bounds.** The tree shortcut compares against the daemon's `localRef`; if
that ref is absent — fresh checkout, reset, re-clone — the daemon re-commits, the
timestamp moves, and the same edit becomes a new revision. **Untested.** And
`unified-server.mjs:9263` passes `retryTerminal: msg.retry_terminal === true ||
!hasCurrentLifecycle`, whose second disjunct re-admits a `complete` row whenever no
lifecycle record names that revision — a repair path, but the one place a finished
build re-runs without anyone asking.

**So the doc is stale and the guarantee is intact.** When the doc is fixed, that row
should say the dedup is *not* carried across and name what holds the property now.

### An agent's shell is not a neutral place to run this suite

`~/.claude/bin` is **first** on every agent's PATH and symlinks out to
`dot-claude/bin`, shadowing the entire TeX toolchain — `pdflatex`, `xelatex`,
`lualatex`, `latexmk`, `biber`, `bibtex`, `makeindex`, all routed through
`tex-build-wrapper` — plus `rm`.

Proven on `bin/a-scratch-section-still-builds-test.mjs`: **exit 1 as the fleet runs
it, exit 0 with the real `pdflatex` first on PATH.** Four files across the 375 reach
`build-runner`; this is the one that gets far enough to build.

**An agent and a human running the same suite on the same tree get different
answers, and every suite measurement taken here so far was taken through the shim.**
That invalidates cross-shell comparison generally, not one file.

The second variable is `TLDA_ENV`, by a different route —
`test/cli-managed-restart-help.test.mjs` writes its own `daemon.yaml` declaring only
`stable` and spawns the CLI with `{...process.env, HOME, TLDA_CONFIG_DIR}`,
isolating the home and config dir but not the env name.

### The general form worth carrying

**A test that pins an identifier when it means a property.** The message keeps
naming the property, so the report lies in the direction of alarm — and the closer
the test sits to something frightening, the more expensive the lie. Three files here
(§5); `bin/login-preserves-binding-regression-test.mjs` is the same disease at the
next level, pinning a **comment** as a slice anchor and thereby never running its
fourteen assertions at all.

## Method, so this is checkable rather than inherited

- Every file re-run alone at concurrency 1, replicating `bin/run-test-suite.mjs`'s
  `runOne()` exactly: `node --import tsx --test <file>`, 120s timeout.
- Instrument control **in both directions before trusting it**: exit 0 on
  `test/bot-harness-env.test.mjs`, `test/chat-scroll-intent.test.mjs`,
  `test/config-apply-plan.test.mjs`; exit 1 on `bin/a-commit-per-accepted-push-test.mjs`.
- Every grep returning zero was run again against a symbol known to be present.
- Identity counterfactual: eleven candidates run twice, once with the agent
  environment inherited and once with `TLDA_ENV`, `FLEET_DAEMON_KEY`, `FLEET_ID`,
  `FLEET_NAME`, `FLEET_MINT_ID`, `FLEET_LOCAL_ID`, `FLEET_HARNESS`,
  `FLEET_TMUX_SESSION`, `TLDA_MACHINE_ID` stripped. **None flipped** — which is why
  §11 is *not* identity-dependent and the `suggestions-test` daemon-key mechanism I
  first proposed is wrong, despite the mismatch being really in its log.
- Load recorded before each file. Peaks of 10.77, 11.91, 12.40 while the run was a
  single `node` process; baseline was 5–6 before it started and 6.97 after.

## Three things I got wrong and corrected

1. **Inherited hypothesis: the dominant signature is timeouts on a saturated box.**
   Dead — 54 of 58 fail alone, and 3 of the 4 that pass alone passed at load 7.66–12.40.
2. **`suggestions-test` fails because it leaks `FLEET_DAEMON_KEY`.** The leak is real
   and is not what fails it; stripping the key changes nothing.
3. **`f6d0f9089` was a rogue deletion.** It was Skip's explicit instruction. I found
   the mechanism; chief-opus-2 found the motive and corrected it.
