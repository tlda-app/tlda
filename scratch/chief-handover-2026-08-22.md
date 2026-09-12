# Chief handover — 2026-08-22, ~09:35 EDT

Written against: testing serving `027d5d940`; local `main` at `3e364c17d`, four
commits ahead of it (docs, a test anchoring fix, a Dockerfile `COPY`, and the
`AGENTS.md` restore). Skip worked until ~07:30 and is asleep.

## Live state you can act on

**Search is fixed on the live box but not in the image.** The index
`idx_session_entries_ts` was built by hand at 09:03 — 24.8 s cold → 1.3 ms, lock
held 1.04 s, same 100 rows in the same order before and after. `89b40ac0f` adds
the missing `COPY bin/build-session-history-index.mjs` to `Dockerfile.live`.
**Until that deploys, the index exists only on the running machine.** A fresh
volume or a rebuilt image is back to 25 s with no builder present to fix it.

**Standing check after the next deploy, and it is not "did the deploy succeed":**
does `idx_session_entries_ts` exist on the box. The builder is spawned
fire-and-forget so its failure is silent by design — that is how a deployed fix
sat inert for six hours while every health surface read green.

## Two caveats that will evaporate if nobody writes them down

**The binding check is a snapshot, not a history.** At 09:30 there were 118
source bindings across testing/stable/pic; 13 carry `kind`/`remote`/`mirrorMode`
and all three are null on every one; **none carries a `branch` field**. That
establishes the branch-drop defect is not currently reaching anything on this
box, because `git-sync-manager.mjs:105` builds no remote bridge when `remote` is
null. **It says nothing about what was bound last week.** Nobody has looked, and
the next reader will assume this covered all time unless told otherwise.

**"No caller" findings were established at `027d5d940` only.** The severed accept
mirror and the unwired remote bridge are both real at that sha. Neither has been
traced through the full history, and one attempt to do so produced a false
causal table by reading cherry-picked branch tips as a sequence.

## Open, and Skip's rather than anyone else's

- **`AGENTS.md` still has five sections whose bodies differ between `main` and
  `app-librarian-missing-main-preflight`** — Documentation boundaries, Repository
  workflow, Prove the wire, `main` is assembled by cherry-pick, A renamed mint and
  an inert bot. `3e364c17d` took the 20 disjoint sections as a union and
  deliberately left these five alone. Both versions exist; choosing is his.
- **Whether the accept mirror comes back, and where.** Scoped, argued, not built.
  The argument against the build path is measured and still in the code.
- **Whether an `app-dev` agent may read `/api/build-info`.** Three agents were
  blocked tonight. The fence returns *empty* rather than refusing, so a blocked
  agent reads it as the box being down.
- **Deploy authority** for the notification branch and the `COPY` fix.

## `npm test` leaves servers running, and that poisons every later run

Running the full suite on 2026-08-22 left a `server/unified-server.mjs
--i-am-tlda-cli` alive at **69.6% CPU, eleven minutes old, holding its port**,
while box load went 5.07 → 7.96 and live store writes stalled past 120 s. A
second stray of the same shape, at 89% CPU and two days old, was killed at 06:00
the same morning.

**This is a mechanism, not a nuisance.** A suite that orphans servers means every
subsequent run — and every gate anyone builds on it — is measured against a box
that already has a server on it. That is the likeliest reason nobody trusts this
suite, and it is fixable.

**It also invalidated my own measurement, which is the warning.** That run
reported ~60 failing files; I then "controlled" them against the deployed sha in
a worktree **while the orphan was still up**, and reported 7 of 8 as pre-existing.
Two contaminated readings compared with each other. **The 60 is not established
and neither is the control.** A clean-box run — no orphans, quiet fleet, one pass
— is the cheapest thing that would settle either.

## Git notes do not travel, so they are a convenience and not a record

Two commits on `main` — `afbf452f9` and `d60d18573` — carry notes correcting
statements in their own messages that have since decayed. **`refs/notes/commits`
is not pushed and does not travel on clone, fetch or pull without explicit
refspec configuration.** So a reader in any other checkout sees the decayed
messages and no note.

