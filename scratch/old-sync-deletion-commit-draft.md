# Deletion commit — prepared, NOT landed {#draft}

> # ⚠ OBSOLETED — READ THE DESIGN FIRST
>
> **Obsoleted by the design at `7050929a1`, §2.4. The gate below predates the
> removal of `sourceManifest`. Read the design before you read anything here.**
>
> The design deletes `sourceManifest` outright — the tree *is* the manifest, so
> there is no second description of membership that can disagree with the bytes.
> **That takes `carryForward`, `GET /source-entries`, and all 18 caller
> migrations with it**, so **gate items 1, 5, 6 and 8 below describe checks
> against machinery the design removes.** They are not a to-do list.
>
> **This notice exists because the header underneath it says to trust this file.**
> A stale document with no header is a document someone evaluates; a stale one
> that opens with *"this is where the next session writes from"* is a false
> instruction, and the header is what converts it. That shape cost this project
> real time the night this was written.
>
> **What is still good here:** the ordering argument (callers → route → daemons
> updated *and restarted* → the WS `source-change` handler last, because it
> receives what the daemon cutover stopped sending), and the reasoning about
> what a gate is for. **`old-sync-deletion-sweep.sh` beside this file is
> unaffected** — it is URL-anchored and helper-agnostic, and its two lessons are
> design-independent: a control absent from the ref being swept proves nothing,
> and a grep finds a call that is present, never one that is missing.
>
> **Do not build from `fix-bot-launcher-name-race`** — measured 180 commits
> behind `main`, and it does not contain `server/lib/source-git-store.mjs` at
> all. Build from `main`.

> **What this file is: a resumption point, not a report.** It is where the next
> session writes the deletion commit from. Its companion
> `old-sync-deletion-sweep.sh` is the instrument that fills it.
>
> **Every number in it is `<<FILL>>` on purpose. Do not treat the blanks as
> incomplete work and do not populate them from this file's own history.** A
> draft carrying real-looking numbers reads as current to whoever opens it next,
> however old it is — that is the failure this whole night kept paying for, and
> the blanks are the fix. Fill them from a sweep run **at the moment you write
> the commit**, against `main` as it then stands.
>
> **Concrete evidence that this is not a precaution.** During the single session
> that wrote this file, `main` moved twice: the sweep read `5338b1c32` at 16:32
> and `d7f6dfed0` at 17:47, about an hour apart. **Any number recalled from that
> session — from memory, from the chat thread, or from this file's own git
> history — already describes a tree that no longer exists.** That is why these
> are blanks rather than figures with a timestamp beside them.
>
> **Both files are force-added past `.gitignore`.** `scratch/` is ignored and
> that rule is right for reports — things recording what was already
> established. These two are neither: nothing else can reconstruct them, and
> losing them means re-deriving the sweep and re-learning its two hard-won
> properties (a control absent from the swept ref proves nothing; a grep finds a
> call that is present, never one that is missing). Do not "tidy" them out of
> the tree on the grounds that `scratch/` should not be tracked.

Owner: `audit-2wk`. Held until `pm-sync` says land.

**The reasoning below is settled. Every number is deliberately blank**, marked
`<<FILL>>`, and gets filled from `sh scratch/old-sync-deletion-sweep.sh main` run
**at the moment the commit is written**. A sweep from an hour ago is a claim about
an hour ago, and this file existing is not evidence any of it is still true.

## Gate — all must hold on the MERGED tree, not on the branch where each was fixed

1. Every caller migrated; sweep clean, control non-empty.
   - 13 CLI (`audit-2wk`, branch `cli-json-carrier`) — done, unmerged
   - 4 browser (`read-one-grammar`) — done, unmerged
   - **1 MCP (`read-one-grammar`)** — `mcp-server/source-push-orchestration.mjs:12`, found by the sweep
   - in-process: `source-room-daemon.mjs:334`, `overleaf-sync.mjs:520`
2. Tests repointed, **not deleted** — 16 move, and **nine quote Skip in their headers**.
   Those are the specification of what sync owes him; the mechanism dies, the promise does not.
