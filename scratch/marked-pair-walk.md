# The walk: does a mark reach the student's work? {#walk}

**Read `marked-pair-to-student-layer.md` first** — it states what is meant to
happen, in his words, and it is what these frames fail against. This file is only
how the frames get taken.

**This walk tests `main`, not a change of mine. Nothing is being demonstrated on
my behalf** — the question is whether the shipped path does what he described.

## Setup

```
tmux new-session -d -s pair-vite -c ~/worktrees/submission-glyphs \
  'TLDA_ENV=pic-preview TLDA_VITE_PROXY_ACTIVE_CONFIG=1 npx vite --port 5179'
```

Client is `main`'s code from that worktree; the store is `pic-preview`'s, through
vite's proxy. Nothing is copied and nothing is deployed. Confirm with

```
curl -sk https://localhost:5179/api/classroom/assignments/homework-1/problems
```

which should answer one problem, `ans-1`, with four students in four states.
**`?name=` is required on every URL** or the window-manager panes never mount.
Never his name.

The data on `pic-preview`: four enrolments, one assignment, one problem, put
there through the real submit/mark/return routes. It is tailnet-only, writes are
free, and it gets wiped.

## The frames

**1. The marking surface comes up.**
`?name=<you>&workspace=classroom-problems&assignment=homework-1`
Assert, before anything else: **no error screen**, and the student's answer is on
the canvas. `document.querySelector('.tl-container')` exists and the page does
not read *"Server not responding"*.

**This is the frame that has never been taken.** It was attempted four times on a
different box and failed twice to a dead browser and twice to an 8-second abort.
**On `pic-preview` that abort's cause does not reproduce from the CLI** — the
endpoint behind it, `/api/projects/submission-homework-1-walk-c`, answers 200 in
0.24–0.32 s with and without `include=page-info`, measured just now. So if it
aborts for you anyway, **that is the finding** and the frame where it stopped is
the deliverable.

**2. A mark exists on the pair.** Draw one stroke on the canvas over the answer,
with the draw tool. Assert: the draft overlay's editor holds at least one shape.

**3. Return marks.** Press it. Assert: the aside does not say *"the marking layer
changed"*; the status chip reads returned.

**4. The student sees it.** Open that student's own view —
`?name=<you>&workspace=classroom-work&assignment=homework-1&student=walk-b`.
Assert **two** things, not one:
- the shape count in `doc-submission-homework-1-walk-b` is ≥ 1, and
- the page shows that mark over their work rather than only a chip reading
  `Returned`.

**Count both, because they fail differently.** A chip and no shape is the
published-nothing case; a shape and no chip is the record not written.

## The deliberate red

Before step 3, open the **same student's** view in the same session and assert
the mark is **not** there. If a mark is visible before `Return marks` is pressed,
the private-until-returned property is broken and that is a bigger finding than
the walk. If that check cannot go red — if you cannot see the student's room at
all — say so, because then step 4's count means nothing either.

## Where it stops is the answer

Any of these is the result, unrepaired: the surface does not come up; there is
nothing to mark on; `Return marks` refuses; the shape never arrives; or it
arrives without the record. **Do not fix a step to complete the story.**
