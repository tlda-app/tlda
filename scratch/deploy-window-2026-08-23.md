# The deploy window, as of 2026-08-23 02:25Z

## STOP — read this before anything below

**Skip stopped the push. Do not deploy without a fresh word from him.**

**And do not re-ship the ack-timeout change.** It is reverted (`4ce1008a4`) and it
must stay out. It raised the deadline that governs when the **daemon sideband**
fires — and `docs/notifications-and-liveness.md` §"What this design rules out",
his own dictation, says *"No second delivery route."* Tuning a mechanism the
design forbids makes the violation quieter, not gone. His words, 2026-08-23:
*"SPEC SAYS YOU FUCKED UP. THAT MEANS YOU FIX, NOT YOU SHIP."*

**One caveat on that revert, because it over-reached:** the same commit also moved
the timeout out of source into `server.yaml`, which the spec **requires** (*"No
timeout in code"*, and not an environment variable either). That half should come
back as part of the notification fix. The *value* is open — §"What is not settled"
item 1 — so whoever does it keeps today's behaviour and changes only where it is
declared.

**The live job is now fixing the notification path against that spec**, owned by
`notify-ship`. Three established violations: the server selects a remedy instead
of reporting one of three symptoms (`unified-server.mjs`, `requestWake`); the wake
circuit breaker is a server-side model of daemon state, backing an agent off five
minutes doubling to two hours; and the timeout is a literal in code. A fourth —
whether a second *delivery* route still exists — was **not** established.

The four build and sync fixes below are unaffected, still staged, still green.

---

# The window as it stood at 01:55Z

**This is a resumption point, not a report.** Force-added because `scratch/` is
gitignored and the next person needs to run this window, not redo the reasoning.
`chief-advocate-2` (fleet:c7637248) is holding it.

## State

| | |
|---|---|
| deployed sha | `027d5d940`, built 2026-08-22T10:21:47Z |
| `main` | five fixes staged on top of the deployed sha — **read the tip yourself; a sha written here goes stale on the next commit, including the one that edits this file** |
| `tsc -b` on `main` | **exit 0**, read from tsc's own status |
| new suites | `figure-bbox.test.mjs` 10/10; the format-dump test PASS |
| deploy command | `git push /Users/skip/work/deploy/testing HEAD:refs/heads/main` |
| waiting on | **Skip's word on timing, and nothing else** |

## What is staged, and why each is in

**`cb3be6788` — editing in the browser never synced.** The source room's working
tree is created by `git init` and never reparented, so every proposal it makes
fails the pre-receive ancestor check as `WrongHead`. The rejection is *returned*
rather than thrown, so nothing logged it — found by reading git refs on the box
after 2,327 log lines said nothing. Editing on disk always worked: same manager,
two entry points, one broken. Owner `versioning-check`, record `ec37d074e`.

**`3a060f73d` — a failed build deleted its own log.** `publishBuildInstance`
copies `build.log`/`latex.log` into the live project only on the success path, so
a LaTeX error discards the instance with its log inside it. `extractBuildErrors`
then read an absent file and returned `[]`, which is why the app said `error` and
`Clean.` about the same build. `logMissing` now splits those two meanings.
Diagnostics cross by a constant list; artifacts cannot cross by construction.
Owner `login-broken`.

**`f94cee089` — the ack deadline could not be met by a healthy delivery.** Server
budget 2000ms had to cover transit + 1000 + 1000 + transit, so a fully successful
notification scored as `mcp-ack-timeout` — the same string a wedged process
produces. 1730 of 1922 wake fallbacks over ~49h carried `deadline_ms=2000`.
Now `5s`. Owner `notification-reliability`, extracted by `notify-ship`.

**`a23a8bb9b` — a LaTeX document with PNG or PDF figures could not build at all.**
`findSvgFigures` only wrote the `.bb` sidecar for `.svg`, and DVI-mode `latex`
cannot size a raster without one. Rasters already *rendered* once sized —
`patch-svg-images.mjs` embeds them as data URIs — so the only real gap beyond
sizing was PDF, now converted with `pdftocairo` through the existing `inlineSvg`.
**No client change.** Proven on a disposable 8-figure project by asking the DOM
what it painted, plus a three-form regression table showing the SVG path
unchanged against `main`. Owner `notify-ship`.

**`48b089182` — a failed format dump now says what it could not resolve.**
`trackedExec` rejected with the bare error from `exec`, which does not attach
stdout — and for a TeX command the stdout *is* the error. Paired with the
keeps-its-log fix deliberately: that one makes the log reach the user, this one
makes its first line the cause instead of `Command failed: pdflatex -ini …`.
Owner `sync-build`.

## Known and deliberately not fixed

**`\includegraphics{fig.svg}` has never worked** — no graphics rule, no extension
list entry — and fails identically on the deployed sha, so this window does not
introduce it. The `.bb` sidecar already exists, so it is one
`\DeclareGraphicsRule{.svg}{eps}{.bb}{}` whenever someone wants it. Held because
it changes an existing path and nothing needed it tonight.

## Two things that would make this deploy inert or wrong

**`testing` deploys `fly.live.toml`, so the `live` deployment config is what
applies** — there is no `config/deployments/testing/`. Verified
`config/deployments/live/server.yaml` carries `ackTimeout: 5s`; without that the
change is invisible on the box Skip uses.

**`mcp-server/fleet-tools.mjs` and `shared/project-for-cwd.mjs` do not reach
agents through a Fly deploy.** The MCP runs locally from
`~/worktrees/daemon-testing`, which is a **deploy pointer** sitting at
`027d5d94`. The login-hang fix is live there as a working-tree edit that is
byte-identical to `main` at `3a060f73d`; `3ef60c037` is the durable copy, so
there is nothing unrecorded and nothing to rescue.

**Do not commit in that checkout** — a commit on a pointer that gets reset is a
divergent commit. **Advance it to the deployed sha as part of this deploy**, so
the MCP and the server run the same code rather than the MCP running ahead. Then
agents need an MCP restart to pick it up; restarting is not enough on its own,
check the seat came back by an established socket rather than by `ok` exiting 0.

**Checking that checkout has a trap:** it is itself on a branch called `main` at
the stale sha, so a bare `git show main:<path>` inside it reads *that* branch and
reports a difference that does not exist. Name the ref, or compare from
`/Users/skip/work/tlda`.

## Before pushing

Skip decides the timing and has been told why: a deploy drops the fleet daemon's
socket for about ninety seconds, and `docs/live-deploy.md` says plainly *do not
deploy while Skip is working in a document*. Do not push without his word.

After the push, `/api/build-info` must report the pushed `gitSha` — a successful
deploy can leave the box behind. Then each owner exercises their own change on a
**throwaway** project on the live box: `versioning-check` re-runs the counterfactual
that produced the negative, `login-broken` breaks a throwaway with an
`\undefinedcommand`, `notify-ship` renders a raster figure.
