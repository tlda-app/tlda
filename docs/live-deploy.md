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

## Rollback

To deploy a known-good sha directly:

```bash
git clone git@github.com:tlda-app/tlda.git /Users/skip/worktrees/live-rollback-<sha>
cd /Users/skip/worktrees/live-rollback-<sha>
git checkout <known-good-sha>
npm ci
node scripts/live-deploy.mjs --fly-config fly.live.toml
```
