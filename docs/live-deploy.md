# Fly deployment

This repository has two Fly applications. Despite the file names, the active
named environments are:

| Named environment | Fly config | Fly app | Tailnet origin |
| --- | --- | --- | --- |
| `testing` | `fly.live.toml` | `tldraw-sync-skip` | `https://tlda-fly.cormorant-matrix.ts.net` |
| `stable` | `fly.stable.toml` | `tldraw-sync-skip-stable` | `https://tlda-fly-stable.cormorant-matrix.ts.net` |

Both configs use `Dockerfile.live`, `scripts/fly-entrypoint-live.sh`, port 5176,
a persistent `sync_data` volume, and Tailscale rather than a public Fly HTTP
service.

## Current Command

Run from `/Users/skip/work/tlda`:

```bash
npm run deploy:live
```

`fly.live.toml` is the live config for app `tldraw-sync-skip`. It uses
`Dockerfile.live` and `scripts/fly-entrypoint-live.sh`.

The wrapper runs the preflight, runs `npm run build`, and only then runs
`fly deploy -c fly.live.toml`. It keeps bounded build output internally without
piping through `tail`, so a failed build exits nonzero and cannot be turned into
a successful deploy command by pipeline status.

## Do Not Use

- Do not use plain `fly deploy`. `fly.toml` points at `Dockerfile`, which is not
  the live image path and may not exist.
- Do not use `tlda publish` for this live server. That is old snapshot/GitHub
  Pages machinery, not the current `phi` deploy path.
- Do not use `Dockerfile.live` with `fly.toml` by hand. Use the full live config:
  `fly deploy -c fly.live.toml`.

## Worked stable deployment

The same wrapper can target the separate `stable` application:

```bash
npm run deploy:live -- --fly-config fly.stable.toml --dry-run
npm run deploy:live -- --fly-config fly.stable.toml
fly status -c fly.stable.toml
curl -fsS https://tlda-fly-stable.cormorant-matrix.ts.net/health
curl -fsS https://tlda-fly-stable.cormorant-matrix.ts.net/api/fleet-config
```

For `testing`, omit `--fly-config`; the wrapper defaults to
`fly.live.toml`. The dry run still performs preflight and a complete frontend
build, but skips `fly deploy`.

## Configuration boundary

Operators select a complete named `{ database, store, licenseKey }` environment with
`--env` or `TLDA_ENV`; they do not manually split a deployment into
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

### If the checkout is dirty with someone else's work

Preflight requires the **main checkout on branch `main`, clean** — it rejects
worktrees explicitly (`identity.isWorktree`). Do not move or stash another
person's uncommitted work to satisfy this check; get its owner to commit it or
wait until the main checkout is clean.

## Deploy

```bash
npm run deploy:live
```

Report the exact command, the commit hash deployed, and whether Fly completed.
Do not replace the wrapper with `npm run build | tail ... && fly deploy ...`;
without shell `pipefail`, `tail` can hide the build's nonzero exit status.

## Verify

After Fly reports success:

```bash
fly status -c fly.live.toml
curl -fsS https://tlda-fly.cormorant-matrix.ts.net/health
curl -fsS https://tlda-fly.cormorant-matrix.ts.net/api/fleet-config
curl -fsS https://tlda-fly.cormorant-matrix.ts.net/api/build-info
```

Confirm that `gitSha` in `/api/build-info` is the exact commit intended for the
deployment. Then open the tailnet URL in a browser for the behavior being
shipped. For touch
or iPad behavior, do not ask another agent to fake manual iPad testing; report
the deploy and let Skip drive the physical-device check when needed.

## If It Fails

Stop and report the failing command plus the first concrete error. Do not switch
to `tlda publish`, `fly.toml`, or another deploy path without tracing the current
repo files again.
