# Classroom process proposal — QTM 285

Author: `classroom-process-proposal` (fleet:856f4225). Written 2026-08-28, 20:00–20:20 UTC.

**What this is:** the full-process proposal Skip asked for at 15:34:47 — writing,
deploying, and teaching. It is a runbook over mechanisms that already exist. It
proposes no new subsystem. Where a command, URL, or owner is not established, it
says so rather than inventing one.

**Everything measured here is stated with its host and time.** Re-measure before
leaning on any of it; a measurement is a timestamp, not a state.

## 0. The state of the world when this was written

Measured by me, from the shared checkout on `mini`, `main` at `d41f6839e`:

| box | serves | `gitSha` at 19:58Z | built | public A record (advocate, 19:55Z) |
|---|---|---|---|---|
| `tlda-pic` | the course | `c09e3943d` | 19:09:30Z | `208.111.34.11`, `208.111.35.209` |
| `tlda-pic-dev` | nobody | `e0220ac74` | 14:33:30Z | none |
| `tlda-fly` (testing) | the fleet | `594900c02` | 12:58:46Z | none |

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

**Unknown, and it is the first thing anyone should establish:** whether course
`qtm285` exists in `ClassroomStore` on `tlda-pic`. I hold no `pic` token —
`tlda --env pic project list` → `Unauthorized` — so I cannot answer it, and
neither could the advocate. This is F3 from advocate findings 1, still open.

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
| **Rollback** | **Unknown.** I found no command that removes a course, an assignment, or a frozen template. `tlda project delete` removes a project. Whether re-running `setup` with the same ids is idempotent I did not test, and I will not test it against the live course box. |
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

**The two link shapes that work.** Both are constructed from mechanisms I read,
and **neither is emitted by any command that exists** — that is the gap.

```
https://tlda-pic.cormorant-matrix.ts.net/?workspace=classroom-register&course=qtm285&project=<book>&token=<READ>
```

```
https://tlda-pic.cormorant-matrix.ts.net/auth/login?token=<READ>&redirect=%2F%3Fworkspace%3Dclassroom-register%26course%3Dqtm285%26project%3D<book>
```

The first relies on the `initToken` fetch patch. The second uses `loginRoute`
(`server/lib/auth.mjs:101-117`), which validates the token, sets the
`tlda_token` cookie, and 302s to `redirect` — it is the same shape
`tlda project share` already emits (`viewerLoginUrl`,
`cli/lib/share-url.mjs:131`), which is why I prefer it: it is the established
path and it survives a student who lands with JavaScript still loading.

**Unverified:** I have not driven either URL end to end, because I hold no `pic`
read token. What I verified is each mechanism in the chain, separately, from
source and from live HTTP status codes. That is sender and receiver; the wire is
untested. Whoever holds the token should drive one link and report the result.

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
| 3 | Classroom feature QA | Exercise the surface on a **throwaway course on `tlda-pic`** | Dev / advocate | Named below |
| 4 | Content publication | `tlda --env pic classroom setup …` | Instructor | Setup prints a link whose host is `tlda-pic` |
| 5 | App release | `git push /Users/skip/work/deploy/pic HEAD:refs/heads/main` | Chief of staff | `/api/build-info` reports the pushed sha |
| 6 | Pre-class rehearsal | Drive the real student link on `tlda-pic` from a browser profile with no cookies | Dev / advocate | Register → Continue → chapter loads |
| 7 | Live class | The student link; the book members already published | Instructor | — |
| 8 | Fallback | Below | Instructor | — |
| 9 | Submission | Positron extension → `POST /api/classroom/…` (`c09e3943d`) | Student | Receipt visible to student |
| 10 | Instructor confirmation | `?workspace=classroom-gradebook&course=<id>` on `tlda-pic` | Instructor | Submitted names appear |

**Live-class fallback (stage 8).** The property that makes a fallback possible is
in §2(d): members are independent and the classroom records are separate from
all of them. So, in order:

1. A member fails to load → the other members still load. Teach from those.
2. Registration fails → the class surface is still readable with the read token
   alone; only student-owned layers need enrollment. Register after.
3. The box is unreachable → **there is no fallback and I will not invent one.**
   `tlda-pic` is the single course box. Naming this as a gap is the honest
   deliverable; proposing a second box is architecture and Skip's decision.

## 4. Recurrence: which step catches each of today's four failures

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
`gitSha` to the commit that carries the fix. **This one is still live.**
`tlda-pic` served `c09e3943d` at 19:58Z and the registration fix is `d41f6839e`.
No amount of correct linking fixes stage 4 while stage 5 is behind.

**The shape all four share:** each was verified against something other than the
thing a student touches — a terminal's output, a dev box, a developer's browser,
a merged commit. Every catch above is the same move: read the surface the student
reads, from a position that has none of the author's advantages.

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

**Open unknowns, stated as unknowns:**

- Whether course `qtm285` exists on `tlda-pic`. Unanswerable without the token.
- How to remove or amend a course, assignment, or frozen template. I found no
  command.
- Whether re-running `tlda classroom setup` with the same ids converges or
  duplicates. Untested, and I will not test it on the live course box.
- How long a full book build actually takes. Quoted as "forever" by Skip and
  "minutes" per chapter by the help text; I measured neither.
- `~/work/dot-claude/reference/lane-app.md`, which `CLAUDE.md` imports and my
  brief told me to read in full, **does not exist on this machine.** I read
  `AGENTS.md` and the global contract instead.
