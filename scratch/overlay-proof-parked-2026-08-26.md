# Student-overlay proof — parked, blocker diagnosed — 2026-08-26

`app-tester` (`fleet:2b6fe909`), for `classroom-pm`. A parked overlay proof with its
blocker diagnosed, and three rig traps that are the reusable part.

## 0. STOP — the target behaviour changed. Do not resume against §1's spec

**Superseded 2026-08-26 02:05 EDT, before anything was proved.** Skip:

> the idea is anyone should be able to write to any layer they have write access to

> its supposed to be a spatial communication tool

and, just before:

> so students cant submit their stuff to the common layer? can they write it directly?

**So "a student's mark lands in their own overlay and nowhere else" is not the
model.** The branch routes every mark-making tool into the private overlay
automatically, which makes it impossible for a student to write the common layer at
all. That is a blanket prohibition; his words put **write access** in charge
instead — layers are selectable surfaces, and whether you may write one is a matter
of access.

**Proving the routing would have certified the wrong thing.**

### The settled spec (2026-08-26, supersedes the five behaviours)

Task `fleet:2b6f-mtaaclz6`, head **`f6948f235`**. Verify on the branch:

- independently selectable visible layers
- **exactly one** write target
- **common/class is writable and is the default**
- private **Mine** room writable only by its owner
- teacher views student layers **read-only**
- the layer menu becomes a **move-to-layer** menu **only when a canvas selection is
  active**
- a moved annotation **preserves position** and lands in the target room
- **no automatic tool-based routing** — this is the point Skip's words changed
- unauthorized WebSocket upgrades are **refused**

**On that last one — read this before reporting it.** It is **branch behaviour,
newly implemented**, not current-`main` behaviour and **not a regression check**.
The builder wire-proved 3 refusals and 4 accesses. **If it fails, that is a branch
feature failure.** Reporting it as a regression would be wrong, and it is the kind
of wrong verdict that gets acted on.

**This supersedes the earlier statement in this file that isolation is by room
naming rather than enforcement.** That was true of `main` when written; the branch
adds the enforcement. Both statements are correct about their own subject, which is
exactly how a stale note misleads — so: **naming-only on `main`, enforced on the
branch.**

**What is still good below, because none of it depends on which layer a mark lands
in:** the transport blocker (§1), the staged setup, the identity route, and the
three rig traps (§2). Whatever the design becomes, it still needs two enrolled
students in a preview that can accept content.

## 1. Student-overlay proof — parked

Branch `classroom-student-overlay`, head **`9a38e5d6a`**. **Behaviours 1, 2 and 3
are neither established nor refuted** — there was never a rendered book to draw on.
Not "the overlay didn't work." **And per §0 they are no longer the thing to prove.**

### Blocker: RESOLVED 2026-08-26 — three faults, not one

Source push into a TLS preview is **fixed and proven end to end** (a real document
mounted and rendered KaTeX). It took **three distinct faults**, all of which had to
land:

| fault | commit |
|---|---|
| internal HTTP/HTTPS scheme — the one diagnosed below | `fb5b14d0b` |
| `--server` git-remote routing | `0f8da75ef` |
| tokenless Basic username | `fc379cb0f` |
| **self-remote dialled loopback, whose cert git does not trust** | **`e5701db4e`** |

**Four, not three.** The fourth surfaced only by standing the rig up and driving it
after the first three landed: the push reached `https://127.0.0.1:<port>` and died
on `SSL certificate problem: unable to get local issuer certificate`.

**Why loopback specifically.** A TLS preview serves **two certs by SNI** —
`localhost`/`127.0.0.1`/`::1` get the mkcert developer cert, every other name gets
the tailnet cert — and **git's CA store has Let's Encrypt but not the mkcert root**.
So a self-push at loopback could never validate. The fix hands the cert-valid URL
over in **`TLDA_SELF_BASE_URL`** rather than disabling verification.

**Check `TLDA_SELF_BASE_URL` before the mount gate — but for the right reason.**

**I first wrote this as a general warning that any other launcher silently reverts.
That is wrong, and corrected here so nobody inherits it.** Verified in
`shared/self-base-url.mjs`:

```js
if (explicit) return explicit.replace(/\/+$/, '')
return `${useTls ? 'https' : 'http'}://127.0.0.1:${port}`
```

With `useTls` false the self-call is **plain HTTP to loopback and never meets a
certificate**, which is correct and is what an ordinary deployed server does. The
fault exists only for a **TLS** listener with no supplied URL — i.e. a TLS server
launched outside `tlda-dev serve`, which is not a supported configuration. The
file's own comment says it: *"Everything else keeps loopback, which is correct for
plain HTTP and is what a server that was told nothing should assume."*

**So the check stays, with a better justification:** the variable's presence proves
you came up through the **intended launcher**. That distinguishes *"the rig started
the supported way"* from *"the rig started somehow"* — the same distinction that
cost a night when a `--detach` worktree derived the project name `HEAD` and produced
a silent empty canvas.

**And the shape worth carrying:** the scheme fix changed the *error message* without
changing the *cause* — `Empty reply from server` became a certificate error, both
meaning "the server could not talk to itself". A new error after a fix is not
evidence the fix worked.

**Worth keeping:** the scheme fault below was real but was **not sufficient on its
own**. A single confident root cause would have been wrong here — not because the
evidence for it was bad, but because two more faults sat behind it. When a fix
lands whose subject does not match your diagnosis, that is worth asking about
rather than assuming either that you were wrong or that you were right.

**Still required before resuming: a branch head merged with current main.**
`f6948f235` predates all three commits, so a preview built from it fails exactly as
described below. Do **not** merge into a throwaway worktree and test that — the
gate is on the actual branch.

### The original diagnosis (fault 1 of 3)

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

**Isolation — corrected, see §0.** On **`main`** it is by room naming, not
enforcement: `/sync/:room` has no per-room check, so "not shown" rather than
"refused". **On the branch, refusal is implemented and is a thing to verify.** Do
not carry the `main` statement onto the branch; that is the whole distinction.

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
