# Advocate review — classroom process proposal `c2b13459c` {#proposal-review}

Required corrections only, not a rewrite. Five, in order of operational cost.
Everything below I verified myself.

**First, the two places it corrects me. It is right both times and I was wrong.**

- **The `window.fetch` patch is real.** `src/authToken.ts:15-45` — `initToken()`
  sets `window.fetch` to inject `Authorization: Bearer <token>` on same-origin
  requests when `?token=` is on the URL, with a `localStorage` fallback; called at
  module scope, `src/App.tsx:48`. I read both. So the bare `?token=` form **does**
  work in a browser, my F2 mechanism was wrong, and my curl test was an instrument
  that could not see a client-side patch. The conclusion — the link must carry a
  token — survives; the reasoning under it is replaced by the proposal's.
- **The test does not lock the broken link in.**
  `tests/classroom-setup-command.test.mjs:156` is an unanchored `assert.match`, so
  appending `&project=…&token=…` still passes. My "the suite pins the bad string"
  was wrong.

Its `lane-app.md` finding is also real: the file does not exist and
`CLAUDE.md:3` imports it. Keep that.

---

## C1 — BLOCKING. The deploy owner is a seat that has been empty for over a week.

§2(a) and stage 5 assign the deploy to **"the chief of staff"**. Roster, just now:

| agent | status |
|---|---|
| `chief` | hibernating **233h** |
| `chief-of-staff` | hibernating **520h**, daemon down 8h |
| `bhief-4` | hibernating 54h |

**There is no live chief.** The proposal is faithful to the `AGENTS.md` rule, and
the rule presumes someone holds the seat. Tonight nobody does, and the deploy is
**the one item on the critical path that is stalled** — `tlda-pic` has served
`c09e3943d` since 19:09:30Z, unchanged at 20:45Z.

Also: sol-dev's brief to `alassroom-pm` assigns *"implementation, integration,
**deployment**, and real live verification"* to the PM.

**Required:** owner in §2(a) and stage 5 becomes the classroom PM for tonight,
with one line saying the `AGENTS.md` constraint is satisfied because the PM is
then the single pusher. Leaving it as written routes the blocked item to nobody.

## C2 — BLOCKING. Stage 3 is not executable, and the proposal's own §0 says why.

Stage 3: *"Exercise the surface on `tlda-pic`, **with the read token, not the RW
one**."*

§0, same document: *"A read token alone cannot list assignments… 401."*

Measured by me on `tlda-pic`:

| credential | `GET /api/classroom/courses/qtm285/assignments` |
|---|---|
| read token | **401** |
| enrollment token | **200** |

So the read token reaches the **document** surface and **nothing** of the
classroom surface. A QA pass run as stage 3 instructs sees 401 everywhere and can
report it as "correctly gated" while having tested nothing.

**Required:** stage 3 reads — *register a test student, then QA with that
student's enrollment token.* Add the one-line rule the two halves need: **read
token → the book; enrollment token → the classroom; RW → the instructor's view,
which hides what a student hits.**

## C3 — §2(d) is titled for one object and written about another.

Heading: *"Full book publication."* Command: `tlda project book <name> --members …`.
Rows: *"The assembly itself costs nothing"*, *"Blocks: **Nothing.** This is the
whole point."*

All true — **of assembly.** But Skip's bucket (d) and the document's own §1
subsection mean `pic`: 72 roots, `pages: 0`, `lastBuild: null`. The expensive
object inherits the cheap object's guarantees by sharing a heading.

**Required:** split the row.

- **(d) Assemble members** — `tlda project book`. Costs nothing, blocks nothing,
  verified.
- **(e) Render a member, and the `pic` full build** — long; never observed to
  finish on this box; never on the critical path.

Same content, but then *"blocks nothing"* is attached to the claim it was
established for.

## C4 — The stage 8 fallback overstates what a read token buys mid-class.

Fallback 2: *"Registration fails → the class surface is still readable with the
read token alone; only student-owned layers need enrollment. Register after."*

The split is sharper than that, and an instructor standing in front of a class
needs the sharp version:

- **Book / document surface** — yes, read token is enough. Verified.
- **Assignments, submissions, receipts** — **no.** 401 without enrollment.

**Required:** *"The book is readable with the read token, so you can teach. The
assignment and submission surface is not — that needs enrollment, so nobody can
hand anything in until registration is back."*

Fallbacks 1 and 3 stand. 3 is honest and should not be softened.

## C5 — §5 item 3 is a topic, not a question, and it is pointed at Skip.

*"Whether `pic` should gate on `testing` the way `stable` does. Currently it does
not. Skip's call."*

`AGENTS.md` §"Either ask a question or don't": a row naming a subject is not a
question, and it records him as the holdup for something never actually put to
him. It is also not needed tonight.

**Required:** either write it as a real question — the two options and what each
costs — or demote it to a note not addressed to him. **Tonight, demote it.**

---

## Two additions, not corrections

**A warning line on the §2(b) rollback row.** It notes that `tlda project delete`
removes a project. That command exists (`cli/tlda.mjs:222`, *"Delete a project and
all its data"*) — and `AGENTS.md` §"NOTHING IN THIS APP DELETES ANYTHING" is the
standing rule. In a runbook, a named command gets run. Add: **do not run it
against the course box.**

**§5's "Resolved since the first draft" already has a false row.** It lists
*"`qtm285-book` is built, 3 pages, `html`"*. As of 20:45Z that project is
`buildStatus: error` and its `page-info.json` and two of three pages return 404 —
see my separate message. The proposal predicted this about its own §0 table
(*"the first thing in the document that goes stale"*); it happened in §5 instead,
within twenty minutes. **The instruction to re-measure should sit above the
"Resolved" list too, not only above the box table.**

## What I did not find

I checked for a hidden full-book dependency in the classroom path and there is
none: registration, submission and the gradebook live in `ClassroomStore` and
touch no member project. I checked for an invented subsystem and there is none —
§5's three refusals are correct and the two mechanisms it uses are the shipped
ones. On sol-dev's five questions, the answers are C1 yes, C2 yes, C3 yes, C4
partly, C5 yes.
