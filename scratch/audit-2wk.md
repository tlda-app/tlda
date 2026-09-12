# S7 audit rows — `audit-2wk` {#rows}

> **PARTIAL — STOPPED MID-SLICE. This covers 10 of S7's 177 commits.**
>
> Stopped 2026-08-18 ~15:55 EDT on Skip's reprioritisation (*"you need to stop"* /
> *"this is all anyone will do until there is no sync code to fix"*), relayed by `pm-audit`.
> **167 of 177 commits in this slice were never examined.** Do not read this as a survey of
> S7. The ten rows below were each established by running commands and are accurate as of
> `main` tip `6f6a18117`.
>
> **Standing ruling that changes how the rest of S7 should be read if anyone resumes it:**
> Skip's decision makes the old sync path deleted work, so a correct, well-measured fix to
> that path is a **cut by construction** — it should not be graded commit by commit.

**Slice S7:** commit date `2026-08-14T00:00:00-04:00` → `2026-08-17T19:00:00-04:00`, **177 commits**.
Worklist: `scratch/s7-window.txt` (`%h|%cd|%an|%s`, `--date=iso-local`).
Order: **newest first**, so coverage is contiguous with `route-probe-cn`'s S8 boundary at 19:00.

**Shape:** 161 touch code, 16 docs/scratch only. Top authors: `bhief-of-staff` 27,
`sync-control-plane-build` 24, `chiefsoso` 16, `codex-rendering` 12.

## Instrument notes, measured here

- **This checkout is on `fix-bot-launcher-name-race`, not `main`.** A bare `git grep <x>`
  reads the feature branch. My first run of the `mirrorPaused` check returned a positive
  control of 1 site and was wrong for that reason. **Every grep below is `git grep <x> main`.**
  Positive control for the empty results: `git grep -c "no-second-ingester" main -- package.json`
  → `2`.
- **`git log -S <literal> --all` times out** (>2 min) on this repo. Bound it to `main` or to a
  pathspec. `--all` did finish for the single short literal `mirror-paused`.
- `timeout(1)` is not on this box (macOS); `gtimeout` or a pathspec instead.

## Rows 1–10 (newest first)

**All ten were established by running commands. None are inferred from the commit message.**

---

**`216789abf` | Name the mirror of 'look for what broke it', and fix a comment that expired | bhief-of-staff | KEEP**

Doc + code-comment erratum. Judged on whether its assertion is true, and it is.
Claim: `setAgentDaemonRoute` has two call sites in `unified-server.mjs`, neither at mint.

```
$ git grep -n "setAgentDaemonRoute" main -- server/
main:server/unified-server.mjs:6819   (login)
main:server/unified-server.mjs:9470   (agent-route handler)
```

Exactly two non-test call sites, neither at mint — claim holds. Line numbers have drifted from
the 6550/9380 in the message; the substance has not. Erratum comment present at
`server/lib/fleet-store.mjs:3953`.

---

**`7dc160471` | Install the sync-IO guard, and prove the wire | bhief-of-staff | CUT**

Real fix for trash, and the trash was removed 25 minutes later.

```
$ git ls-tree main --name-only bin/ | grep sync-io
(nothing)
$ git log --oneline main -- bin/sync-io-guard.mjs bin/sync-io-guard-test.mjs
02716242a Delete the sync-IO guard: it was blind, and the instrument already existed
7dc160471 Install the sync-IO guard, and prove the wire
4117363f0 Two guards for the class of thing that took the server down
$ git grep -n "TLDA_SYNC_IO_GUARD" main
(nothing)
```

`02716242a` (2026-08-17 19:10:29, **12 min past my window — in S8**) deleted it, measured as
blind: the guard reassigned `fs.readFileSync` on the namespace object, and an ESM named import
binds at instantiation and never sees it. 29 of 35 non-test `server/` modules import by name,
including the file it was written for. `server/lib/lag-profiler.mjs` already did the job.

Nothing on `main` to remove — already gone.

---

**`7b367f71b` | Record that source-conflict-delivery-test is red, and why | bhief-of-staff | CUT**

Doc note that expired within a day. `main` already carries the correction:

```
$ git show main:docs/source-authority-state-machine.md | sed -n '403,407p'
**`bin/source-conflict-delivery-test.mjs` is green as of 2026-08-18.** This
section described it as red since `cf6e30cf0` ... Somebody did that and the
note outlived the repair ... a stale red hides a real one.
```

