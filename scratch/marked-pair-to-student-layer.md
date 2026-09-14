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

---

# He answered it, 2026-09-13 {#answered}

*Appended by `edit-bridge-owner-opus`. Everything above is the previous author's
and is unchanged; asking rather than choosing was the right call and this is the
answer arriving.*

**Both travel, and they are side by side on the student's side too.** His words,
relayed through the chief tonight:

> "Maybe just show them side by side expanded. Padded so that it's a rectangular
> region. And we just, like, **don't fold the shit**."

**That supersedes the 00:03 quote above.** *"The solutions are there folded"* was
his description eighteen hours earlier and he has replaced it — **unfolded,
padded, side by side.** Whoever reads this next should not resurrect folding from
the earlier quote; it is still in the record above because it is what was true
when it was written, which is the point of leaving it there.

## The story, seven beats, his

1. Open the book from my account
2. Go to a chapter that's a homework assignment
3. Look at my solution
4. **Click through my students' work, next to mine, lined up**
5. **Write on them**
6. Send them back
7. **Student sees them side by side**

**The walk in `marked-pair-walk.md` starts at beat 4.** Beats 1–3 — book, chapter,
his own solution — have never been walked, and a frame of the marking surface
reached by URL does not establish that he can get there from his book.

## What the code already does, read on `main` at `cdb271384`

**Both sides pair, and they agree on the room.** `ProblemMarking.tsx` pushes the
solution page beside the student's answer; `StudentWork.tsx` does the same and
mounts `doc-${submission.contentRef}`, which is the room the instructor publishes
into. **`grep fold` across the classroom surfaces returns nothing** — so *"don't
fold the shit"* is satisfied by construction rather than needing a change.

**So every one of the seven beats has code behind it. Not one has been
witnessed.** Those are different facts and only the second is what he is asking
for.

## The blocker is gone

`487ba6d05` — the surface-layer lifetime fix — **is on `main` as of tonight**, and
it is the crash that stopped the previous walk at its first frame. The previous
author recorded *"until the marking canvas comes up, steps 3 and 4 cannot be asked
about"*. **It should now come up; nobody has seen it come up.**

**The honest sentence until there are frames:** it exists, the thing that stopped
anyone seeing it is fixed, the frames are owed. **Not that it works.**

---

# The frames exist. Beats 4–7 pass, 2026-09-13 {#witnessed}

*Appended by `edit-bridge-owner-opus`. Measurements by `photographer`, on the
painted surface, sha bracketed. **This supersedes "Step 4 is the one nobody has
witnessed" above** — that line was true when written and is now false.*

**Measured on `ae20ed548`, against pic-preview's disposable `walk-2` seed.
Never against Skip's course.**

```
4  student work next to mine      PASSES  two documents, solution left, student right
5  write on them                  PASSES  mark lands in studentAnnotationOverlay,
                                          NOT in the document's page
6  send them back                 PASSES  Ari's room 7 → 8 records, and the new one is
                                          shape:KWaTlwcD1qYO4t9eh7faf — the id drawn
7  student sees them side by side PASSES  visible on her own text, status "Returned"
```

**Beat 6 was proved by identity, not by count.** The room grew by one record *and
the record is the shape that was drawn*. A count would have been satisfied by any
write — a presence record, a layer model — which is how this exact check has
produced false passes before.

**Private-until-returned was confirmed live, not from the banked reading:**
immediately before publishing, Ari's room held 7 records and **zero** draw shapes.

## What is still NOT established

**Beats 1–3 are unreachable on this seed** — no book link. *Open the book → go to
the homework chapter → look at my solution* has never been walked, and a marking
surface reached by URL does not establish he can get there from his book, which is
where his story starts. **Needs a seed with `bookPageFile` set. Not code.**

**The stroke is a 6×6 dot.** `tlda-dev pw` has `drag` between two elements and no
coordinate freehand verb, so the input was synthetic `PointerEvent`s; the
`pointerdown` took and the `pointermove` sequence did not extend it. **The path is
proven; the penmanship is not.**

## One open product question, nobody's to decide but his

**The pair is mirrored between the two surfaces:**

```
instructor view   solution LEFT   ·  student RIGHT
student view      student  LEFT   ·  solution RIGHT
```

**Both are "side by side".** It may be deliberate — each reader's own work on the
left — or incidental. **Not a defect until he says what it should be, and not to
be "fixed" by whoever notices it next.**
