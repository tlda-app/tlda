# Fly deployment

Deploying is a push to the deployment repository:

```bash
git push /Users/skip/work/deploy/testing HEAD:refs/heads/main
```

If a push needs to abort, wait for it to finish; killing the client does not stop the server-side deploy.

`/Users/skip/work/deploy/testing` deploys `fly.live.toml`, the Fly app
`tldraw-sync-skip` at `https://tlda-fly.cormorant-matrix.ts.net`.

`/Users/skip/work/deploy/stable` deploys `fly.stable.toml`, the Fly app
`tldraw-sync-skip-stable` at `https://tlda-fly-stable.cormorant-matrix.ts.net`.
`stable` only accepts a commit that `testing` has already deployed successfully.
The `testing` ref is the deployment record: the stable gate reads
`testing`'s `refs/heads/main`, requires the candidate commit to exist in that
repository, and requires it to be an ancestor of the `testing` ref. The
`testing/deploy-state/last-successful-sha` marker is written after Git accepts
the ref, so it is status, not the authority for promotion.

The deploy repositories reject pushes with:

- conflict markers in the pushed tree;
- server `.mjs` files that fail `node --check`.

After a successful push, verify:

```bash
curl -fsS https://tlda-fly.cormorant-matrix.ts.net/api/build-info
curl -fsS https://tlda-fly.cormorant-matrix.ts.net/api/health
fly status -c fly.live.toml
```

`/api/build-info` must report the pushed `gitSha`; `/api/health` must return
`ok` with `store: up`; Fly must show the machine as `started`.

## A daemon/server change has no atomic landing

A deploy ships the server. It does not ship the daemons that talk to it.

The server half of a change arrives when the image boots. The daemon half
arrives only when a daemon restarts from the shared checkout — which happens on
its own schedule, or not for hours. So a change that spans both lands in two
parts, in an order nobody chooses, and there is a window in which one side has it
and the other does not.

Both directions have shipped and both were reported as something else:

- A daemon running code older than the server, whose reading of a file was
  correct about a path that no longer ran.
- A daemon running code newer than the server, whose new gate waited 120s for a
  reply the server had no handler to send — turning a link that used to succeed
  into a timeout.

So when a change touches `daemon/` or `bin/fleet-daemon.mjs` as well as the
server, restarting the daemons for that environment is part of the deploy rather
than a follow-up. Otherwise the server has the new behaviour, the daemon never
invokes it, and the pair reads as working while being half-live.

The check is the same shape as verifying `/api/build-info` reports the pushed
sha: **a deployed sha is not a loaded module.** Ask what each side is actually
running, not what was pushed.

## Rollback

To deploy a known-good sha directly:

```bash
git clone git@github.com:tlda-app/tlda.git /Users/skip/worktrees/live-rollback-<sha>
cd /Users/skip/worktrees/live-rollback-<sha>
git checkout <known-good-sha>
npm ci
node scripts/live-deploy.mjs --fly-config fly.live.toml
```
