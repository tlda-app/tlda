# The deploy window, as of 2026-08-23 01:55Z

**This is a resumption point, not a report.** Force-added because `scratch/` is
gitignored and the next person needs to run this window, not redo the reasoning.
`chief-advocate-2` (fleet:c7637248) is holding it.

## State

| | |
|---|---|
| deployed sha | `027d5d940`, built 2026-08-22T10:21:47Z |
| `main` | `f94cee089` — four fixes staged on top of the deployed sha |
| `tsc -b` on `main` | **exit 0**, read from tsc's own status |
| deploy command | `git push /Users/skip/work/deploy/testing HEAD:refs/heads/main` |
| waiting on | `notify-ship`'s `figure-bbox`, and Skip's word on timing |

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

**Not yet landed: `figure-bbox`.** A LaTeX document with PNG or PDF figures
cannot build at all — `findSvgFigures` only writes the `.bb` sidecar for `.svg`,
and DVI-mode `latex` cannot size a raster without one. Rasters already *render*
once sized: `scripts/patch-svg-images.mjs` embeds them into the page SVG as data
URIs. PDF figures additionally need a PDF→SVG conversion or they render blank.

## Two things that would make this deploy inert or wrong

**`testing` deploys `fly.live.toml`, so the `live` deployment config is what
applies** — there is no `config/deployments/testing/`. Verified
`config/deployments/live/server.yaml` carries `ackTimeout: 5s`; without that the
change is invisible on the box Skip uses.

**`mcp-server/fleet-tools.mjs` and `shared/project-for-cwd.mjs` do not reach
agents through a Fly deploy.** The MCP runs locally from
`~/worktrees/daemon-testing`. The login-hang fix lives there as an **uncommitted
working-tree edit** at checkout `027d5d94`; `login-broken` has been asked to
commit it.

## Before pushing

Skip decides the timing and has been told why: a deploy drops the fleet daemon's
socket for about ninety seconds, and `docs/live-deploy.md` says plainly *do not
deploy while Skip is working in a document*. Do not push without his word.

After the push, `/api/build-info` must report the pushed `gitSha` — a successful
deploy can leave the box behind. Then each owner exercises their own change on a
**throwaway** project on the live box: `versioning-check` re-runs the counterfactual
that produced the negative, `login-broken` breaks a throwaway with an
`\undefinedcommand`, `notify-ship` renders a raster figure.
