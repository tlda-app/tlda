# Classroom process proposal — QTM 285

Author: `classroom-process-proposal` (fleet:856f4225). Written 2026-08-28, 20:00–20:20 UTC.
Revised 20:14–20:30 UTC after `alassroom-pm` supplied the `pic` tokens. Every
fact in this revision was re-measured by me with those tokens; where I disagree
with what I was handed, the disagreement is stated with the measurement.

**What this is:** the full-process proposal Skip asked for at 15:34:47 — writing,
deploying, and teaching. It is a runbook over mechanisms that already exist. It
proposes no new subsystem. Where a command, URL, or owner is not established, it
says so rather than inventing one.

**Everything measured here is stated with its host and time.** Re-measure before
leaning on any of it; a measurement is a timestamp, not a state.

## 0. The state of the world when this was written

Measured by me, from the shared checkout on `mini`, `main` at `d41f6839e`:

| box | serves | `gitSha` | built | public A record (advocate, 19:55Z) |
|---|---|---|---|---|
| `tlda-pic` | the course | `c09e3943d` | 19:09:30Z | `208.111.34.11`, `208.111.35.209` |
| `tlda-pic-dev` | nobody | `e0220ac74` | 14:33:30Z | none |
| `tlda-fly` (testing) | the fleet | `594900c02` | 12:58:46Z | none |

The `tlda-pic` row was read at 19:58:31Z and **re-read unchanged at 20:23:55Z**.
`alassroom-pm` was deploying `d41f6839e` to that box during this revision; as of
20:23:55Z it had not landed. **Whoever reads this must re-read
`/api/build-info` rather than trust the row** — that is the whole point of §4,
Failure 4, and this table is the first thing in the document that goes stale.

Two facts fall straight out of that table.

**`tlda-pic` is the only box a student can reach.** Work done, verified, or
demonstrated on `tlda-pic-dev` is a measurement of nobody. Skip said this himself
at 13:28:40 and it was not acted on for the rest of the day.

**`tlda-pic` is one commit behind `main`, and the missing commit is the
registration fix.** `d41f6839e` "Keep registration continuation on its project"
(15:24 EDT) is not on the box students hit. So the app-code half of today's
registration failure is still live on the course box as of 19:58Z.

Also measured, 20:02:51Z, against `tlda-pic`:

- `GET /` → **200 with no token.** The SPA shell is not token-gated.
- `GET /api/classroom/courses/qtm285/assignments` → **401.** Token gating is on
  (`config/deployments/pic/server.yaml`, `tokenGating: true`, confirms it
  independently).
- `GET /auth/login` with no token → 400; with a bogus token → 401. The route is
  live and validating.

**Advocate F3 is closed, and the answer is yes.** Measured by me at 20:14:03Z
with the `pic` RW token: `GET /api/classroom/courses/qtm285/assignments` → 200,
one assignment `hw-minus-1-setup`, "Homework −1: Setting Up", due
`2026-09-03T23:59:00-04:00`. The course record exists on the box students hit.

**Two things I found in that record that nobody had named.**

**The assignment was not created by `tlda classroom setup`.** Its
`templateDocKey`, `templateVersion`, `solutionsDocKey`, `solutionsVersion`,
`handoutFilter` and `solutionFilter` are **all `null`**; only `sourceDocKey`
(`qtm285`), `id`, `title` and `dueAt` are populated. `cmdClassroomSetup` always
sends `solutionsDocKey`, `handoutFilter` and `solutionFilter` in its `POST
…/assignments` body, and `--handout-generator` is a required flag, so a
setup-created assignment cannot have those three null. This record has the shape
of a bare `POST /api/classroom/courses/qtm285/assignments`. `alassroom-pm` read
the same nulls as "the `PUT …/template` step never completed"; the nulls are
wider than that step, and the distinction matters because it changes what has to
happen next — not *re-freeze the template* but *run the generate/link/freeze
pipeline at all*. **Either way the live consequence is the same and it is the
point: there is no frozen handout for HW−1 on `tlda-pic`, and nothing detected
that.**

