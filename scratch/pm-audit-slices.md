# Auditor slice brief — the August keep/cut audit {#slices}

`pm-audit` (`fleet:a1d60fdd`) is your manager. Report to me. **Send nothing to Skip.**

## Read the spec yourself

`scratch/august-audit-brief.md` is the spec — Skip's own words, the four inertness
patterns, the per-commit test, and the output format. **Read that file.** This file is
not a summary of it and does not replace it. What is here is only the partition and the
instrument corrections I measured tonight.

## Instrument corrections — read these before you run a single query

Three ways the obvious command lies. All three are measured on this box, not inferred.

**1. `git log --since='2026-08-01'` is not midnight.** Git's approxidate fills the
unspecified time-of-day from *now*, so a bare date means *that date at the current clock
time* — and the answer drifts as the night goes on. Measured at 15:22 EDT:

```
$ git log --oneline main --since='2026-08-01' | wc -l
1231
$ git log --oneline main --since='2026-08-01T15:22:09-04:00' | wc -l
1231          # identical — the bare form silently means this
$ git log --oneline main --since='2026-08-01T00:00:00-04:00' | wc -l
1282
```

**The corpus is 1,282, not 1,231.** The 1,231 figure in circulation drops 51 commits from
the morning of Aug 1. **Always pass an explicit time and offset.** Every boundary in the
partition below is written that way; use them verbatim.

**2. `--since`/`--until` filter on COMMIT date; `%ad` prints AUTHOR date.** `main` is
assembled by cherry-pick, so the two differ by up to a day and a half. Three of the 64
tier-1 commits display an author date outside their own window:

```
$ git log --format='%h a=%ad c=%cd' --date=iso-local main --since='2026-08-17T19:00:00-04:00'
2729fba99  a=2026-08-17 03:08:13 -0400  c=2026-08-18 07:26:19 -0400
```

**Print `%cd`, not `%ad`,** or your rows will disagree with your own slice boundary.

**3. Author name is the agent; committer is always `t`.** The author email carries the
fleet id — `actual-versioning <fleet:7c99dc14@fleet.local>` — and that is the reliable
identifier. `%cn` is the cherry-picker and tells you nothing. Commits also record
`(cherry picked from commit <sha>)`, which is the original branch sha.

**And the standing rule that produced all three: a zero needs a positive control.** Run
the same query against something you know is there before you report absence. Every zero
in this file has one.

## The partition — commit date, explicit offsets, no gaps, no overlap

| slice | window (commit date) | commits | owner |
|---|---|---|---|
| S1 | `2026-08-01T00:00:00-04:00` → `2026-08-04T00:00:00-04:00` | 156 | |
| S2 | `2026-08-04T00:00:00-04:00` → `2026-08-08T00:00:00-04:00` | 157 | |
| S3 | `2026-08-08T00:00:00-04:00` → `2026-08-10T00:00:00-04:00` | 193 | |
| S4 | `2026-08-10T00:00:00-04:00` → `2026-08-12T00:00:00-04:00` | 162 | |
| S5 | `2026-08-12T00:00:00-04:00` → `2026-08-13T00:00:00-04:00` | 163 | |
| S6 | `2026-08-13T00:00:00-04:00` → `2026-08-14T00:00:00-04:00` | 210 | |
| S7 | `2026-08-14T00:00:00-04:00` → `2026-08-17T19:00:00-04:00` | 177 | `audit-2wk` |
| S8 | `2026-08-17T19:00:00-04:00` → open | 64 | `route-probe-cn` |

156+157+193+162+163+210+177+64 = **1,282**. The slices tile the corpus exactly.

Your command, with your own two boundaries substituted:

```sh
git log --format='%h|%cd|%an|%s' --date=iso-local main \
  --since='<START>' --until='<END>'
```

For S8 (open-ended), drop `--until`.

## Corpus shape, so you know what you are holding

- **966 of the 1,282 touch code**; **316 are docs/scratch/`*.md` only.** A doc-only commit
  cannot be INERT in the wire sense — but guidance that misdescribes the system is a live
  defect in this repo, so judge it on whether what it asserts is true, not on whether it runs.
- **250 distinct agent identities** authored the corpus.

## Prior work you may credit, and its limits

`scratch/commit-review-unified-server.md` (808 lines, last written 2026-08-17 18:49)
carries verdicts over the 144 August commits touching `server/unified-server.mjs`:
KEEP 86 / CUT 31 / UNSURE 20 / merge 7.

`audit-2wk` checked it against the tier-1 list: **0 of 64 overlap**, so it credits nothing
against S8. Two limits, from reading it rather than its summary:

- Its 20 `UNSURE` rows are **unestablished** by our standard. Re-check them; do not import them.
- It is **scoped to one file.** A commit touching `unified-server.mjs` and four other things
  was judged there on that file alone.

Treat it as a starting point to re-check, never as rows to paste.

## What a finished row is

```
sha | subject | author | KEEP / CUT / INERT | evidence
```

**Evidence is a command and its output, or a file and line.** Not a reading, not a
judgement, not a restatement of the commit message. `INERT` names which of the four
patterns in the spec it is.

### Split `INERT` by whether it is still on `main`

The deliverable is *what to retain*, so a row is only actionable if the thing it describes
still exists. Mark every `INERT` one of two ways:

- **`INERT(live)`** — the change is on `main` **today** and cannot act. This is the row Skip
  most wants and the one someone can act on.
- **`INERT(superseded)`** — it was inert and its code is **already gone** from `main`. There
  is nothing left to remove. Note it and move on; do not spend a full investigation on it.

**But check what it left behind, because that is often the live defect.** `60bac395d` added
`PATCH /:name/mirror-paused`, no client ever called it, and `c16e8472a` later deleted the
route — so the commit is `INERT(superseded)`. The **residue is live**: `mirrorPaused`
survives on `main` in `build-runner.mjs` and `docs/source-authority-state-machine.md` with no
route left that can ever set it. Verified independently:

```
$ git log -S 'mirror-paused' --oneline --all
c16e8472a  Delete the build-era mirror, and its switch with it
b464e027c  Delete the build-era mirror, and its switch with it     # branch twin
60bac395d  Give mirrorPaused its own toggle endpoint
$ git grep -l -F 'mirrorPaused' main
main:docs/source-authority-state-machine.md
main:server/lib/build-runner.mjs
```

Exactly three commits — one adds, one deletes, one twin. **A caller would have been a
fourth.** When a superseded row leaves a residue like this, **write the residue as its own
row against the commit that created it**, which is where an actor can find it.

**How common is the superseded class: not established.** I measured only the crude proxy —
every code file a commit touched being deleted from `main` — which is 2 of 120 sampled in S7.
That does not measure the `mirrorPaused` shape, where the file survives and the route inside
it is gone. Treat the split as worth marking, not as a frequency claim.

**Default cut when unproven** — Skip's instruction, not a tiebreak.

**A row you could not establish goes in a separate `UNESTABLISHED` list**, never mixed in
with the rest. Half a list that reads as complete is worse than a short one, because it
gets acted on.

## Writing and reporting

Write rows to `scratch/audit-<your-name>.md` **as you finish them**, not at the end — a
working directory is one `rm` from gone. Report to me in batches of ~25 rows with the file
path, not per commit. Tell me your real rate after your first 10 so I can re-cut if a slice
is too big.

If a slice turns out to be the wrong size, say so — that is my problem to fix, not yours to
absorb by guessing.
