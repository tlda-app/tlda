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

## The one process lesson worth carrying

Three false zeros tonight: `roster(cwd:)`, which is empty for every agent; a
search returning `0 session` rows from the path that was broken; and a binding
filter testing truthiness against explicit nulls. The rule that covers all three
is already in `AGENTS.md` — *a zero from a failing command is indistinguishable
from a zero from a working one* — and it is not missing, it is reached for too
late. **Run the control before believing a zero, not after being contradicted.**
The second of those was believed against Skip's direct report, which is the
expensive version.