3. The one server boot has crossed the mounted router.
4. **Both stop-the-line fixes present on the merged tree** — the working-copy-plus-manifest
   write, and the ref-not-outrunning-its-record change. *Merged* and *fixed* are different facts.
5. Envelope field check re-run against the merged file; `source-entries` still `{path, sha256, size}`.
6. Response-consumption check re-run: does any caller read a field out of the reply that
   shapes a later request?
7. `tsc -b` once, no `--force`.

**Do not land it because the night is ending.** `chief-night` ruled: if anything outstanding
outgrows the rest, the deletion **waits**. It does not get split into delete-now-restore-later.
A half-stripped path with the old one gone is worse than an unstripped one.

## Ordering — the last step is not code

`callers → route → daemons updated and RESTARTED → the WS source-change handler`

`unified-server.mjs:9740` is the **receiving end of what the daemon cutover stopped sending**.
Delete it while any daemon still runs old code and that daemon's messages are accepted and
silently do nothing — a severed wire reporting health, which this repo has shipped three times.

Measured, and it is two checkouts rather than an abstraction:

| checkout | branch | `createSourcePush` | `sendSourceChange` |
|---|---|---|---|
| `/Users/skip/work/tlda` | `<<FILL>>` | `<<FILL>>` | `<<FILL>>` |
| `/Users/skip/worktrees/daemon-testing` | `<<FILL>>` | `<<FILL>>` | `<<FILL>>` |

A checkout having the code is not the running daemon having loaded it — a long-lived process
keeps the old module until restarted. **The WS handler is its own later commit, explicitly last.**

---

## Draft message

```
Delete the old source push path

Nothing calls it. <<FILL: N>> HTTP callers and <<FILL: N>> in-process
callers moved to the JSON snapshot carrier and the bundle carrier over
the preceding commits; this removes what they used to reach.

Out: processProjectPush, processProjectPushSerialized, persistSnapshot's
snapshot write, the POST /:name/push route, and PUT /:name/source/:file.

NOT out, and a reader of this diffstat should not have to work it out:
the effect functions MOVED to the new path rather than being deleted.
The mirror, the build dispatch and the rest of the six-now-seven
post-accept effects are the preservation machinery -- they are what makes
an accept reach the author's disk -- and they run from
applyAcceptedSourceEffects on the accept path now. A diffstat this size
with `mirror` in it invites the opposite reading.

sourceFileBatches goes here too, with the test and the doc line that
reference it. It went dead to production when the CLI's batch loop
collapsed into one atomic snapshot; it was left in place then because it
is exported and had a test and a doc outside that column, and this is the
commit that owns all three.

Verified before writing, not inherited from a plan:
  sh scratch/old-sync-deletion-sweep.sh main
  control (sourceLifecycleStore)  <<FILL>>
  URL-anchored /push callers      <<FILL>>
  PUT /source/:file callers       <<FILL>>
  processProjectPush references   <<FILL>>

The sweep is URL-anchored rather than helper-anchored because this
codebase reaches HTTP four different ways -- api(), apiAt(),
dev-worktree's local post(), and mcp-server's serverFetch -- and a sweep
anchored on any one of them undercounts. Three callers were invisible to
the plan for the first two hours of this work, and the eighteenth was
found by the sweep itself after the inventory was believed complete.

The WS source-change handler at unified-server.mjs:9740 is NOT in this
commit. It is the receiving end of what the daemon cutover stopped
sending, so it cannot go until every daemon runs the new code and has
been restarted -- delete it sooner and an old daemon's messages are
accepted and silently do nothing, which is a severed wire reporting
health. It follows in its own commit.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

## One line to place once the fact is confirmed at write time

The CLI is immune to the stale-precondition class by construction — every
`expectedRevision` there comes from a fresh `GET /:name/source-authority` rather than
being threaded out of a push response — so the fix caller 17 needed has no counterpart
in `cli/`. **Worth a line only if the re-run still shows it.**
