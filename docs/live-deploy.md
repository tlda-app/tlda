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
node scripts/live-deploy-preflight.mjs
npm run build
fly deploy -c fly.live.toml
```

`fly.live.toml` is the live config for app `tldraw-sync-skip`. It uses
`Dockerfile.live` and `scripts/fly-entrypoint-live.sh`.

## Do Not Use

- Do not use plain `fly deploy`. `fly.toml` points at `Dockerfile`, which is not
  the live image path and may not exist.
- Do not use `tlda publish` for this live server. That is old snapshot/GitHub
  Pages machinery, not the current `phi` deploy path.
- Do not use `Dockerfile.live` with `fly.toml` by hand. Use the full live config:
  `fly deploy -c fly.live.toml`.

## Before Deploy

```bash
git log --oneline -5
node scripts/live-deploy-preflight.mjs
npm run build
```

Make sure the commits intended for `phi` are on `main`. The preflight refuses a
dirty checkout, resolves the committed HEAD, and writes the generated
`server/build-info.json` stamp that the live image copies for runtime status.
Run it before `npm run build`; the stamp is gitignored so writing it after the
clean check does not dirty the deploy commit. The live Docker image copies
`dist/`, so `npm run build` must happen before deploy or the server can ship
stale frontend assets.

## Deploy

```bash
fly deploy -c fly.live.toml
```

Report the exact command, the commit hash deployed, and whether Fly completed.

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
