# The first reader problem — one decision

`alassroom-pm`, 2026-08-28. **This asks you for one choice and nothing else.**

## The defect, in one sentence

**Document page shapes are created by the client and written into the book's
sync room, so a read-only reader cannot create them — a project no
write-capable visitor has opened is blank for every student, permanently,
while every server signal reads green.**

Proved by changing one variable on a disposable project: read token → one page
named `"Page 1"`, nothing on it; rw token → three pages with content. Then
reopened read-only: it renders. `pic-schedule` sat unrenderable from
2026-08-13 to tonight for exactly this reason.

## What makes it a decision rather than a bug fix

**The book's own room is the layer the whole class sees.** That is the shipped
design and it is yours. **Skip → `classroom-pm`, 2026-08-10, 13:00:09–13:00:19
EDT**, read in order:

> **13:00:09** — for the common layer… maybe that just is the normal layer.
> …my public layer or everyone's layer.
>
> **13:00:13** — Right? Like, **the normal layer for the book.**
>
> **13:00:19** — And then, like, each student can experience their class layer
> as, like, an overlay on that.

*(`StudentAnnotationOverlay.tsx` paraphrases this and dates it 9 August. The
code comment's date is wrong; the exchange is 10 August. Cited here from the
thread rather than from the comment.)*

The topology today: the book is `doc-<member>`, one room per member document,
shared. A student's annotations are a **separate** private room
(`studentOverlayRoomId`), a transparent sheet above it, which the server gates
by parsing the room name. The overlay deliberately **never renders the book** —
a second document editor there would put a second copy of the book in the
student's room.

**So where the document shapes live decides what the class can share.**

## The two options

### A — the server writes the page shapes when a build publishes

The book room ends up holding the document, exactly as it does today after
someone opens it read-write. Nothing else about the topology changes.

- **Keeps the shared class layer.** Anything you or a student puts on the book
  is on the book, visible to whoever the room is visible to.
- **Keeps the private overlay working** unchanged — it composites over a book
  that exists.
- **Removes the first-reader requirement entirely.** A published project is
  readable by anyone the moment it builds.
- **Cost:** the server has to write tldraw shape records. `AGENTS.md`
  §"Use tldraw-native state and interaction" requires the client shape utility
  and the `sync-rooms.mjs` schema to match **exactly**, so this adds a second
  writer of a record type the client currently owns alone. That is the real
  price and it is not trivial.
- **One open question worth settling with A, stated at the width of its
  evidence and no wider.** A browser delete has been observed not to persist —
  the shape disappears in the session and **is back on reload**, while deleting
  the same ids through the shape API does persist.

  **What was actually measured** (2026-08-08, `testing`): **two arrow shapes in
  an instructor *grading* room, on a *submission* project, parented to rendered
  page shapes.** That is the whole of the evidence.

  **What is not established: whether it happens on the book's own shared
  layer.** Different room, different project, and the marks there are not
  necessarily parented the same way. `classroom-pm` told you at 13:00:40 that it
  would be *"worse on the book's shared layer"* — that was their inference from
  the same single observation, not a second measurement, and I repeated it as
  though it were one.

  **Status: no commit claims to fix it, the original note says it never found
  the root cause, and I did not re-test it tonight** — the browser half needs a
  session I am not opening on the rooms we just repaired.

  **Why it still belongs here rather than in a bug list:** A makes the shared
  layer the place the class writes, so *if* it applies there, it is a property
  of the option. **Establishing whether it does is one test on a disposable
  project** — draw a mark on a book room, delete it, reload — and that is worth
  doing before committing to A, not after.

### B — a read-only client renders the document locally, without syncing

Each reader builds the pages in their own browser and never writes them.

- **The book room stays empty.** There is then no shared substrate: the layer
  the whole class sees has nothing in it, and an annotation you make on the
  book has nowhere to live that anyone else can see.
- **The private overlay still works**, because it is its own room — but it
  would be the *only* place anything can be drawn, which inverts the design
  above.
- **Geometry stops being canonical.** Every reader constructs their own shapes,
  so positions and ids are per-client, and an overlay aligned over them is
  aligned over one reader's arrangement.
- **Cheaper to build** and it removes the first-reader requirement too.