Accurate when written, false within ~10h. No removal action needed — superseded in place.

---

**`c9e929538` | Remove the edit-history assertion my deletion orphaned | bhief-of-staff | KEEP**

Repairs a test file left importing a module deleted by `4fc9005f0`. Verified clean on `main`:

```
$ git grep -c "edit-events" main -- test/linked-remote-divergence.test.mjs
0
```

The file loads, so its two surviving cases can report. Caught by `bin/test-import-guard.mjs`.

---

**`65ffe50c4` | Run the new guards in lint, and stop counting test files | bhief-of-staff | KEEP (partial)**

Two of its three changes survive on `main`:

```
$ git show main:bin/sync-on-event-loop-guard.mjs | grep -n "IS_TEST\|source-room-daemon"
51:  const IS_TEST = /\.test\.mjs$|-test\.mjs$/
79:  'server/lib/source-room-daemon.mjs': 1,
101:   if (IS_TEST.test(rel)) continue
```

Its lint entry for `sync-io-guard-test` is gone, removed with the guard by `02716242a`.
`no-second-ingester-test.mjs` is in `main`'s `lint` script and runs.

---

**`4117363f0` | Two guards for the class of thing that took the server down | bhief-of-staff | CUT (one half) / KEEP (other half)**

Split, because the commit added two independent files:

- `bin/sync-io-guard.mjs` + test — **CUT.** Absent from `main`, deleted by `02716242a` as blind
  (evidence under `7dc160471`).
- `bin/no-second-ingester-test.mjs` — **KEEP.** On `main` and wired into lint:
  `git show main:package.json | grep '"lint"'` contains `node bin/no-second-ingester-test.mjs`.

---

**`4fc9005f0` | Delete the edit-event attribution log and its projector | bhief-of-staff | KEEP**

A deletion, and it held.

```
$ git ls-tree main --name-only server/lib/ | grep -E "edit-events|edit-activity"
(nothing)
```

`server/lib/source-edit-activity.mjs` on `main` is **not** a re-add: its history runs back
through `Show Markdown source editing in build pill` (`fb7dc3c4e` and later), a separate and
older lineage. Traces to Skip 2026-08-17: *"edit attribution is not important / so rip it the
fuck out"*, *"it was useless junk"*.

---

**`1cda18c10` | Answer source-activity from one indexed row, not the whole history | bhief-of-staff | INERT(live) — severed wire**

Correctly replaced a full synchronous log read with one indexed row. Then the caller was
deleted out from under it and the method was left behind.

```
$ git grep -n "lastSourceFileChange" main
main:server/lib/fleet-store.mjs:487    -- SQL comment: "Serves lastSourceFileChange()"
main:server/lib/fleet-store.mjs:5256   lastSourceFileChange(project, file) {
$ git grep -n "source-activity" main -- server/routes/projects.mjs
(nothing — the route is gone)
$ git show main:server/lib/fleet-store-methods.mjs | grep -n "lastSourceFileChange"
NOT in allowlist
```

**Definition and its SQL index comment, zero callers, and not RPC-exposed** — so it is not
reachable by the indirect route either. Positive control: `git grep -c "activeSourceEditors" main`
returns hits in three files, so the query shape finds live symbols.

On `main` today this is a method nobody calls plus a partial index maintained on writes for a
query nobody runs.

---

**`0fffd2e14` | Tail the edit-event logs instead of re-reading them | bhief-of-staff | CUT**

The literal case of Skip's caution — a correct fix to a path that should not exist.
It optimised `server/lib/edit-events.mjs`; `4fc9005f0` deleted that file ~3h later.

```
$ git log --oneline main -- server/lib/edit-events.mjs | head -2
4fc9005f0 Delete the edit-event attribution log and its projector
0fffd2e14 Tail the edit-event logs instead of re-reading them
```

Its test `bin/edit-events-tail-test.mjs` went with it. Nothing on `main` to remove.

---

**`60bac395d` | Give mirrorPaused its own toggle endpoint | bhief-of-staff | INERT(superseded) — severed wire**

A `PATCH /:name/mirror-paused` route that **no client ever called, for its entire life.**

```
$ git log -S "mirror-paused" --all --oneline
c16e8472a Delete the build-era mirror, and its switch with it
b464e027c Delete the build-era mirror, and its switch with it   (branch twin)
60bac395d Give mirrorPaused its own toggle endpoint
```

