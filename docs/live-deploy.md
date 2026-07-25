# Live Deploy Runbook

This is the deploy path for Skip's live `phi`/Fly TLDA server.

## Principle: test vs live is a name (Skip, 2026-06-19)

The only difference between a **test** phi instance and the **live** phi instance
must be a single specification in the deploy process — `test` or `live` — nothing
else. Same build, same image, same entrypoint, same deploy command; the config
name is the one thing that differs (`fly.live.toml` for live, a `fly.test-*.toml`
for a test instance pointed at a separate Fly app). That way, vetting a test
instance tells Skip exactly what he is getting from the real deploy, because it
went through the identical path.

> "The difference between it being the test instance and the actual instance is
> just a specification of test or live. That way I know what I'm getting. That
> should be the goal of all of this — all this dev/test infrastructure should be
> going toward the difference between real and test being a name."

This is the north star for the test/dev deploy infrastructure. A test path that
diverges from the live path (a local rig, a hand-built one-off, a different
image) is **not** a valid vetting target — if it isn't the live process with the
name swapped, it doesn't tell Skip what the real deploy will do. Hard line either
way: a test deploy must target a **separate** Fly app and must never touch the
live `phi` env.

## Current Command

Run from `/Users/skip/work/tlda`:

```bash
npm run deploy:live
```

`fly.live.toml` is the live config for app `tldraw-sync-skip`. It uses
`Dockerfile.live` and `scripts/fly-entrypoint-live.sh`.

The wrapper runs the preflight, runs `npm run build`, calibrates the boot probe
against the current live image, builds and pushes the candidate live image, boots
that exact candidate image in the same calibrated temporary no-volume Fly probe,
checks local `/health`, `/api/build-info`, and `/api/fleet-config`, destroys the
temporary machine, and only then promotes the same candidate image with
`fly deploy -c fly.live.toml --image <image-ref>`. It keeps bounded build output
internally without piping through `tail`, so a failed build exits nonzero and
cannot be turned into a successful deploy command by pipeline status.

The calibrated boot probe disables blocking sidecars (`TS_AUTHKEY=` and
`FEELINGS_RCLONE_CONF_B64=`) so a one-off machine can reach `exec node` instead
of hanging in Tailnet setup. Calibration is mandatory on every run: the wrapper
first probes the currently live image in the identical sidecar-disabled
environment. If that known-good image fails, the probe environment is untrusted
and the deploy stops before judging the candidate.

The boot probe proves the image starts Node with sidecars disabled against an
empty database. It catches failures where the candidate image cannot reach a
serving Node process under the same calibrated conditions that the current live
image passes. It does **not** prove live Tailnet auth behavior, feelings export
behavior, or compatibility with the live database schema; covering the schema
class requires a forked snapshot of the live volume, never a second writer on
the real live volume.

## Do Not Use

- Do not use plain `fly deploy`. `fly.toml` points at `Dockerfile`, which is not
  the live image path and may not exist.
- Do not use `tlda publish` for this live server. That is old snapshot/GitHub
  Pages machinery, not the current `phi` deploy path.
- Do not use `Dockerfile.live` with `fly.toml` by hand. Use the full live config:
  `fly deploy -c fly.live.toml`.

## Configuration boundary

Operators select a complete named `{ database, store, licenseKey }` config with
`--config` or `TLDA_CONFIG`; they do not manually split a deployment into
independent URL variables.

`TLDA_SYNC_SERVER` still exists as an internal transport value projected by the
agent launch harnesses. Inside an MCP process it selects the room, signal, and
shape target. It is not an operator-facing deployment selector and must not be
used as a substitute for a named config.

## Before Deploy

```bash
git log --oneline -5
npm run deploy:live -- --dry-run
```

Make sure the commits intended for `phi` are on `main`. The preflight refuses a
dirty checkout, resolves the committed HEAD, and writes the generated
`server/build-info.json` stamp that the live image copies for runtime status.
Run it before `npm run build`; the stamp is gitignored so writing it after the
clean check does not dirty the deploy commit. The live Docker image copies
`dist/`, so `npm run build` must happen before deploy or the server can ship
stale frontend assets.

