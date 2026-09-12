# What Skip specified for the classroom, against what got built

`classroom-spec-reader`, 2026-08-24, for `bhief-4`. Relative to `main` at `7cdc0cb90`.

Method: `thread` over bounded windows, read in order, both directions, so that
what he was answering is visible. Not `search` — search was used only to find
which windows to read. Every quotation below carries its timestamp and, where
it matters, what was in front of him.

Windows read in full: **6/20 19:50–20:27** (`chief`), **6/26 04:03–05:53**
(`homework-review`), **7/11 03:28–03:55** (`area-classroom`), **8/8 16:38–20:38**
(`classroom-pm`), **8/11 21:08–22:57** (`fall-class`), **8/15 15:51–16:21**
(`chiefsoso`), **8/21 00:45–01:29** (`bhief-sol`), **8/23 17:36–18:30 and
23:32–00:29** (`bhief-4`).

---

## 1. His specification, in his own words

It is one design, developed across five sittings over two months, and it is
consistent from end to end. Nothing in it was reversed later. I have grouped it
by what it specifies rather than by date, and each item carries the date it was
said.

### 1.1 The object is a book. The course is the book plus a schedule

This is the newest statement of it and the bluntest, but it is not new.

> **2026-08-23 23:35:48** — "I don't understand course assignment handout.
> There's a fucking book, bro. It's all in there,"

> **2026-08-23 23:36:44** — "the fucking the course is just a fucking book and a
> schedule and fucking links to fucking slides. An assignment is just a fucking
> page in the fucking book that's released and has a fucking corresponding,
> right, the like, selectively shown to people with fucking tokens at different
> times. And the fucking like, there are no handouts. Like, it's just a fucking
> book,"

He was answering `bhief-4`, which had just told him it would have to build
"course, assignment, handout" on `pic`. So this is a correction of that
vocabulary, said in the moment he first heard it.

Two months earlier, the same object:

> **2026-06-26 04:03:47** — "I want students to be able to submit their homework
> like… by dragging or like you know like uploading a file on **The book
> website** like right where the Hallmark assignment is"

And the book-plus-schedule form was settled explicitly on 8/21. `bhief-sol` had
just given him a two-command recipe — `tlda project link` per handout, `tlda
project link` per solutions doc, then `tlda classroom setup` naming both:

> **2026-08-21 00:58:52** — "uh"
> **00:59:04** — "seems like my version is better"
> **00:59:39** — "yes snd like, a schedule file"

`bhief-sol` read that back as "the classroom project is the whole Quarto book,
and a schedule file inside it declares the course/assignments/dates plus which
book documents are handouts and solutions", and he answered **01:00:05 —
"yup"**.

### 1.2 The handout is generated from the solution source. There are not two documents

> **2026-08-21 01:01:30** — "and it like getsthat we generate the hw handout from
> the sokution vs like sseparate docs yes?"

Told the intended model was one authoritative source, he asked whether the code
understood his course's content model. `bhief-sol` checked and answered no —
the code takes separate `templateDocKey` and `solutionsDocKey`.

> **2026-08-21 01:02:24** — "omfg angry"
> **01:02:39** — "dude the 285 book alresdy does this like"
> **01:03:03** — "i mesn the class. ee have quartoo filters"

The mechanism he is pointing at already exists in his course repo:
`solution-callout.lua` keeps the solution blocks for the instructor rendering,
`assignment-callout.lua` removes them for the student rendering, and
`shared-code/bin/renderhw` switches between them. He answered **01:04:24 —
"yup"** when that was read back.

He had said the same thing on **2026-07-11 03:45:47** — "I believe I already
wrote a filter that does that," — which sent `area-classroom` to
`bin/make-handout.py` in the course repo and made it delete the duplicate
transformer it had started.

### 1.3 Selective serving by token, at document level, is the security model

He specified the token model on **2026-06-20**, in one breath, and it has not
changed since:

> **20:23:30** — "we have a cryptographic system and like the eye for homework
> solutions and the idea was to have… me give students basically like different
> tokens every week but I think at this point given how it looks like things are
> going we should just have **a token per student and that would be… how we
> identify them and… determine their access to homework solutions and stuff**"

> **20:23:53** — "So the idea is like **when students turn in their homework we
> start decrypting solutions for them**"

Three access tiers, same message thread:

> **20:25:20** — "if you don't have a token right this would be like members of
> the public… you could get **read all the access to the canvas** and then we
> could think about privacy right whether you would only hear my audio and see
> my annotations"

So: **no token → public read-only spectator; token → participant with an
identity; instructor → presenter.** `chief` read that back at 20:26:52 and he
did not correct it.

The submission-unlocks-the-solution rule predates even that:

> **2026-06-26 04:06:15** — "The idea is it once you've submitted an assignment
> the solution becomes accessible to you and you can see it side-by-side yours"

And on **2026-08-21** he checked whether the built thing did it his way:

> **01:04:53** — "uh does classroommdo solution encryptiom like the 285 book?"

Told no — that classroom hides a document *key* from the student API instead —
he asked **01:05:40 "wait so we are selective about eho we serve them to"** and
**01:05:48 "seems as good?"**. `bhief-sol` then corrected itself: the underlying
project routes only check the global read token, so a guessed project name gets
the solutions. His answer:

> **01:06:33** — "easy fix"
> **01:07:03** — "yup" (to: every document/page/source route enforces the
> entitlement; the project name is only an identifier, never the secret)

### 1.4 Layers: one common layer, one layer per person

Specified **2026-06-26** and refined **2026-08-15**. This is the part with the
most of his own words in it, and the least of it is built.

The first pass, 6/26. He walked the agent off a five-store design onto two:

> **04:15:03** — "I think everyone should be able to write to the common story
> right this is how we all communicate it's like **we don't use Piazza we just
> write on the fucking book**"

> **04:18:34** — "I think basically there's a common layer, there's a student
> layer, and then there's like a sort of transient layer I used to push to one
> or the other"