## My reading, which is not the decision

**A preserves what you already specified; B quietly retires it.** B is smaller
and would have been a reasonable design if the book room had never been the
shared layer — but it is, on your instruction, and losing it is a product
change wearing the shape of a fix. **I have not built either.**

## Until you choose: the guard

**A published project is not readable until a write-capable session has opened
it.** Nothing checks that today and nothing warns; every server-side signal —
`buildStatus: success`, the right page count, content present — reads green
over a room a student sees as blank.

The minimum honest guard, and it needs no new machinery:

**A project's room either holds `html-page` shapes or it does not, and that is
one read.** It is the query that found this tonight:

```
GET /api/projects/<name>/shapes     → count records with type html-page
```

Zero on a project whose build reports pages is exactly the broken state. That
check belongs wherever a person is told a publication succeeded — the
`classroom setup` output and the build card are the two places that currently
claim success while this can be false.

**Operationally:** open the project with an rw token on the **page URL**
(`/?project=<name>&token=<RW>`) — *not* `/auth/login?token=…&redirect=…`, which
drops the token before `initToken()` reads it and silently falls back to
whatever `localStorage` holds.

### And it is once per PUBLISH, not once per project

**I first wrote this rule as a one-time setup step. That is wrong, and the
correction matters more than the original because it attaches to every content
change rather than to project creation.**

**Two mechanisms, both read off `main` and both verified by me:**

`src/measuredGeometryWrite.ts:13` — the measured geometry write is gated on
write permission:

```js
if (!permission.mayWrite || !write) return false
```

and `HtmlPageShape.tsx:428` supplies `mayWrite: canPresent()`. **A read-only
student can never write a measured geometry.**

`src/loaders/createShapes.ts:241` — an **existing non-slide** shape keeps its
persisted height:

```js
const h = isSlide
  ? page.bounds.h        // slides adopt the newly declared height
  : … existing.props.h   // everything else keeps what is persisted
```

**So a height newly declared in `page-info.json` is never adopted by a room
that already holds the shape.** Slides are exempt; ordinary pages are not.

**The consequence is clipping, and that IS established — from the code, not
from a browser.** `HtmlPageShape.tsx:1229-1265`: the iframe is sized
`width: 100%, height: 100%` inside a div of `shape.props.w × shape.props.h`,
and carries **`scrolling="no"`** (line 1264). An iframe clips its document to
its viewport, and the parent's `overflow: visible` does not change that.
**So content taller than the persisted height is cut off, with no scrollbar and
no way for a student to reach it.**

**What this does NOT establish is that any current page is clipped**, and the
obvious comparison is a trap I nearly published:

| project / page | declared | persisted |
|---|---|---|
| `qtm285-hw-minus-1` | 800 × 1000 | 800 × **891** |
| `qtm285-book` / `Lecture0-prose` | 800 × 1200 | **863 × 15429** |
| both book homework pages | 800 × 1200 | 800 × 1200 |
| `pic-install` | 800 × 1200 | 800 × 1200 |

**The declared height is a placeholder, not an authority — this table disproves
treating it as one.** `Lecture0-prose` declares 1200 and persists 15429. So
`891` against a declared `1000` says nothing about whether anything is cut off;
only the *rendered* height would, and measuring that means rendering it.

**And the 1.2 MB page is not a bigger document.** Roughly 278 KB of the growth
is base64 — an embedded font and two JS bundles — plus inlined CSS. **The
visible assignment is the same document minus one collapsed callout**, so its
rendered height is probably close to the 891 already persisted.

**So: the mechanism is the finding; no instance of it is currently evidenced.**
Clipping is real, silent, and unreachable by a student when it happens — and
nothing on the box is known to be in that state right now.

**So the rule is: after any publish that changes a non-slide page, a
write-capable session must open the project before students do.** For a course
that rebuilds homework and lectures continuously that is a step attached to
every content change, not a setup task — and it is the same first-reader defect
in different clothes, surviving the fix to the first one.

## Scope

Not touched: the four recovered public rooms, and no browser automation on any
of them — their document shapes are now persisted and the missing-bounds guard
that kept automated sessions from writing fleet furniture no longer applies.
