# Landed or parked: the work that existed only on pic-preview {#report}

**As of `main` = `3290d8e4d`, which I fast-forwarded from `71441e317`.** Nothing deployed;
pic-preview untouched; the three authors not woken.

**Six of the seven are on `main`. One is parked, because it reverses a rule of Skip's that
`main` still advertises to students.**

## Two corrections to the brief

**The tip is not unlanded.** `f7dda0562` "Serve Quarto directory index routes" is already on
`main` under another sha — `git cherry` marks it `-`. So are the sidebar parser, the viewer
routing and the disposition-ops work. The seven `+` rows are *all* classroom and marking
work, and two are by authors the brief did not name: `student-repair-links-opus` and
`classroom-setup-support-opus`.

**Only one author needed was hibernating.** Neither of those two is among the three named.

## How I established unlanded-ness

Subject grep on `main` found nothing for any of the seven. Then, per commit, I measured how
many of its non-test added lines already exist in the corresponding `main` blob:

| control | result |
|---|---|
| `f7dda0562` — `git cherry` says already landed | **8 / 11 present** |
| the seven | **0–20%**, the highest being `86b8dea21` at 20/101 |

So the instrument can return a positive, and it did not for these. `86b8dea21`'s 20% is
real partial overlap: `3b6117047`, landed at 00:54 tonight, independently re-implemented the
`book_page_file` column and `bookPageFile` plumbing. Its remainder — the upload cell, the
repair-link landing path, the TocTab rework — was new, and that is what conflicted.

## The six, and what each does

| sha on `main` | capability |
|---|---|
| `3e1619be5` | An instructor mints a fresh enrolment token from the roster row, so a student who lost the one-time registration link can be let back in. Nobody could do this before — the instructor holds only the hash. |
| `9ff7ee850` | The handout generator gets its own directory. Writing beside the master made it copy a file onto itself and die with `SameFileError` after an eight-minute render. Also freezes the **source QMD** as the template rather than the rendered handout, without which every hand-in comes back 422. |
| `aec97ab40` | Files emailed homework for a student from the gradebook, and returns a link that lands them on that work. Plus the TOC homework badge linking a returned student to their own submission. |
| `5b50a1dd0` | Retry scoping in classroom setup: retries each link and the template freeze individually rather than the whole publish, which used to create a new source revision per attempt and restart the build it was waiting on. Also fixes `classroomPrincipal` so a classroom token still identifies its student on an **ungated** box — without it `/mine` is unreachable on pic-dev. |
| `da440aad3` | A standalone grading link loads the student page and its comparison page together. |
| `3290d8e4d` | Staging of variant assets (`*_files/`) beside the rendered handout, and excluding the other variant's assets from each published project. |

## What should not land: `da5449a84` "Repair callout-level homework review"

The commit has **no message body**. Most of it is a real repair — the solution callouts are
paired into the student's own rendered page, the second pane collapses, the camera drives to
the selected problem. **Two server hunks inside it are a product decision, not a repair.**

It deletes the rule that submitting unlocks the solution, and it deletes Skip's own words
recording it — the comment it removes quotes him, 26 June: *"once you've submitted an
assignment the solution becomes accessible to you and you can see it side-by-side yours."*
It replaces the doc comment *"Solutions open once you have handed something in"* with
*"Solutions are instructor-only."*

**Why that cannot land quietly.** `main`'s `StudentWork.tsx:169` still renders
**`solutions unlock when you submit`** to the student. Land the reversal and that sentence
becomes false on screen — the server would never send the key. And `3b6117047`, landed at
00:54 tonight, moves the opposite way: *"Let a student read their own answer beside the
solution to that question."*

So this is the third class from AGENTS.md §"The three things he found in four days" — a
product decision arriving as a cleanup, in a commit whose title says repair.

**It is cleanly separable.** The reversal is exactly two files; the marking repair is the
other seven. I prepared both so the choice costs you one line, not an afternoon:

| branch | tip | what |
|---|---|---|
| `park/callout-review-full` | `e835f1f03` | `da5449a84` whole, rebased, `tsc -b` clean |
| `park/callout-review-minus-lock` | `97e7982f2` | the marking repair only; the two server hunks left out. `tsc -b` clean |

**My recommendation: land `park/callout-review-minus-lock`, and put the access question to
Skip separately if anyone still wants it.** The marking repair is wanted and unlanded; the
access change contradicts a cited ruling and a commit from tonight.

## A break on `main` that you have already fixed

While verifying I found `main` did not typecheck: `src/App.tsx` imported
`./recording/appRecordingOwner`, which `6d7c8df38` had deleted. One error, `TS2307`. Your
`05d9e7ab6` fixed it and has since landed as `b46726427`. Recording it only because it is
what the first red typecheck was, and because it is the deliberate red that shows the check
can fail — see below.

## Evidence

- **`tsc -b --force`, exit 0, no output**, on `land-pic-preview-work` at `3290d8e4d`, in
  `~/worktrees/land-pic-preview-work` with symlinked `node_modules`.
- **Deliberate red, same rig:** the `TS2307` above, and removing the restored file again
  reproduced it. The check can go red.
- **`npx eslint` on the 21 changed source files: 24 errors, and 24 on `main` for the same
  files. Zero new.** Measured as a per-rule count diff against a `main` baseline, not by
  eyeballing.
- **`node --test` over the five classroom suites: 38 pass, 0 fail.**
- **One proof I do not have.** `tests/classroom-fixture.test.mjs` — the suite that exercises
  `3290d8e4d`'s asset staging end to end — cannot run on this box: `spawn quarto ENOENT`,
  `quarto` is not installed. It fails identically on `main`, so it is environmental, but the
  asset-staging behaviour is **unverified here** and that is the gap.

## A note on checking this

`git cherry main f7dda0562` still shows `86b8dea21` and `88cec6e98` as `+`. They are on
`main` — conflict resolution changed their patches, so the patch-id no longer matches. Check
by subject, as AGENTS.md says. By subject, `da5449a84` is the only one left.
