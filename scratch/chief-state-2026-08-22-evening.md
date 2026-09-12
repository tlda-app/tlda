# Chief state — 2026-08-22, 17:5x EDT

Written by `chief-opus-2`, who took the seat from `chief-opus` at ~14:0x on Skip's
instruction. **As of now**, re-checked against `main` and the deployed sha at the
moment of writing rather than carried forward.

**Deployed: `027d5d940`. `main`: `c17900ba3`, 26 ahead.** Nothing pushed, nothing
deployed, nothing restarted, no journal row or stamp on any box touched.

## The two things that are Skip's and nobody should decide for him

**1. Do the 26 commits go to testing?** The code delta is small — `Dockerfile.live`,
`unified-server.mjs`, both fleet-store files, the MCP tools, four test files.
Everything else is documentation. The one with consequence is `89b40ac0f`, the
`COPY` without which the session-history index does not survive a rebuild; that
index currently exists **only on the running machine**. The check after any deploy
is *does `idx_session_entries_ts` exist on the box* — not whether the deploy
reported success, because the builder is fire-and-forget and fails silently.

**2. When the daemon's remedy does not fix the condition, does it keep trying or
stop and report?** See §"the live loop" below. This decides whether step 5 needs a
bound before it ever runs unattended.

## Branches — none merged, all real

| branch | tip | what |
|---|---|---|
| `notification-reliability-amend-and-cache` | `3800ce867` | Part 3 steps 7, 1, 2, 3, 4, 5 — the whole notification design through the deletion. Step 6 deliberately unbuilt. |
| `acceptseq-not-a-queue-row-id` | `28cc281b9` | 6 commits: publication and sentinel ordered by ancestry, `build.stamp` restored to an mtime, two findings written up |
| `route-binding-behavioural-test` | `880bc3aee` | login writes the daemon route and neither register nor login drops it; counterfactual re-runnable via `TLDA_TEST_SERVER_ENTRY` |
| `suite-matcher-drift-repair` | `1ea771336` | three test matchers repointed at renamed identifiers, no behaviour change |
| dev-bot `devbot-buildstatus-premise` | `6aefa72`, `b301fda` | in `~/work/tlda-bots/dev`: delete the false check; landing procedure |

**Already on `main` by cherry-pick, so an ancestry check calls them unmerged and is
wrong** — check by file, not by `merge-base`: `docs/what-sync-owes.md` and
`scratch/sync-spec-code-claims-audit.md`.

## The live loop, measured — this is the finding of the day

`~/.config/tlda/fleet-daemon.testing.log`, positive controls run first:

```
[daemon] wake notify result for fleet:dev: ok=false via=none reason=terminal-not-ready
[daemon] wake fallback for fleet:dev after notification failure:
         channel=mcp reason=mcp-ack-timeout deadline_ms=2000
```

**1,839 fallbacks since 2026-08-20T22:08Z. 1,500 of them one agent — `dev` — every
~92 seconds, still firing.** Reasons: 1,650 `mcp-ack-timeout`, 1,534
`terminal-not-ready`, 189 `no-open-mcp-socket`.

So: the notification fails on a 2000ms deadline that is **below the MCP's own serial
worst case** (deliver ≤1000 + ack ≤1000), the sideband then fails too, and **nothing
counts either.** The wake breaker does not apply, for two independent reasons found
in the code: the symptom is reported one line *before* the breaker is consulted, and
the breaker only increments when the wake **throws** — a remedy that succeeds and
achieves nothing is invisible to a brake that counts failures.

`dev` is the bot that reclaims disk on this box.

## What sync owes — recovered, and the state of the tests

`docs/what-sync-owes.md` on `main`: the sixteen promises recovered from deleted test
headers, twelve recovered and four inferred and marked, Skip's words verbatim, no
project named. It is **acceptance criteria, not a description of the code.**

**Zero of those sixteen are currently verified.** Twelve of the origin files were
deleted; all four survivors are in the cannot-start group.

## The suite, triaged

**58 red. 54 fail alone at concurrency 1** — the suite's own contention explains 4,
and even those passed at load 7.66–12.40, so it is inter-file contention and not
machine load. **Twenty-three assert nothing about the code**: 15 cannot start, 1
cannot evaluate its own assertions, 3 pin a renamed identifier, 2 measure the shell,
1 says its fixture was not capable, 1 walks a directory. **14 carry real evidence.**

**`~/.claude/bin` is first on every agent's PATH and shadows the TeX toolchain**, so
an agent and a human running the same suite on the same tree get different answers.
Every measurement taken today went through that shim.

## Three deletions with the same signature

`f6d0f9089` (8,421 deletions, sync lifecycle), `4cdbb55b8` (server-owned agent seat
authority, dropped seven columns), and the one that removed `mirrorAcceptedRevision`.
Each removed a subsystem, **left its tests behind**, and **shipped with no commit
message body.** The tests then read as defects for weeks. `f6d0f9089` was Skip's
explicit instruction — check his 2026-08-20 thread before calling any of it rogue.

## An agent can come up mute, and it looks identical to being ignored

A minted agent parked at the `--dangerously-load-development-channels` confirmation
prompt never finishes MCP startup: awake, receiving `📬`, unable to call `inbox()` or
`chat()`. **Recovery is `tlda-dev restart-mcp <name>` followed by
`tmux send-keys -t fleet-<name> Enter`** — the restart alone lands at the same prompt.
Diagnose by reading the pane; the agent usually diagnoses itself there.

This bit two agents today, one of them the author of this file.

## Running

A read-only heap watch on Skip's live tab, `~/.config/tlda/heap-watch.tsv`, one
sample a minute. **Deliberately not in a session scratchpad** — the previous one died
with its session. The earlier five-hour "no leak" result was taken against an idle tab
(`nodes` 1941 on all 123 samples, `documents` 2); the current tab has a project open
and `nodes` varies, which is the condition he actually reported. **A flat floor under
rising peaks is reclamation working, not a leak. Check `nodes` first.**
