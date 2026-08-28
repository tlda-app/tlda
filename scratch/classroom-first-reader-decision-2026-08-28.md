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
- **And a live defect makes A sharper than it looks: a mark on the shared layer
  may not be retractable.** Reported 2026-08-08 — deleting a shape in the
  browser reports success, the shape disappears in that session, and **it is
  back on reload**; deleting the same ids through the shape API does persist.
  `classroom-pm` raised this to you in the same 13:00 exchange, in these terms:
  *"On the book's shared layer it's worse — you'd write something for the whole
  class and not be able to take it back."*

  **Status, as far as I can establish: unresolved.** No commit anywhere claims
  to fix it, the original note says explicitly that it does not identify the
  root cause, and **I did not re-test it tonight** — the browser half needs a
  session I am not opening on the recovered rooms. So I am reporting it as
  *not known fixed*, not as *confirmed live*.

  It bears on this choice because **A makes the shared layer the place the class
  writes**, and if a mark there cannot be taken back that is a property of the
  option, not a separate bug. It is worth settling before or with A, not after.

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

**Operationally, tonight's rule stands and is written down:** open each newly
published project once with an rw token, on the **page URL**
(`/?project=<name>&token=<RW>`) — *not* `/auth/login?token=…&redirect=…`, which
drops the token before `initToken()` reads it and silently falls back to
whatever `localStorage` holds.

## Scope

Not touched: the four recovered public rooms, and no browser automation on any
of them — their document shapes are now persisted and the missing-bounds guard
that kept automated sessions from writing fleet furniture no longer applies.