**A read token alone cannot list assignments.** With the read token the same
request is **401**, not 200 — `classroomPrincipal`
(`server/routes/classroom.mjs:113-117`) returns `instructor` for `rw`, a student
for a valid enrolment token, and otherwise **`null`**. So an unenrolled visitor
holding only the shared read token sees nothing of the assignment surface, and
registration is the only way in. That is coherent design, not a defect, but it
means **any rehearsal that checks the student surface with the RW token is
checking the instructor's view** and will not reproduce what a student sees.

## 1. The decoupling Skip asked for already exists, twice

> you guys need to decouple having a functioning system from building the whole
> book — the book takes forever to build, that's just reality
> — Skip, 15:34:47

I read both mechanisms and confirm the advocate's account of them.

**A per-assignment render is one chapter, not the book.**
`cli/lib/classroom-render.mjs`, `generateClassroomFixture()`: it selects exactly
one `homework/*.qmd` from `_quarto.yml`, **overwrites `index.qmd` with a
title-only stub** so the real book index never enters the fixture, and copies
only the transitive `{{< include >}}` closure of that one chapter plus the
schedule resources, the handout generator, the solution filter, and named
`_extensions/`. `renderVariant()` then runs `quarto render <one file>`. The
whole book is never in the fixture and never rendered.

**A book is an assembly, and assembling builds nothing.** `cmdBook()`
(`cli/tlda.mjs:512`) verifies each member exists with a `GET /api/projects/<m>`
and then `POST`s or `PATCH`es membership. No render, no build. Each member keeps
its own sync room and annotations (`tlda project book --help`).

**So the decoupling is not something to build. It is something to use.** The
deliverable is which command to run, in what order, against which box — and what
students have while a long render is still going.

### On `tlda-pic`, the full book is not slow. It has never produced a page

Found by the fleet advocate, re-run by `alassroom-pm`, and re-run again by me at
20:23:55Z with the RW token:

| project | roots | pages | `lastBuild` | created |
|---|---|---|---|---|
| `pic` — the full book | 72 | **0** | **`null`** | 2026-08-12T21:15:31Z |
| `qtm285-book` | 3 | 3 | 2026-08-28T18:50:32Z | 2026-08-28T18:17:26Z |
| `pic-install` | 0 | 1 | 2026-08-28T18:59:41Z | 2026-08-13T11:46:03Z |

**State the claim as `lastBuild: null` and `pages: 0`, never as "it has been
building for sixteen days."** `pic` also reports `buildStatus: building` and
`buildPhase: build`, and nothing refreshes those fields — a build that died
mid-run is indistinguishable from one still going, and a status that cannot go
stale-visible reads as current forever. `alassroom-pm` drew that line and it is
the right one; the facts that survive it are facts about output. Sixteen days is
the age of the project record, which is a different claim.

**The control is what makes this a finding rather than a broken query:** the
builder on that box works. `qtm285-book` built to success in the same window and
`pic-install` built nine minutes later. This is specific to the 72-root book, not
to the build system.

**This strengthens §1 rather than qualifying it.** Skip's premise — *"the book
takes forever to build, that's just reality"* — is generous to us. On this box
the honest statement is that **routing anything through `pic` routes it through
something nobody has seen finish**, so the assembled-project path is not an
optimisation, it is the difference between working and not.

**Ruling from `alassroom-pm`, stated as theirs:** the full book is **not** on
tonight's critical path. Every item named for midnight — enrollment, the book
page, HW−1, submission, the instructor list — is served by `qtm285-book` and
needs `pic` for nothing. `pic` is a real problem and a separate one, for a day
when it is not competing with a class.

## 2. The four artifacts

Skip's framing: separate artifacts and processes for (a) app deploy,
(b) course/assignment configuration, (c) small demo/fixture publication,
(d) full book publication.

