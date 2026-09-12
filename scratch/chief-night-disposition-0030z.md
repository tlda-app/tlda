# Disposition, `chief-night`, 2026-08-19 00:30Z {#disposition}

**Re-check every row against the machine before acting on it.** This is a statement about
00:30Z and nothing in it says so on its own. Deployed sha at time of writing: `c8103d849`,
with `5f68565d2` (layout) mid-deploy. Times UTC unless marked EDT.

## Done and verified tonight

**Delivery is fixed. The outbox reached zero.**

| | before | after `89e18f431` | after `c8103d849` |
|---|---|---|---|
| delivered/min | 84 | 57 | 2,430 |
| produced/min | 104 | 13 | 35 |
| depth | 8,900 | 8,850 | **0** |

Measured by set-differencing row ids across 60s, not by watching depth — depth cannot
distinguish "nothing delivered" from "delivery below production", and reading it as the
former was one of three retracted claims tonight.

**Root cause, and it is not a regression.** `c2a8fb46b` (2026-07-14) put `activity-health`
into `DURABLE_TYPES` in `daemon/delivery-policy.mjs`. A heartbeat got a disk write, a
delivery slot, an ack and a retry budget for five weeks. It surfaced now because enough
agents work concurrently to exceed what the transport delivers. **Skip named the decision
before anyone found the commit.**

**Minting works.** Verified twice from the mint's own stdout — `Server registration joined`,
`Route published`, no `ABANDONED`. Not from an exit code: an earlier "exit 0" mint was
`env: timeout: No such file or directory` and had never run.

**Layout for the 2026-08-19 1pm meeting** — six commits on `chief-release`, rebased onto
`c8103d849`, `tsc -b` real exit 0 with empty output. Deploying as `5f68565d2`.

## Running now

**The four-stage sync design, on Skip's instruction: *"make it happen immediately."***

| stage | who | state |
|---|---|---|
| design | `git-protocol-design` `fleet:38a16edd` | minted, seated, briefed, acknowledged |
| design review | `git-protocol-review` `fleet:80703182` | minted, seated, briefed, acknowledged |
| implementation | `pm-sync` `fleet:55e4fc9d` | after review |
| implementation checked against design | unassigned | place when a design exists |

**His design, his words** — the brief carries them verbatim and so should any successor:
declared docs (`.tex`/`.md`/`.qmd`), no root/extra distinction, membership as the transitive
closure over declared docs, a filtered branch applied onto the working copy, *"i am not
debugging two versions of this feature"*, and idempotence as a first-class goal.

**The fact that reshapes it, from him at 00:2xZ:** users almost never commit, so there is
almost never a user commit behind a project commit. We are not mirroring history, we are
**constructing** it from the working copy — which removes the correspondence problem and
makes the project commit a pure function of (declared docs, bytes on disk).

## Open, with owners

- **`pm-sync`'s dossier** — ten gaps in the replacement work, two of them introduced by fixes
  for earlier gaps, cost figures, and eleven instruments that answered about the wrong thing.
  Being written tonight; it is the empirical input to stage 1.
- **The hard gate**: the new accept path never writes the server's plain working copy.
  Nothing deletes while it stands.
- **`22fb6182b`** — *"Make LaTeX membership the closure of the document's roots"* — landed and
  was reverted the same day by `e9c3ba890`. **Nobody has established why.** `git-protocol-review`
  is on it. A design re-proposing closure membership is not reviewable until this is answered.
- **`survival` is stuck and Skip declined to discuss it tonight** — *"whatever i dont want to
  talk about survival."* Do not raise it with him again without new information. The finding,
  with a working positive control: the server holds every `.tex` (`arXiv_v2.tex`,
  `cover-letter.tex`, `math_commands.tex` all 200) and **none of the figures** (12 of 12
  sampled 404) while its own manifest declares them, so every push is refused as
  `nonexistent authored file`. Deadlocked: the server will not accept while its declared set
  names files it lacks, and the daemon will not send files that have not changed locally.
- **`talk-opening`** — two refusals, cause not established.

## Method notes that cost real time tonight

**Three causal claims, three retractions, one shape:** reading a bounded, aggregated or
derived observable and reporting the primitive underneath it. **Depth is not throughput. A
log tail is not a history. A count is not a cost.** Every discriminating command took under
a minute and was run after the claim went out rather than before.

**Two false greens caught by reading output instead of exit codes**, both the class this repo
keeps paying for:

- `npx tsc -b … | tail; echo EXIT=${PIPESTATUS[0]}` — **`PIPESTATUS` is empty in zsh**, so
  `EXIT=` printed and the wrapper reported success. Use `cmd > file 2>&1; echo $?`.
- `git merge --ff-only chief-release` run in `/Users/skip/work/tlda` targeted
  **`fix-bot-launcher-name-race`**, because the shared checkout is not on `main`. It printed
  `fatal: Not possible to fast-forward` and the wrapper still reported exit 0.

**A rotated log manufactures an onset.** `fleet-daemon.testing.log` rotates at ~356 MB, about
four hours. `head -1` on it, before treating the top of the file as the beginning of a
phenomenon.