The durable versions are in the tree and do travel: `docs/naming-errata.md`, and
the docstring at the head of `bin/a-conflicted-checkout-reports-synced-test.mjs`
naming the three shas. **Treat the notes as a courtesy to whoever reads on this
box; treat the committed prose as the record.**

**And the generalisation, which is the better half:** *preservation is a
reference, not an instruction.* "Do not delete this branch" is a prohibition on a
future action, and the commit it protected was already unreachable while that
sentence was being written. **A rule about what people must not do cannot protect
something no ref points at — only a ref can.** Same shape as `dead` being a flag
somebody sets rather than a state inferred: the guarantee has to be represented,
not observed. That is why `4821035a1` survives — it was tagged before it was
discussed.

## 157 open tasks, and seven of them are addressed to Skip

Counted 2026-08-22: **157 open tasks**, the large majority stale against
hibernating agents — 30 to 165 hours old, several duplicated across seats
("Manage tlda app priorities" appears three times against three different
agents from the same hour).

**Seven are assigned to `fleet:skip` and have been pending 165 hours**: choose
Homework 0 guidance location, review course development publication flow, choose
LMS assignment delivery, review Part 1 / Part 2 course sequence, review
enrichment breather, and a classroom scope update. **Each is a decision somebody
put in his queue and nobody has pursued in a week.** That is the database form of
the thing `AGENTS.md` forbids in a status list — a row that records him as the
holdup for something never actually put to him.

**Do not mass-close or delete any of this.** The tool's own advice is
"delete/archive/redelegate", and hard-deleting task rows is a recorded defect in
this repo, not a cleanup — `success_criteria`, `blocked_by`, `metadata` and the
timestamps have no other copy. Whatever the remedy is, it is marking, not
removal, and it is a decision rather than a chore.

**Left as a finding.** It is not one of the three things he asked for, and
starting a 157-row triage instead of them would be the substitution this file
already warns about twice.

## Memory leak: five hours measured, no leak found — in the wrong condition

Skip reported a frontend memory leak. Read-only CDP against his own tab,
**123 samples over five hours, zero unreachable**:

```
quarter   listeners min   median    max      heapUsed min   median
Q1                 1087     3384   7422              16.9     19.5
Q4                 1087     4764   9333              17.7     22.0
```

**The floor does not rise.** The listener minimum is 1087 in the first quarter
and 1087 in the last, recurring as late as 16:31 — and the heap floor is flat at
~17 MB throughout. Medians and peaks climb; the baseline does not. **Everything
allocated is being reclaimed, which is the opposite of a leak** — a leak has a
rising floor, and this has a flat floor under growing peaks.

**The growing peaks are still real** and are consistent with the per-agent
`dangerouslySetInnerHTML` teardown: listener churn between roughly 1,100 and
9,300 with the DOM completely static.

**And the caveat that matters more than the result: `nodes` was 1941 on all 123
samples and `documents` was 2.** The DOM never changed, so his tab sat idle at
the root with no project open for the entire window. **This is a firm negative
about a condition that is not the one he reported it in.** Treat it as "not
reproduced idle", never as "there is no leak" — it is one measurement away from
being a rigorous result about nobody.

**A second watch was started and has since been killed — nothing is watching
now.** The rig is `heap-watch.mjs` in this session's scratchpad: read-only CDP
over the `air-agent` tunnel on `localhost:9223`, re-resolving the tab each sample
so it survives reloads. Run it during a session in which he is actually working;
an idle tab produces the clean negative above and settles nothing.

**Do not read a flat result from an idle tab as "no leak."** Check `nodes` first —
if it is constant across every sample, the page never did anything and the
measurement is about a condition he did not report.

## The one process lesson worth carrying

Three false zeros tonight: `roster(cwd:)`, which is empty for every agent; a
search returning `0 session` rows from the path that was broken; and a binding
filter testing truthiness against explicit nulls. The rule that covers all three
is already in `AGENTS.md` — *a zero from a failing command is indistinguishable
from a zero from a working one* — and it is not missing, it is reached for too
late. **Run the control before believing a zero, not after being contradicted.**
The second of those was believed against Skip's direct report, which is the
expensive version.