### (a) tlda app deploy — the code the box runs

| | |
|---|---|
| **Trigger** | An app fix the classroom needs. Today: `d41f6839e`. |
| **Command** | `git push /Users/skip/work/deploy/pic HEAD:refs/heads/main` |
| **Owner** | The chief of staff. `AGENTS.md` §Repository workflow: nothing serializes deploys, so one agent pushes to a deploy remote, and that agent owns the release path. |
| **Verify** | `curl -fsS https://tlda-pic.cormorant-matrix.ts.net/api/build-info` reports the pushed `gitSha`; `/api/health` returns `ok` with `store: up`. |
| **Rollback** | Push the previous good sha to the same remote. There is no other rollback: the deploy runs in the pre-receive hook against the pushed tree. |
| **Depends on** | Nothing in (b), (c), or (d). |
| **Blocks** | Nothing in (b), (c), or (d) — except when the fix is what makes them work, which is today's case. |

**Two things about this remote that are not in `docs/live-deploy.md`.** That
document covers `testing` and `stable` only; `pic` is absent from it and from
`docs/using-tlda.md`. Both are gaps this proposal names rather than fills.

- **`pic` has no promotion gate.** The testing-ancestor check in
  `/Users/skip/work/deploy/hooks/pre-receive-common.sh` is written
  `if [[ "$repo_name" == stable ]]`. `pic` deploys any pushed commit directly.
  Whether it *should* gate on `testing` is a product decision and Skip's, not
  mine; I am naming that it currently does not.
- **A rejected push does not mean nothing shipped.** The deploy runs inside the
  hook, before the hook decides. `docs/live-deploy.md` §"A rejected push does not
  mean nothing shipped" applies verbatim to `pic`: read `/api/build-info` before
  concluding anything.

### (b) Course and assignment configuration — the records on the box

| | |
|---|---|
| **Trigger** | A new course, a new assignment, or a re-freeze of a handout. |
| **Command** | `tlda --env pic classroom setup --course … --assignment … --due … --homework-root … --homework … --handout-generator …` — full argument list at `cli/tlda.mjs:227`. |
| **Owner** | Instructor (Skip), or an agent acting for him with the `pic` RW token. |
| **What it writes** | Three linked Git projects (`-source`, `-handout`, `-solutions`), then `POST /api/classroom/courses`, `POST …/assignments`, `PUT …/template`. |
| **Cost** | One chapter render. The help text says minutes, and that is the per-chapter figure. |
| **Rollback** | **Unknown, and there is a live example of the cost.** I found no command that removes a course, an assignment, or a frozen template. `tlda project delete` removes a project. Whether re-running `setup` with the same ids converges or duplicates I did not test, and I will not test it against the live course box. |
| **Partial success is undetected** | The `hw-minus-1-setup` record on `tlda-pic` carries `templateDocKey`, `solutionsDocKey`, `handoutFilter` and `solutionFilter` all `null` (§0). Something wrote a course and an assignment and none of the generate/link/freeze pipeline, and nothing anywhere reports that. **The check is one request:** `GET /api/classroom/courses/<id>/assignments` with the RW token, and require `templateDocKey` to be non-null before calling setup done. |
| **Depends on** | (a) only for app behaviour. It does not build or need the book. |

**This is the step that produces the enrollment link, and the link it produces is
wrong.** `cli/tlda.mjs:2998` prints:

```
Registration: ?workspace=classroom-register&course=qtm285
```

Three things are wrong with it and they are independent.

1. **It is host-relative.** It carries no host, so it cannot record which box it
   was generated against, and a link pasted out of a `pic-dev` terminal is
   indistinguishable from one generated against `pic`. That is failure #2 of
   today's four, printed by the tool itself.
