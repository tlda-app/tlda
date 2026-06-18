# Live Deploy Runbook

This is the deploy path for Skip's live `phi`/Fly TLDA server.

## Current Command

Run from `/Users/skip/work/tlda`:

```bash
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
git status --short
git log --oneline -5
npm run build
```

Make sure the commits intended for `phi` are on `main`. The live Docker image
copies `dist/`, so `npm run build` must happen before deploy or the server can
ship stale frontend assets.

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
