# Classroom student-layers gate — held, current as of 2026-08-26 14:30 EDT

`app-tester` (`fleet:2b6fe909`), for `classroom-pm` and `sol-dev`.

**Rewritten from scratch at this timestamp.** Earlier revisions were patched
incrementally and had drifted into contradicting themselves — two superseded heads,
"three traps" over a list of four, a fault labelled "1 of 3" in a list of five. A
resumption point that disagrees with itself is worse than a short one. Everything
below is current.

## Status in one line

**Mount gate passes on head `1f2912493`. 0 of 6 behaviour checks run, because no
principal on a sandbox preview can be a student.** Waiting on a supported
`tlda-dev serve` gating flag, in flight.

## What to do when the flag lands

1. Reset `~/worktrees/app-tester-overlay-proof` to the head you are given. **Verify
   it by content and message, not ancestry** (see §4).
2. `nohup node cli/tlda-dev.mjs serve start --sandbox … &` — **detached**, or it
   dies with your shell (§4).
3. **Mount gate first.** `pages ≥ 1`, a non-null `sourceRevision`, `/docs/<project>/
   index.html` → 200, and `TLDA_SELF_BASE_URL` present on the **preview server pid**
   (§4). **If the mount fails, that is the report** — nothing about the overlay
   follows from a rig that never rendered.
4. **Recreate the four classroom records** — `serve stop` destroyed them (§4). Course
   `overlay-proof`, assignment `overlay-hw` (needs `dueAt`), students `stu-a`/`tok-a`
   and `stu-b`/`tok-b` (need `displayName` and `enrollmentToken`). ~1 minute.
5. **Prove three distinct principals** from `/api/classroom/me` — student A, student
   B, instructor. **If two are identical, stop and say so.** Cheaper here than at
   check 6.
6. Then the six checks in §2, **tool-never-decides-the-destination second**.

## 1. Why no one can be a student on a sandbox preview

`/api/classroom/me` returns `{"role":"instructor"}` for **no token**, for a **valid**
enrolment token, and for **`"not-a-real-token"`**. That last one is the control: the
endpoint never consults the token at all.

`server/routes/classroom.mjs`:

```js
const level = validateToken(extractToken(req))
if (level === 'rw') return { role: 'instructor' }        // ← taken when gating is off
if (level !== 'read') return null
const student = store.studentForToken(studentToken(req)) // ← never reached
```

A sandbox preview runs ungated, so everyone validates `rw` and short-circuits before
the enrolment lookup. **`?classroomToken=` is plumbed correctly** — it reaches the
`x-tlda-student-token` header — and is then ignored because the principal is already
decided.

The branch's own wire test says the same thing one layer down
(`tests/classroom-sync-room-wire.test.mjs:108`): *"without this the server starts
ungated, validateToken returns 'rw' for everyone… a test that did not turn gating on
would prove nothing while looking green."*

**Ruled out by `sol-dev`, deliberately:** no principal override, no bypass in
`classroomPrincipal`, no test-only branch. The gate must exercise the real path or
its six results mean nothing in the way that is hardest to spot afterwards.

## 2. The six checks (settled spec)

Supersedes the original five behaviours. Skip corrected the design: *"anyone should
be able to write to any layer they have write access to"*, *"its supposed to be a
spatial communication tool."* **A student can write the class layer directly.**

1. **Control exists and is scoped.** Student A sees a layers pill reading **Class**;
   an unenrolled reader sees **no pill** and an unchanged book.
2. **The tool never decides the destination.** Target Class, draw → B sees it. Target
   Mine, draw → B does not. Switch back and forth; each mark lands on the selected
   layer. Pen, highlighter and eraser alike. **This is what Skip corrected the design
   for — run it second.**
3. **Visibility is independent of the write target.** Hide Class → its annotations go,
   the book stays. Hide Mine → yours go, Class stays. Un-hide restores everything;
   nothing was deleted. Hiding changes nothing for B.
4. **Move to layer.** Target Mine, draw, select → the pill becomes **Move 1**. Move to
   Class → it leaves your layer, keeps its position, and **B can see it**. Deselect →
   the pill names the write target again.
5. **Teacher.** Sees A's marks; `←`/`→` flicks between students **without the book
   reloading or navigating**; cannot draw into a student's layer.
6. **Isolation.** B never sees A's private marks at any point.

