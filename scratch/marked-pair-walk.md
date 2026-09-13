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

## Before frame 1: the docview pane that crashed the last run

The crash on advancing between students was a `fleet-docview` shape belonging to
the automated session's own `3-col` layout — **a desktop human is given no fleet
layout at all**, and the auto-layout is applied once per identity per room, so an
identity that already owns fleet shapes there keeps whatever it has, stray
docview included.

**So clear it before advancing.** List the room and delete any `fleet-docview`
that is yours:

```
curl -s  <base>/api/projects/<room>/shapes | grep fleet-docview
curl -X DELETE <base>/api/projects/<room>/shapes/<shape-id>   # needs the rw token
```

The error message carries the shape's id, so the failing run names what to
remove. **If the crash survives with no docview shape in the room, that is a
finding and the walk stops there.**

## Frame 0 is withdrawn, and here is why, so nobody rebuilds it

I wrote a `draw` shape into the student's room through the server API to ask
whether a mark that reaches the room reaches the student. **It was invalid** —
this schema's draw segments carry `path`, a delta-encoded base64 string, and mine
carried `points`. The record was rejected inside `Store.put`, **and the rejection
took the whole room's load with it: zero shapes, so the student's own submitted
work did not render either.**

**The camera caught it because the student's work was missing too** — a check with
no positive control would have reported *"a mark in the room is not visible to the
student"*, which is false and would have gone up as a defect in the publish model.

**The shape is deleted and the room is back to its three records.** Frame 0 is not
coming back in this form: a mark written by hand is a manufactured subject, and
the faithful instrument is a mark the app actually drew. The walk below tests the
real path.

**One thing worth someone's attention, and I caused the condition rather than
finding it:** a single malformed record does not get skipped — it stops every
shape in that room from loading.

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

**4. The mark is in the student's room.** This one needs no browser and does not
go through the DOM — the room is readable from the server:

```
curl -s https://pic-preview.cormorant-matrix.ts.net/api/projects/submission-homework-1-walk-b/shapes
```

`/api/projects/<name>/shapes` lists the records in `doc-<name>`, which is exactly
the room `ProblemMarking` publishes into and `StudentWork` mounts.

**Do not count records. Identify the drawn shape.** A count is contaminated by
the act of looking: opening that room in a browser adds a presence record, a
`wm-project-layer-model` and an `html-page` shape — three records that appeared
during a run where nothing was drawn or returned. So the assertion is that a
record of the drawn shape's own type (`draw`) exists, carrying the geometry that
was drawn, and that it was **not** in the before-listing.

The before-listing is the red below, and it is the same instrument, so the two
are comparable record by record rather than by size.

**5. The student's own view shows it.** Open
`?name=<you>&workspace=classroom-work&assignment=homework-1&student=walk-b` and
assert the mark is visible over their work, not only a chip reading `Returned`.

**Steps 4 and 5 fail differently and both matter.** A shape in the room with
nothing on screen is a rendering failure; a chip with no shape is the
published-nothing case the storyboard already hit.

## The deliberate red

**Run step 4's curl BEFORE pressing Return marks.** The drawn shape must not be
there. If it is, the private-until-returned property is broken, and that is a
bigger finding than the walk.

This is the control that makes step 4 mean anything: it uses the same instrument,
against the same room, and it is required to come back without the mark. If it
already shows one, stop — do not press Return marks to "confirm".

## Where it stops is the answer

Any of these is the result, unrepaired: the surface does not come up; there is
nothing to mark on; `Return marks` refuses; the shape never arrives; or it
arrives without the record. **Do not fix a step to complete the story.**

## The data this should run against, when it next runs

**Skip's standing instruction, 2026-09-12:** tlda is an extension supporting one
class, and work is to be measured against his real course rather than fixtures —
*"everything measured on synthetic projects tonight was uninterpretable to him"*.

The four enrolments on the preview box are invented, and they were the fastest
way to get four states in front of a camera. **They are not the bar.** Copying
real student files onto `pic-preview` is authorised — his words, tonight — so
the next run of this walk should use them, and the walk is otherwise unchanged:
the instrument, the red, and what counts as a pass do not depend on whose work
is in the room.