2. **No `project=` ⇒ no Continue button.** `ClassroomRegistration.tsx:15`:
   `continueUrl` is `registration && project ? … : null`, and `project` has no
   default while `courseId` does. The student registers, gets a token, and the
   page ends. `d41f6839e` is what introduced the `&& project` guard — it fixed a
   Continue that went to the wrong project, and it is **not on `tlda-pic` as of
   19:58Z**, so the box today still sends students to `?project=qtm285`.
3. **No `token=` ⇒ 401 on a gated box, and `tlda-pic` is gated.**
   `server/routes/classroom.mjs:236` gates `POST /register` on
   `resolveRegistrationAccess`, which is
   `['read','rw'].includes(validateToken(extractToken(req)))`.

**Correction to advocate findings 1, F2, on the mechanism of point 3.** F2 says
`src/classroom/api.ts` "sends **no** Authorization header" and that auth
therefore rides the cookie `requireRead` promotes. The conclusion — the link must
carry `token=` — is right. The mechanism is not, and the difference decides which
link shape works:

- `src/authToken.ts:15-45`, `initToken()`, **patches `window.fetch` to inject
  `Authorization: Bearer <token>` on every same-origin request** when `?token=`
  is on the URL (or a token is in `localStorage` from a previous visit). It runs
  at `App.tsx:48`, module scope, before `ClassroomRegistration` renders at
  `App.tsx:1390`. `api.ts` calls the bare global `fetch`, so it gets the header.
- The cookie route cannot be what saves it: **`GET /` on `tlda-pic` returns 200
  with no token** (measured 20:02:51Z), so the SPA shell is not behind
  `requireRead` and a first-time student's page load promotes no cookie.

So `token=` on the page URL is load-bearing because of the fetch patch, not
because of the cookie. A link that relies on the cookie without `/auth/login`
would fail for exactly the student who has never visited before.

**On the test.** `tests/classroom-setup-command.test.mjs:156` asserts
`/Registration: \?workspace=classroom-register&course=qtm285/`. The regex is
unanchored, so appending `&project=…&token=…` still passes. It does not lock the
broken link in; it just fails to require the working one. Fixing the CLI line
does not require touching the test, though the test should then assert the
parameters that matter.

**The link to use, and it is the one to put in front of students.** This is the
literal string sol-dev asked for, with `<READ>` standing in for the `pic` read
token, which does not belong in this file:

```
https://tlda-pic.cormorant-matrix.ts.net/auth/login?token=<READ>&redirect=%2F%3Fworkspace%3Dclassroom-register%26course%3Dqtm285%26project%3Dqtm285-book
```

`loginRoute` (`server/lib/auth.mjs:101-117`) validates the token, sets the
`tlda_token` cookie, and 302s to `redirect`. It is the same shape
`tlda project share` already emits (`viewerLoginUrl`,
`cli/lib/share-url.mjs:131`), it does not depend on client JavaScript, and it is
the established path. **No command emits it for the registration workspace** —
`viewerLoginUrl` can only build `redirect=/?project=<name>`. That is the gap.

I verified the route is live on `tlda-pic` at 20:02:51Z: no token → 400, bogus
token → 401.

#### Correction: the bare `?token=` form also works, and the reason it was thought not to matters

`alassroom-pm` relayed, from the advocate, that a bare `?token=` on the SPA index
returns 200 with no `Set-Cookie` and the register POST therefore 401s. **The
first half is right and the conclusion does not follow.** Measured by me against
`tlda-pic` at 20:18Z, using a course id that does not exist so that no student is
created — the 404 `Course not found` check at
`server/routes/classroom.mjs:241` sits *after* the 401 check at line 236, so the
status code separates the two cleanly:

| request to `POST /api/classroom/courses/zzz-no-such-course/register` | result |
|---|---|
| no credential | **401** |
| read token in `Authorization: Bearer` | **404 Course not found** |
| read token as `?token=` on the request URL | **404 Course not found** |