**Two residues — observe and report, do not judge.** While the target is **Mine**,
text selection addresses your layer rather than the book; and class annotations are
visible but not selectable. Both deliberate. Skip may dislike them; that is his call
and it is worth more if confirmed than described.

**Unauthorized WebSocket refusal is NEW branch behaviour**, wire-proved by the builder
(3 refusals, 4 accesses). **A failure there is a branch feature failure, not a
regression.** `main` is naming-only; the branch enforces.

## 3. Transport: five faults, all resolved

The mount was blocked for hours by a chain, each fault hidden behind the last.

| # | fault | commit |
|---|---|---|
| 1 | internal HTTP/HTTPS scheme | `fb5b14d0b` |
| 2 | `--server` git-remote routing | `0f8da75ef` |
| 3 | tokenless Basic username | `fc379cb0f` |
| 4 | self-remote dialled loopback, whose cert git does not trust | `e5701db4e` |
| 5 | a room never staged its own first file | `bef19e701` → landed as `5f5bce041` |

**Fault 4, because it is the instructive one.** A TLS preview serves **two certs by
SNI** — `localhost`/`127.0.0.1`/`::1` get the mkcert developer cert, every other name
the tailnet cert — and **git's CA store has Let's Encrypt but not the mkcert root**.
So a self-push at loopback could never validate. Fixed by handing the cert-valid URL
over in `TLDA_SELF_BASE_URL`, **not** by disabling verification.

**Fault 5.** `settledCommit` stages tracked changes only — `add -A` was removed
deliberately, since the app must not stage files in a repository it does not own, the
accepted cost being that a person's new file waits for their own `git add`. **A source
room has no author at a keyboard**, so nothing ever staged its first file: empty tree,
`empty-checkout`, on every settle forever.

**`not-on-work-branch` appears once and is NOT a fault.** `sync()` runs one settle
before the caller stands the tree on the work branch; on a fresh room HEAD is still
`main`, so that settle is correctly refused, then the stand happens and the next
settle publishes. Transient by construction. **Do not chase it.**

**Two shapes worth carrying out of this chain:**

- **A new error after a fix is not evidence the fix worked.** `Empty reply from
  server` became a certificate error — different message, same cause: the server
  could not talk to itself. I read that change as progress and it was not.
- **A single confident root cause was wrong four times running.** Each fault was real
  and none was sufficient alone. When a fix lands whose subject does not match your
  diagnosis, ask — rather than concluding either that you were wrong or that you were
  right.

## 4. Rig traps — three produce an empty canvas, two silently

**All of these look identical to a feature that does not work.**

| trap | symptom | reality |
|---|---|---|
| **`serve start` dies with its shell** | prints a pid, then `Shutting down... Server closed cleanly` as the command returns | process-group death. Launch detached (`nohup … &`) |
| **`--detach` worktree derives the project name `HEAD`** | seeding fails `HTTP 400 name must be lowercase alphanumeric with hyphens` | the name is uppercase. Use a **named lowercase branch** |
| **`serve stop` discards the whole sandbox** | a hand-edit to the preview's `server.yaml` fails *no such file*; classroom records vanish | it deletes `projects/`, `config/` and every `*.db`. Only `daemon-cfg/` survives |
| **TLS preview rejected all source content** | `202 queued`, then `pages 0` forever | §3 faults 1–5. Resolved, listed so the symptom is recognisable |

**On `serve stop`:** anything that writes a preview's config **once** and expects it
to persist works exactly one time per sandbox, then **silently falls back to the
ungated default** — the same invisible failure a gating flag exists to remove. Config
must be written, and tokens printed, **at every start**.

**Ancestry checks in this repo give a sound `YES` and an unsound `NO`.** `main` is
assembled by **cherry-pick**, so a landed change exists as two shas. The staging fix
arrived as `bef19e701`, reads as unmerged, and had landed as `5f5bce041` — same
subject, `trackPath` present, differing by one unrelated scratch file. **Check by
message and content.**

**Check `TLDA_SELF_BASE_URL` on the preview server pid, not the last pid in the log.**
Mine reported ABSENT once because I read a later process. Its presence proves the
**intended launcher** was used — that is the reason to check it, not that the fix
might be missing.

## 5. Console noise that is not a finding

On a preview: `/api/build-info` **503** (no deploy stamp — expected), `page-N.svg`
**404** probes, `…/macros` **404**. None is overlay-related.