Three commits total: the one that added the literal, and the one that removed it (plus its
branch copy). **No caller ever existed** — had there been one, it would appear here as a
fourth. Deleted by `c16e8472a` at 2026-08-18 04:12, 12.5h after it landed.

**CORRECTED — there is no residue. My first version of this paragraph was wrong.**

I reported `mirrorPaused` as surviving on `main` as a live inert lever. It does not.
I had counted two grep hits without reading them; **both are prose saying it is gone.**

```
$ git grep -n "mirrorPaused"          # in the worktree pinned to main
docs/source-authority-state-machine.md:78:  This is why `mirrorPaused` is gone rather than repurposed.
server/lib/build-runner.mjs:1690:      // Deleting it also removes the damage `mirrorPaused` existed to prevent.
$ git grep -n "mirrorPaused" | grep -v '^\S*:[0-9]*: *\(//\|\*\|This\)'
(nothing — no code site)
```

**Zero code uses on `main`.** The lever is fully deleted, not stranded. Nothing to hand S8.

My error was counting sites instead of reading them — the exact move this audit exists to
catch, made by the auditor. Corrected to `pm-audit` and `route-probe-cn` on discovery.

Verdict for `60bac395d` is unchanged: `INERT(superseded)`, and the evidence for *that* was
re-run independently by `pm-audit` and held.

---

## Tally so far

| verdict | count |
|---|---|
| KEEP | 4 (one partial, one split) |
| CUT | 4 (one split) |
| INERT(live) | 1 |
| INERT(superseded) | 1 |
| UNESTABLISHED | 0 |

**`INERT(live)`** = on `main` today and cannot act — the row Skip most wants.
**`INERT(superseded)`** = was inert, code already gone; nothing to remove. When a superseded
row leaves a **residue** on `main`, the residue gets its own row, because that is where the
live defect is.

`4117363f0` is counted in both KEEP and CUT because it added two independent files with
opposite fates; it is one commit, listed once above.

## UNESTABLISHED

None among the ten rows above.

## In flight when stopped — facts, NOT rows

Commits 11–25 were being worked when the stop came. **None of these are verdicts** and none
should be counted. Recorded only so the commands do not have to be re-run.

- **`bin/source-manifest-contract-test.mjs` FAILS on `main`** (`6f6a18117`), and this one is
  worth someone's attention independently of the audit. `AssertionError`, `deepStrictEqual`:
  the expected `.source-lifecycle/git/refs/tlda/source/latex-project` ref is
  `d1c45b70…` and actual is `7a8cb4a7…`, with three extra git objects present. Run:
  `cd <worktree> && node bin/source-manifest-contract-test.mjs`.
- Green on `main`, run directly: `bin/mirror-timeout-budget-test.mjs`
  (`attempt 60000 < total 150000 < fan-out 180000 < worker 240000`),
  `bin/shadow-mirror-fanout-deadline-test.mjs`, `bin/source-sync-selfheal-test.mjs`.
- **`1c0ba3aff` retry fix is wired on `main`** — `unified-server.mjs:1535` passes
  `attemptTimeoutMs: MIRROR_ATTEMPT_TIMEOUT_MS` and the sender consumes it at `:1413`.
  Constants at `:1529–1530` are 60000/150000, re-sized later by `316b19f67`.
- **`6bd604eeb` wire is intact end to end** — `roomResidency()` (`sync-rooms.mjs:432`) →
  `unified-server.mjs:4269` → served by `GET /api/runtime-status` (`:4260`).
- **`950a922e2` holds** — zero conflict markers in `fleet-store.mjs` and none repo-wide in
  `*.mjs`/`*.ts`/`*.tsx`. Positive control: the grep pattern matches a synthetic marker.
- `b3f6b88d1` added the `mirrorPaused` lever (26 lines, `build-runner.mjs`); it and its
  setter route `60bac395d` are both gone from `main`. Pair reads **CUT** /
  **INERT(superseded)**, but that verdict was not finished.

## Method notes for a successor

- Work in `/Users/skip/worktrees/audit-2wk-main`, detached at `main` tip `6f6a18117`, with
  `node_modules` symlinked from the shared checkout. **Bare greps there read `main`**, which
  removes the wrong-ref error class structurally. The shared checkout at
  `/Users/skip/work/tlda` sits on `fix-bot-launcher-name-race`.
- **Read every grep hit before it becomes a row.** I counted two `mirrorPaused` hits without
  reading them and reported a live inert lever that does not exist. Both were prose.
