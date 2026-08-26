# Student-overlay proof — parked, blocker diagnosed — 2026-08-26

`app-tester` (`fleet:2b6fe909`), for `classroom-pm`. A parked overlay proof with its
blocker diagnosed, and three rig traps that are the reusable part.

## 1. Student-overlay proof — parked

Branch `classroom-student-overlay`, head **`9a38e5d6a`**. **Behaviours 1, 2 and 3
are neither established nor refuted** — there was never a rendered book to draw on.
Not "the overlay didn't work."

### Blocker: a TLS preview cannot accept source content

Every source push fails, including `tlda-dev serve`'s own seeder:

```
proposal not accepted: empty-checkout
git push … http://source-room-…@127.0.0.1:5190/git/<project> …
fatal: unable to access 'http://127.0.0.1:5190/git/<project>/': Empty reply from server
```

The server pushes to itself over `http://` while the preview listens on `https://`:

```
http://127.0.0.1:5190/api/health    →  000  "Empty reply from server"   ← the git error, verbatim
https://127.0.0.1:5190/api/health   →  200
https://127.0.0.1:5190/git/…        →  401  (route exists, wants the push's auth)
```

The project is created, the push returns **`202 {"ok":true,"status":"queued"}`**,
and nothing lands — `pages 0`, no `sourceRevision`, indefinitely. **The API reports
success.** `classroom-pm` traced the construction to
`daemon/git-sync-manager.mjs:35` (`new URL('/git/<project>', server)`) and
escalated to `sol-dev`; `tlda-dev serve` has no flag to disable TLS.

### What is staged and ready

- Worktree `~/worktrees/app-tester-overlay-proof`, branch
  `app-tester-overlay-proof` at `9a38e5d6a`, `node_modules` symlinked, built clean.
- Preview **up and healthy (200)** on `https://davids-mac-mini.cormorant-matrix.ts.net:5190`,
  launched detached. Left running deliberately — restarting costs a 4-minute build.
- The author's worktree `~/worktrees/student-overlay` was **not touched** and is clean.
- Classroom router mounted at `/api/classroom`.

### Identity, for whoever resumes

**`?classroomToken=<raw token>` — not `?name=`.** Read at call time from the query
string into the `x-tlda-student-token` header. **`?name=` gives a named but
unenrolled reader, which is the *no overlay* case** — it is the reflex here and it
would quietly test the wrong thing. Course/student creation calls are in
`classroom-pm`'s message `3362618`; `assignments` requires `dueAt`, `students`
require `displayName` and `enrollmentToken`, and only a SHA-256 of the token is
kept, so a token not captured at creation cannot be recovered.

Two separate browser contexts for the two students: nothing is cached per identity,
so one tab *can* switch by editing the parameter — but then a stale tab is
indistinguishable from a broken overlay, which is the observation the run rests on.

Behaviour 4 can be added in the same sitting: teacher path is
`?project=<book>&course=<courseId>`, read-only by construction.

**State, not test:** isolation is by room naming, not enforcement — `/sync/:room`
has no per-room check. "The second student does not see it" means not shown, not
refused.

## 2. Three rig traps — all produce an empty canvas, two silently

The most reusable thing here. **All three look identical to a feature that simply
does not work**, and two give no reason at all.

| trap | symptom | reality |
|---|---|---|
| **`tlda-dev serve start` dies with its shell** | prints a pid, then `Shutting down... Server closed cleanly` as the command returns | process-group death. Launch it detached (`nohup … &`) |
| **`--detach` worktree derives the project name `HEAD`** | seeding fails `HTTP 400 {"error":"name must be lowercase alphanumeric with hyphens"}` | the name is uppercase. Check out a **named lowercase branch** |
| **TLS preview rejects all source content** | `202 queued`, then `pages 0` forever | `http://` self-push against an `https://` listener (§1) |

**The cost of the pair is worse than either.** Trap 2 was my own error and trap 3 is
a real defect, and they present the same way — so a rig that never came up is
indistinguishable from a branch that does nothing. Any "the feature is absent"
report from a fresh preview should first prove the preview could render **anything**.