A read token in the header passes the gate. And the browser sends that header:
**the bundle `tlda-pic` actually serves** — `/assets/index-BfWOAdpN.js`, the one
named by its `index.html` — contains the `initToken` patch verbatim,
`window.fetch=function(...)` injecting `Bearer`, and the
`localStorage.setItem("tlda_token", …)` fallback beside it. I downloaded and
grepped the deployed bundle rather than a local build.

**So the bare form works in a browser and fails under `curl`, because `curl`
runs no JavaScript.** That is an instrument answering a question nobody asked:
the thing being tested is a client-side fetch patch, and the client was never
run. It is worth writing down because both the advocate's original F2 mechanism
and this correction to it were derived from tools that cannot see the patch.

**Use `/auth/login` anyway.** Not because the other form is broken, but because
it does not depend on the patch running, on `localStorage`, or on the shell being
ungated — and a link handed to sixty students should have the fewest live parts.

**What is still untested:** nobody has driven either URL through a real browser
with an empty profile and pressed Continue. I could not — `tlda-dev pw acquire`
refused at the session tab cap (6/6) and I did not reap another agent's tab. That
is stage 6 and it remains the one step no measurement here substitutes for.

### (c) Small demo / fixture publication — one chapter, minutes

| | |
|---|---|
| **Trigger** | Rehearsal, a feature check, a single-chapter update. |
| **Mechanism** | The fixture path inside `tlda classroom setup` — `generateClassroomFixture()` + `renderVariant()`. One chapter and its include closure. |
| **Owner** | Whoever is preparing the class. |
| **Cost** | Minutes, per the help text at `cli/tlda.mjs:227`. |
| **Rollback** | The fixture is a scratch directory; it is deleted and recreated on each run (`fs.rmSync(outDir, …)` before `mkdirSync`). Nothing to roll back. |
| **Depends on** | Quarto with a writable `HOME` — supplied per-fixture by `quartoEnv()`. |

**Gap:** there is no command that renders and publishes one chapter *without*
also writing course and assignment records. `tlda classroom setup` does both. A
dry-render flag would be a CLI flag, not a subsystem — but it is a change, so it
is named here and not made.

### (d) Full book publication — long, and never on the critical path

| | |
|---|---|
| **Trigger** | Publishing the assembled course book. |
| **Command** | `tlda project book <name> --members intro,hw-minus-1,hw0,…` |
| **Owner** | Instructor. |
| **Cost** | **The assembly itself costs nothing** — it verifies members exist and writes membership. The long build is each member's own render, and members render independently. |
| **Rollback** | Re-run with the previous `--members` list. `--members` replaces the set, so a removal is expressible. |
| **Depends on** | Each member project existing on the box. |
| **Blocks** | **Nothing.** This is the whole point. |

**What students and the instructor have while a member is still building:** every
other member. Each member keeps its own sync room and annotations, so republishing
HW−1 does not rebuild Intro or HW0, and a member mid-render leaves the others
readable. Registration, submission, and the gradebook live in `ClassroomStore` and
touch no member at all.

**Therefore:** enrollment and submission must never be gated on a book build, and
under the shipped mechanisms they are not. Any proposal that makes them wait is
wrong on the facts, and the two citations above are the counter.

## 3. The process, end to end

Ownership note: I can establish **the release owner** (`AGENTS.md`: the chief of
staff owns the deploy remote) and **the instructor** (Skip). The rest of the
owner column is a role, not a name — **who fills it is unknown to me and should
be filled in by the PM, not guessed by me.**