In agent shells, export the Fly token explicitly before using flyctl if it is not
already in the environment:

```bash
export FLY_ACCESS_TOKEN="$(cat ~/.fly/access-token)"
```

The deploy wrapper also loads that file when `FLY_ACCESS_TOKEN` is absent.

### If the checkout is dirty with someone else's work

Preflight requires the **main checkout on branch `main`, clean** — it rejects
worktrees explicitly (`identity.isWorktree`), so "deploy from a clean worktree at
the commit" is not available as a way around a dirty tree. In a shared checkout
that other agents work in, the blocker is usually somebody's uncommitted WIP.

The right first move is to get its owner to commit it. If that is not possible
and the deploy is genuinely urgent, parking it is acceptable — but:

**Parking someone's uncommitted work is a promise to restore it, and that promise
is broken far more often than it is kept.** As of 2026-07-25 this repo carries
**43 stash entries going back to March**, 26 of them named for exactly this
situation — *"AGENTS.md process guard (not mine, stashing to unblock Gate2A
deploy preflight)"*, *"orphaned-agent-wip-preserved"*, *"stranded ... edits"*,
*"rescue: orphaned shared-checkout WIP"*, *"parked for clean ... deploy"*. Each
was somebody's working state, parked to get a deploy out, and never restored.

A stash is invisible. Nobody discovers their work is missing until they go
looking for it, which is usually never. The stack is a graveyard, not a queue.

So if you park it:

1. **Back it up outside git first** — `git diff HEAD -- <paths> > <scratch>/wip.patch`.
   A stash you forget is recoverable only if you knew it existed.
2. Stash **only the specific paths** that block preflight, never a bare `git stash`.
3. Use a stash message naming who parked it and why.
4. **Restore in the same session, and verify it** — diff the restored tree against
   the backup patch and confirm they match. Do not assume `stash pop` was clean.
5. Say in your report that you moved someone's work, and that you restored it.

If you cannot commit to steps 1–5 before you start, do not stash — wait, or hand
the deploy to someone who can.

## Deploy

```bash
npm run deploy:live
```

Report the exact command, the commit hash deployed, and whether Fly completed.
Do not replace the wrapper with `npm run build | tail ... && fly deploy ...`;
without shell `pipefail`, `tail` can hide the build's nonzero exit status.

The production deploy is intentionally a calibrated two-probe plus promotion
operation inside the wrapper:

1. Resolve the current live image ref and current live `/api/build-info`.
2. Boot-probe that current live image in a temporary no-volume machine with
   sidecars disabled, then destroy the machine.
3. `fly deploy -c fly.live.toml --build-only --push --image-label ...`
4. Boot-probe the emitted `registry.fly.io/...` candidate image in the identical
   sidecar-disabled temporary environment, then destroy the machine.
5. `fly deploy -c fly.live.toml --image <same-image-ref>`

Do not rebuild between the boot probe and promotion. The point of the gate is
that the image promoted to live is byte-for-byte the image that served
`/health` in the candidate probe. Do not let the probe environment leak into
promotion; production gets the real Fly config and secrets.

## Verify

After Fly reports success:

```bash
fly status -c fly.live.toml
curl -fsS https://tlda-fly.cormorant-matrix.ts.net/health
curl -fsS https://tlda-fly.cormorant-matrix.ts.net/api/fleet-config
```

Then open the tailnet URL in a browser for the behavior being shipped. For touch
or iPad behavior, do not ask another agent to fake manual iPad testing; report
the deploy and let Skip drive the physical-device check when needed.

## If It Fails

Stop and report the failing command plus the first concrete error. Do not switch
to `tlda publish`, `fly.toml`, or another deploy path without tracing the current
repo files again.

This flyctl version does not have `fly releases rollback`. Roll back by
redeploying the prior known-good image ref directly:

```bash
fly deploy -c fly.live.toml --image registry.fly.io/tldraw-sync-skip:<prior-image-tag>
```

Find the prior image with:

```bash
fly releases -a tldraw-sync-skip --image
```