He then dropped the transient layer himself (04:27:38, "we're actually
abandoning the invisible ink thing"), landing on:

> **04:20:42** — "everyone has like there's a common layer and then everyone has
> their own layer"
> **04:21:00** — "And then I can write wherever the fuck I want, students can
> write on their own layer in the common layer"

> **04:22:31** — "students would have a little layer switcher right, and a like
> layer transfer thing, and then I would have a more complicated one"

Refined on 8/15 into four scopes. He asked the question and answered it himself
in the same message:

> **16:17:23** — "I would say the common layer and then the… my private
> communication with students layer, or should there be a private communication
> with students layer per student? I guess… **it should be per student**. And
> then, of course, right, like, **I can composite multiple layers in my UI so it
> doesn't feel overwhelming**"
> **16:17:29** — "so I don't have to flick through a million fucking layers,"

> **16:17:48** — "the idea is **students should have a layer that I don't have
> to** [see]. Exactly,"

Read back by `chiefsoso` and not corrected: **student-private** (student and
their agent only, instructor has no access); **student–instructor**, one per
student; **common**, everyone; **instructor-private**. Plus: the instructor view
composites all of them at once.

The move operation, same window:

> **16:06:06** — "what is the UI for moving objects between layers?… since
> layers have, like, a relative position, right, the idea is, like, moves happen
> while the layer to layer relationship is like, the transforms are static, and
> they happen in that coordinate frame."

> **16:15:04** — "the move stuff should be… **selected object is context for the
> layer menu**"
> **16:15:53** — "we can expose, like, move and copy. Or will move always be a
> copy?"

He accepted move-and-copy both, with world-space appearance preserved through
the source→destination transform.

### 1.5 Marking: his solution beside theirs, arrows across, per problem

> **2026-07-11 03:28:00** — "I don't think about this as, like, grading. Think
> about it as, like, **feedback and marking**."
> **03:28:20** — "annotations, like, relating the two solutions."
> **03:28:47** — "I'll draw arrows you know, make little comments in pen.
> Whatever. Maybe a sticky note if I wanna speak. And it's just, like, all of
> that. It's, like, **the students copy of our two solutions side by side. Is,
> like, there. Marked exercise.**"

> **03:29:18** — "you can just think of a sort of, like, box around that… that
> gets rendered into there. Sort of **handed back homework view, which is just
> like in the book**… maybe that's, like, a click to see kind of thing for them"

Alignment, because his solutions are longer than students':

> **03:43:51** — "**alignment.** My solutions are usually quite a bit long than
> other students. So if I'm gonna be, like, drawing arrows between stuff, might
> wanna, like, pull one thing a little further out to the right, or… scroll it
> up and down. So, basically, **the same affordance that I have for history
> comparison**."

The unit is the problem, not the student. Said on **2026-08-08**, correcting
`classroom-pm`, which had proposed per-student first:

> **17:29:45** — "the view I would actually use is **per problem**… I'm thinking
> of this as, like, **I have a view of the class's homework. Which is, like, my
> view of the homework assignment.** And so that would just be the homework
> assignment and **for each problem flick through the student solutions**."

> **17:28:05** — "I would be able to sort of just, like, pull up an interface…
> and just, like, click through each student so I could just… **wouldn't have to
> open a new page to grade different students**"

And the common annotation layer, in the same breath:

> **17:28:21** — "perhaps there could be, like, a sort of, like, **common
> annotation layer as well that would just go out to everyone**"

> **17:30:13** — "each student has a version of my solution next to their
> solution so we can so I can sort of relate there too… so, like, **they have a
> whole layer that is both**"

### 1.6 Submission: a Quarto file plus photos, rendered before zipping

> **2026-06-26 04:15:49** — "their submission is going to be a file that is like
> a copy of this"
> **04:15:59** — "I'm gonna give them the Cuarto markdown"
> **04:16:04** — "And then they'll write their solution like I do"
> **04:08:34** — "right now I write my solutions in callout blocks"

Photos, **2026-07-11 03:47:44** — "I'm just gonna teach them markdown. Like,
image attached sequence." / **03:47:54** — "it'll just be upload the shit and
display it like markdown." He rejected a special photo-answer asset model in
that exchange.

Rendered-before-zip and both artifacts, **2026-08-08 17:27:32** — "they render
in positron before zipping. But… do we just want the compiled version, or do we
want both the compiled version and the source" — settled as both, with the
rendered version being what he marks.

### 1.7 Registration is student self-service

> **2026-08-11 22:23:01** — "at some point, I'm just gonna need to assign every
> student a token. Right? That's the model. Every student gets a token. And so I
> just need to… have a token generator and, like, a little page where I can
> associate tokens with, like, students' names."

Then, one minute later, he replaced his own request:

> **22:23:57** — "one option actually is to just, like, **have a page where
> students like, basically register**,"
> **22:24:42** — "That way, don't even have to fucking do this shit. Myself."

### 1.8 A download button, and it must be trivially simple

> **2026-08-15 16:18:35** — "we have to acknowledge that this shit is potentially
> kinda janky… we don't want students to lose data. And we want them to feel
> confident that their data won't be lost. And… the best way to do that is to…
> have basically, like, a download button the same way I use like, emergencies."

`chiefsoso` proposed a restorable tlda archive with import. He cut it:

> **16:19:51** — "if that's gonna be, like, way too heavy weight… I was not
> really imagining sort of export import. I was just kind of imagining, like…
> **my, like, dump to markdown kind of situation**"
> **16:20:06** — "if we make it too complicated, then it can break in the same
> way everything else breaks."

### 1.9 A per-student class agent, opt-in, on the private layer

> **2026-08-15 16:03:08** — "should it be on… should it respond to things on the
> students, like, private layer or just public stuff? You would think probably
> private stuff… part of it is, like, **you can get help without a purity to need
> help**… that's a thing the students struggle with is just, like, being
> visible… we should also support them without demanding that."

> **16:04:25** — "LLMs are leaky. Right? So one option given the class is, 12
> students is that, like, **each student gets their own agent** versus there
> being one. And the idea is if they opt in, then that agent would subscribe to
> annotations on that student's layer."

### 1.10 Recording is automatic; publication is his

> **2026-08-11 22:17:03** — "the goal is, right, like, I give a lecture… it's
> recorded automatically if I, like, pull up the website on my, like, teaching
> version of the app with my teaching token"
> **22:17:18** — "And then it just gets put on the website, like, basically
> fucking automatically. Because, like, I suck at that,"

With the privacy constraint, and it is a hard one:

> **22:18:35** — "sometimes… I'll be, like, talking to a student after class…
> if I have my iPad, like, up recording, then potentially, I could be, like,
> posting private information, and that's, like, really not cool,"
> **22:19:04** — "Without assuming that I'm always gonna do the right thing…
> in the moment and turn things off,"
> **22:19:34** — "the chief of staff should review the tail… identify the safe
> interval… and then… **I'm the person who commits it**"

### 1.11 Where the classroom sits relative to the app

> **2026-08-23 18:09:45** — "tlda book / is a format"
> **18:09:51** — "i develop on testing"
> **18:09:55** — "**classroom is an overlay**"
> **18:09:59** — "on the depkoyed version"
> **18:10:06** — "[obv testable on testing]"

And the whole thing, in one sentence, on **2026-08-23 23:44:04**:

> "I think the fucking format like, the book format, which is just… that YAML
> file… needs to be understood. And it's like just an HTML document. It's just a
> bunch of HTML documents that you just have to have it… they can just be
> different documents in a project. Or… different pages. Like, I don't care,
> dude. Like, **it literally just needs to be an environment where students can
> write and see each other fucking writing, and I can fucking write. Them.**
> Like, **it's been specified, bro. It's, like, not it's a thin overlay,**"

---

## 2. What is built, against that

**First, a correction to what `bhief-4` told him at 00:27 tonight.** Two of the
three claims in that message are wrong, and he should not carry them.

- *"No role resolution anywhere in the server."* There is.
  `classroomPrincipal()` in `server/routes/classroom.mjs` resolves a request to
  `{role: 'instructor'}` or `{role: 'student', studentId, courseId}` from the
  `x-tlda-student-token` header, and `ownsStudent()` gates per-student reads on
  it.
- *"A token can be hashed. Nothing decides who sees what."* Wrong.
  `store.solutionDocumentAccess()` plus `requireClassroomDocumentAccess`, mounted
  at `router.use('/:name', …)` in `server/routes/projects.mjs`, refuses the
  solutions project with 403 to a student who has not submitted — on the
  document routes, which is exactly the fix he approved at 01:07 on 8/21.
- The 460-line count was two server files. The client is thirteen files and
  ~1,200 lines; `bhief-4` corrected that itself at 00:29.

Now the actual comparison.

### Agrees with the specification

| Specified | Built |
|---|---|
| One persistent token per student = identity (§1.3) | `students.token_hash`, one-time issue, hashed at rest; student routes derive identity from the token, not a caller-supplied id |
| Submission unlocks the solution (§1.3) | `solutionDocumentAccess` — instructor always; a student only after that student has submitted |
| Entitlement on the document routes, not by hiding a key (§1.3) | `requireClassroomDocumentAccess` on `/api/projects/:name`, added 8/21 in `db793242c` after he said "easy fix" |
| Submission is a zip of `.qmd` plus photos, validated on arrival (§1.6) | `classroom-submission.mjs`; missing image refused by filename; folder-zips and `__MACOSX` accepted |
| Markdown image syntax, no special photo model (§1.6) | Images travel in the archive and render where the student put them |
| Per-problem flick through the class (§1.5) | `ProblemMarking.tsx`; the problem stays put, students swap beside it, non-answerers are stops on the round |
| His solution beside theirs, arrows across (§1.5) | `ClassroomConnectorOverlay.tsx`, `connectorGeometry.ts` — cross-pane connectors drawn above both panes |
| Marks return to the student, per submission (§1.5) | `returnMarks()` in `marking.ts`, scoped to one submission |
| Student self-registration (§1.7) | `ClassroomRegistration.tsx` + register route, landed 8/11 |
| Handout generated from the solution source by the existing Quarto filters (§1.2) | `cli/lib/classroom-qtm285-render.mjs` — it invokes the real `solution-callout.lua` / `assignment-callout.lua` / `renderhw` pipeline, added 8/21 |

### Differs from the specification

**The vocabulary is the wrong object.** The store's tables are `courses`,
`students`, `assignments`, `submissions`, `feedback_marks`. A course is a row
that owns assignment rows; an assignment names document keys. That is the
"course / assignment / handout" model he rejected on 8/23 and again — as
"seems like my version is better" — on 8/21. **`schedule` appears zero times
across the classroom server and client code.** There is no book-rooted project
that reads a schedule file; setup is still per-assignment, via
`tlda classroom setup`, which is precisely what he replaced at 00:59 on 8/21.
`bhief-sol` recorded that at 01:00:27 as "an intermediate surface, not the
finished classroom creation model." It is still the only surface.

**Both handout and solutions are still separate document keys.** 8/21 added
`sourceDocKey`, `handoutFilter`, `solutionFilter` alongside `solutionsDocKey`
rather than in place of it, so the one-source model is available but not the
model.

### Not there at all

**The layer system (§1.4) does not exist.** This is the largest gap and it is
the thing he asked about tonight ("Is the layer system functioning").

`layerScope` in the code is a two-valued field, `'student' | 'common'`, and it
distinguishes *a shared demo student account* from a real one. It is not a
layer. There is no common layer, no per-student private layer, no
student–instructor layer, no instructor-private layer, no layer switcher, no
move-to-layer, no copy-to-layer, no compositing of twelve layers into his view.
The two marking panes are registered as window-manager layers
(`gradingPanes.ts`), which is a rendering arrangement for one grading surface —
not the authority model.

`chiefsoso` said this to him plainly on **2026-08-15 15:53:18**, and it is still
true nine days later: *"the substantive missing piece is the real three-store
classroom architecture: student-private, common, and teacher stores composed as
WM layers. Current grading uses two viewports over one page-local editor/store;
that is not the classroom authority model."*

Consequences that follow from the layer system being absent:

- **"Students can write and see each other writing" — the sentence he used
  tonight to define the whole thing — has nothing behind it.** There is no
  shared writable surface on the book. The Piazza-replacement (§1.4) is not
  built.
- **The common annotation layer that goes out to everyone** (§1.5) is not built.
  `classroom-pm` listed it as not built on 2026-08-08 20:38 and nothing since
  has touched it.
- **The per-student class agent** (§1.9) is not built — it requires a private
  layer to subscribe to.
- **"Download my work as markdown"** (§1.8) is not built.
- **Recording and publication** (§1.10) is not in the classroom code.

**One more, and it is the Thursday blocker `bhief-4` already found:** the book
on `pic` has never built, because the project has no document roots, so nothing
syncs and the build correctly refuses the file it was told to render. That is
independent of everything above.

---

## 3. Provenance of the commits

Thirteen commits created the classroom server and client. **None of them is
invented.** Every one traces to a request from him or to a defect. The problem
is not that agents made up a classroom project — it is that the object model
underneath came in as an unreviewed recovery and nobody replaced it.

### He asked for it

| Commit | Author | Traced to |
|---|---|---|
| `82829b86e` Flick through the class one problem at a time | classroom-pm | **8/8 17:29:45**, verbatim: "for each problem flick through the student solutions" |
| `a48001c8a` Return a student's marks without losing a marking session | classroom-pm | **7/11 03:29:11** the return of the marked exercise |
| `b655ca1ca` Mount the two marking panes as window-manager layers | classroom-pm | **8/8 17:25:34** side-by-side marking |
| `a8bfd9a54` Draw classroom connectors above the marking panes | grading-connector | **7/11 03:28:47** "I'll draw arrows" |
| `022f7995e` Show a student their own work, and only what was sent to them | classroom-pm | **6/26 04:06:15** submission unlocks; **6/26 04:19** draft-vs-returned |
| `10d9a45e1` Read and validate an uploaded submission archive | classroom-pm | **6/26 04:15:49** the submission is a file; **7/11 03:46:54** photos |
| `5c916eaf6` Let students register for a classroom token | fall-class | **8/11 22:23:57**, twenty-eight minutes earlier: "have a page where students like, basically register" |
| `db793242c` Repair classroom QTM 285 pipeline | app-librarian | **8/21 01:12:31** "tell yourmclassroom guy to get on it", after **01:03:03** "we have quartoo filters" and **01:06:33** "easy fix" |

### It addressed an actual problem

| Commit | Author | The defect |
|---|---|---|
| `2ded63337` Flick through the roster, not through the submissions | classroom-pm | A student who skipped a problem was silently absent from the round, so you finish marking without noticing nobody attempted question four |
| `db5bb39aa` Stop handing a student his unreturned marks when they re-upload | classroom-pm | Draft marks leaked to a student on re-upload |
| `20c04afaa` Package Quarto includes with classroom submissions | fall-class | A submission that used `{{< include >}}` lost the included file and rendered wrong |
| `1e544c3b6` Check a submission against the handout instead of guessing at its shape | classroom-pm | Validator inferred the expected answer blocks instead of reading the frozen handout |
| `ec579bdc4` Add common-layer classroom student accounts | classroom-demo-student | A demo/common account for a student surface nobody could otherwise see. **This is the one I would flag** — it is the commit that put the word `layerScope` in the schema with the values `'student' | 'common'`, which reads like the layer system and is not it |

### The one that is neither, and it is the root of the whole gap

**`bb5bfff8b` "Recover the uncommitted classroom grading prototype"**,
classroom-pm, 2026-08-08 16:31. Its own message says what it is:

> "This work existed only in the working directory of the
> `homework-grading-recover-demo` worktree… **Committed as found and
> unverified**: a classroom SQLite store (courses, students, assignments,
> submissions, feedback marks…)"

**That commit is where `course` / `assignment` / `enrollment` came from.** It was
written by an earlier agent in a worktree, never reviewed, and rescued because it
was about to be lost — a correct thing to do with work that exists nowhere else,
and the recovery is not the fault. The fault is that the object model arrived
with it and was never checked against anything he had said, and everything since
has been built onto it.

So the honest answer to *"maybe you just made up a fucking classroom project"* is:
**nobody made up the classroom. Somebody made up its object model, on 8/8 or
before, and thirteen commits of work he did ask for were built on top of it.**
He caught it himself on 8/21 at 00:59 and again on 8/23 at 23:35, and both times
it was recorded as understood and not replaced.

### What I could not establish

- **Who wrote the recovered prototype.** The worktree
  `homework-grading-recover-demo` is gone and the commit does not name its
  author. It predates 2026-08-08 16:31.
- **Whether the client marking surface works.** I read code and history only —
  I ran nothing and opened nothing. Whether an arrow from his pane to theirs
  survives a return is still, as `classroom-pm` wrote on 8/8, unanswered.
- **`5ab19281f`** (`testing-release-ops`, 8/15, "Compose accepted classroom
  lecture delta") touches classroom paths but belongs to the lecture-capture
  track; I did not trace its request.