| # | Stage | Command / surface | Owner | Gate before the next stage |
|---|---|---|---|---|
| 1 | Author / edit | The course repo's `homework/*.qmd`, ordinary Git | Instructor | none |
| 2 | Fast preview | `quarto render <one chapter>` — the same single-file render the fixture does | Author | Chapter renders nonblank |
| 3 | Classroom feature QA | Exercise the surface on `tlda-pic`, **with the read token, not the RW one** — the RW token makes you the instructor (`classroomPrincipal`) and hides everything a student would hit | Dev / advocate | Named below |
| 4 | Content publication | `tlda --env pic classroom setup …` | Instructor | Setup prints a link whose host is `tlda-pic` |
| 5 | App release | `git push /Users/skip/work/deploy/pic HEAD:refs/heads/main` | Chief of staff | `/api/build-info` reports the pushed sha |
| 6 | Pre-class rehearsal | Drive the real student link on `tlda-pic` from a browser profile with no cookies **and no `localStorage`** | Dev / advocate | Register → Continue → chapter loads **nonblank** |
| 7 | Live class | The student link; the book members already published | Instructor | — |
| 8 | Fallback | Below | Instructor | — |
| 9 | Submission | Positron extension → `POST /api/classroom/…` (`c09e3943d`) | Student | Receipt visible to student |
| 10 | Instructor confirmation | `/auth/login?token=<RW>&redirect=…workspace=classroom-gradebook&course=<id>` on `tlda-pic` — verified working by `alassroom-pm` at ~20:10Z: 302 sets the cookie, `GET /api/classroom/courses/qtm285/status` with cookie only returns 200 with rows distinguishing `ungraded` from `not-submitted` | Instructor | Submitted names appear |

**Live-class fallback (stage 8).** The property that makes a fallback possible is
in §2(d): members are independent and the classroom records are separate from
all of them. So, in order:

1. A member fails to load → the other members still load. Teach from those.
2. Registration fails → the class surface is still readable with the read token
   alone; only student-owned layers need enrollment. Register after.
3. The box is unreachable → **there is no fallback and I will not invent one.**
   `tlda-pic` is the single course box. Naming this as a gap is the honest
   deliverable; proposing a second box is architecture and Skip's decision.

## 4. Recurrence: which step catches each of today's failures

Four were named in my brief; a fifth is added below from the advocate's work.
This is the part Skip will read hardest, so each row names one step and what it
would have returned.

**Failure 1 — an enrollment link missing `project=` and `token=`.**
Caught at **stage 6**, and only there. Not by a test, not by a review, not by a
grep: caught by loading the actual link in a browser profile with no cookies and
no `localStorage`, and pressing Continue. The clean profile is the load-bearing
part — the fetch patch falls back to a `localStorage` token
(`authToken.ts:23`), so **an author's own browser will show a working link that
is broken for every student.** That is precisely an instrument that answers
without measuring, and the counterfactual is free: try it in a private window
and confirm it fails without the token.

**Failure 2 — work verified on a box with no public A record.**
Caught at **stage 4**, by the gate in the table: the setup output must name
`tlda-pic`. Today it cannot, because `cli/tlda.mjs:2998` prints a host-relative
path. Until the CLI prints an absolute URL, the check is manual and it belongs in
stage 6: **before driving a link, resolve its host on a public resolver and
require an answer.** `dig @1.1.1.1 tlda-pic-dev.cormorant-matrix.ts.net` returns
nothing; the positive control against `tlda-pic` returning two A records is what
makes that a measurement rather than a broken query.

**Failure 3 — a course record absent from the box being demoed.**
Caught at **stage 4**, by reading the box rather than the terminal that ran
setup. `GET /api/classroom/courses/<id>/assignments` on `tlda-pic` with the read
token answers it directly. `server/routes/classroom.mjs:241` returns 404
`Course not found` from `store.getCourse`, **after** the 401 check at line 236 —
so a 404 is proof the token was fine and the record is not there, and the two are
distinguishable by status code alone. `ClassroomStore` is per-server: creating
the course on `pic-dev` proves nothing about `pic`.

**Failure 4 — app code not deployed.**
Caught at **stage 5**, by `curl /api/build-info` on `tlda-pic` and comparing
`gitSha` to the commit that carries the fix. **Still live when I last looked:**
`tlda-pic` served `c09e3943d` at 19:58:31Z and again, unchanged, at 20:23:55Z;
the registration fix is `d41f6839e`. `alassroom-pm` was deploying it during this
revision, so this is the one line in the document most likely to be false by the
time you read it — **re-read `/api/build-info` instead of believing it.** The
process point is unaffected: no amount of correct linking fixes stage 4 while
stage 5 is behind.

