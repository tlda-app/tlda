# Marking to the student's layer — what is meant to happen {#intention}

Written before touching anything, from his record rather than from the code.

## What he asked for

Skip, 2026-09-12 17:00:52 EDT:

> "the conclusion, which you may have forgotten, is i get to mark
> solution/answer pair and shoot those to the student's canvas layer"

> "which is like, the fucking point"

And earlier, 2026-09-12 00:03:19, on what the student then has:

> "They should just fucking see it. They can read the thing. The solutions are
> there folded. And if they wanna pull out their work in addition to the
> solution, that should be a little button on the fucking solution callout."

## The behaviour, stated so it can fail

1. The instructor opens problem-by-problem marking and sees **his solution beside
   that student's answer**.
2. He **marks on that pair** — ink on the canvas, over either side.
3. He presses **Return marks**.
4. **The student, opening their own work, sees those marks on it** — without a
   badge, a button, or a second place to go.

Step 4 is the one nobody has witnessed.

## What the code does today, read rather than assumed

`ProblemMarking.tsx` holds two editors: a **draft overlay** the instructor marks
on, and the **submission editor** for `doc-<contentRef>`. `Return marks` records
the return on the server first — deliberately, so a failure leaves the marks
private rather than published without a record — and then calls
`moveShapesToLayer` from the draft room into `doc-<contentRef>`.

`StudentWork.tsx` mounts `SvgDocumentEditor … roomId={`doc-${submission.contentRef}`}`.

**So the destination the instructor publishes into is the same room the student's
own view mounts.** The mechanism for step 4 exists and its two ends agree on the
room. That is a reading of the code, not evidence that a mark has ever crossed.

## What is already established, by someone else, and is not to be re-derived

`homework-lifecycle-storyboard.md` in the storyboards worktree:

- **The problem-by-problem marking canvas did not come up.** Four attempts, two
  instrument failures — twice the pooled browser died on that surface, twice an
  8-second *"Server not responding"* abort screen while the endpoint behind it
  answered 200 in 0.28–0.32 s.
- **`Return marks` was pressed from a toolbar surviving over a crashed canvas.**
  The record went to `returned`; **nothing was published, because there were no
  marks** — the surface that makes them is the crashed one.
- **Between submitted and returned the student-visible difference was one word in
  one chip.** With no marks in existence, that is what the states look like, not
  proof that marks would not render.

**So the blocker for step 2 is the marking canvas, and until it comes up, steps 3
and 4 cannot be asked about.** That is where I am looking first.

## The one thing I am not deciding

**"mark solution/answer pair and shoot those" — what travels.** Either

- **the marks** he draws over the pair, which is what the code moves; or
- **the pair itself** — his solution and their answer as content — landing on the
  student's layer beside their work.

His sentence carries both readings, and his 00:03 description of the student's
side sounds like the second: solutions *there*, folded, with a button to pull out
their own work. **I am testing the first because it is what exists, and I am
asking rather than choosing.**