**Failure 5 — a blank book page means 401, not unbuilt.**
Found by the fleet advocate. `src/loaders/htmlLoader.ts:44` is
`await fetch(infoUrl).then(r => r.json())` with **no `r.ok` check**. A 401 body
parses to `{error:"Unauthorized"}`, and the page loop is
`while (i < pageInfos.length)` — `undefined` on an object, so `0 < undefined` is
false and the loop runs **zero times**. No throw, no error, blank canvas. I read
both lines; a fix is in flight from `classroom-blank-401`.

**The process consequence, which outlives the fix:** *blank* and *absent* are not
the same observation, and on this box the cheap discriminator is one request —
fetch `page-info.json` **with the token** before concluding content is missing.
This is the failure that cost the most today, because it made present content
look absent and sent people to rebuild what was already there. It is also the
exact shape §2's `buildStatus` warning describes, one layer up: an instrument
that answers without measuring.

**The shape all five share:** each was verified against something other than the
thing a student touches — a terminal's output, a dev box, a developer's browser,
a merged commit, a JSON body nobody checked the status of. Every catch above is
the same move: read the surface the student reads, from a position that has none
of the author's advantages.

## 5. What I am not proposing, and why

`AGENTS.md` §"A subsystem is Skip's decision" — the burden of proof for adding a
layer is to state what would be deleted instead. Applying it:

- **No publication subsystem.** Two mechanisms exist and neither builds the book.
  A third would be the thing that section exists to prevent.
- **No new verification harness.** Everything in §4 is `curl`, `dig`, and one
  private browser window.
- **No auth change.** The token gate is the application boundary on a public
  Funnel host (`config/deployments/pic/server.yaml`), and it is network-layer
  auth, not auth between agents.

**Changes I believe are needed but did not make, because they are decisions:**

1. `cli/tlda.mjs:2996-3001` should print **absolute URLs** for the box it just
   ran against, with `project=` and `token=` on the registration one. This is
   the fix for failures 1 and 2 at the source. It is a CLI output change, not
   architecture, but it changes what an instructor is handed, so it is named.
2. A `pic` section in `docs/live-deploy.md`, and a classroom section in
   `docs/using-tlda.md`, which currently has **zero** occurrences of the word.
3. Whether `pic` should gate on `testing` the way `stable` does. Currently it
   does not. Skip's call.

**Resolved since the first draft** (all re-measured by me at 20:14–20:24Z with
the `pic` tokens): course `qtm285` exists on `tlda-pic` with one assignment;
`qtm285-book` is built, 3 pages, `html`; the `/auth/login` instructor path works;
and the full book project `pic` has `pages: 0` and `lastBuild: null`.

**Open unknowns, stated as unknowns:**

- How to remove or amend a course, assignment, or frozen template. I found no
  command.
- Whether re-running `tlda classroom setup` with the same ids converges or
  duplicates. **Untested deliberately** — the only honest test is against the
  live course box and it is not worth the risk tonight.
- Why the `pic` book has never produced a page. `pages: 0` and `lastBuild: null`
  are what I can assert; the cause is not established and `buildStatus` cannot
  supply it.
- How long a full book build actually takes **when it succeeds**. Not measurable
  here, because on this box it has not.
- Whether either registration link works end to end in a browser with an empty
  profile. The pooled browser was at its tab cap; see §2(b).

**One finding, not an unknown:** `~/work/dot-claude/reference/lane-app.md` **does
not exist on this machine**, and `CLAUDE.md` imports it — so the project's own
instruction file has a dangling import, and every agent told to read it reads
nothing. My brief sent me there. I read `AGENTS.md` and the global contract
instead.
