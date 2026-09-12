# Fly deployment

tlda's production deployment uses a guarded Git remote. Pushing a candidate to
that remote runs validation, builds the image, deploys it, verifies the running
revision, and only then advances the remote's `main` ref.

The deployment repository is intentionally separate from this checkout. In the
examples below, set these values for your installation:

```bash
DEPLOY_REPO=/path/to/deploy/live
HEALTH_URL=https://live.example.invalid
FLY_CONFIG=fly.live.toml
```

Deploy a reviewed commit with:

```bash
git push "$DEPLOY_REPO" HEAD:refs/heads/main
```

Do not kill a push merely because it is quiet. The server-side hook continues
after the local client exits, so terminating the client does not cancel the
deployment.

## Verify the running revision

After a successful push, check the application surface and Fly state:

```bash
curl -fsS "$HEALTH_URL/api/build-info"
curl -fsS "$HEALTH_URL/api/health"
fly status -c "$FLY_CONFIG"
```

`/api/build-info` must report the pushed `gitSha`. `/api/health` must return
`ok` with `store: up`. Fly must report the machine as started.

A rejected push does not prove that the old image is still running. The hook
deploys before it decides whether to advance the ref, so a slow startup can
leave the application ahead of the deployment repository. Read
`/api/build-info`, wait for the health endpoint to bind, and reconcile the ref
if the intended revision is already serving.

The frozen release-candidate interval is described in
[Frozen release candidate](release-candidate.md).

## Keep the front door available

`fly.live.toml` defines two process groups:

- `app` owns the persistent volume and runs tlda;
- `edge` owns the stable network identity and proxies connections to `app`.

Deploy the application group without replacing the edge:

```bash
fly deploy -c fly.live.toml --process-groups app
```

The edge proxy, `scripts/fly-edge-proxy.mjs`, holds a connection while the app
machine restarts instead of immediately returning a connection error. Its wait
window is configured by `TLDA_EDGE_HOLD_SECONDS`. The independent
`TLDA_EDGE_HEALTH_PORT` reports whether the edge is running and whether its app
upstream currently answers.

The edge process persists its Tailscale state on `edge_ts_state`. Preserve that
volume across replacements; registering a fresh node can change the configured
hostname. If the volume must be seeded, copy the current state, verify its size
and digest after transfer, and keep the existing app process available until
the edge has answered on the expected hostname.

## Server and daemon changes land separately

A deployment updates the server image. Machine-local fleet daemons load code
only when they restart. Any change spanning `server/` and `daemon/` or
`bin/fleet-daemon.mjs` therefore has two independently verifiable halves.

For those changes:

1. deploy and verify the server revision;
2. restart the daemons for that environment;
3. verify the server/daemon interaction through the behavior the change was
   intended to affect.

A deployed SHA is not proof that a long-running daemon loaded the same code.

## A push replaces the running revision

The guarded remote updates the daemon checkout to the deployed SHA. Before
pushing, check whether the candidate would remove patches present in the
running revision:

```bash
RUNNING_SHA=$(curl -fsS "$HEALTH_URL/api/build-info" | jq -r .gitSha)
git cherry HEAD "$RUNNING_SHA"
```

Because this repository can carry cherry-picked equivalents, use `git cherry`
rather than ancestry alone. Any `+` row is a patch that the candidate does not
contain; resolve it before deploying.

## Roll back through the same path

Build and deploy a known-good revision through the guarded remote rather than
creating build artifacts by hand:

```bash
rollback_dir=$(mktemp -d)
git clone git@github.com:tlda-app/tlda.git "$rollback_dir/tlda"
cd "$rollback_dir/tlda"
git checkout <known-good-sha>
git push "$DEPLOY_REPO" HEAD:refs/heads/main
```

The guarded path supplies generated inputs consumed by `Dockerfile.live`,
including `server/build-info.json` and `dist/`. A bare `fly deploy` from a
clean checkout lacks those files. Hand-writing them bypasses the revision and
build checks and can ship a stale client.

## Provision another guarded remote

Seed a local bare repository so the first push does not transfer the entire
history:

```bash
git clone --bare --local /path/to/tlda /path/to/deploy/<environment>
git --git-dir=/path/to/deploy/<environment> for-each-ref \
  --format='delete %(refname)' \
  | git --git-dir=/path/to/deploy/<environment> update-ref --stdin
git --git-dir=/path/to/deploy/<environment> \
  update-ref refs/deploy/base <recent-main-sha>
```

Leave `refs/heads/main` absent until the first real deployment. Otherwise the
first push may report `Everything up-to-date` without running the hook.

The remote's `hooks/pre-receive` should provide its deployment name, Fly
configuration, health URL, and root directory to the shared guarded-deploy
hook. Probe the health URL before installing it: a bad URL correctly blocks
every deployment rather than silently weakening verification.

Verify hook wiring without building by pushing a non-`main` ref and confirming
that the hook rejects it as non-deployable.

## Operational rules

- Serialize deployments to the same Fly application.
- Treat a quiet push as active until the remote reports otherwise.
- Verify the browser-facing health and build-info endpoints after every deploy.
- Keep generated build inputs under the guarded path.
- Reconcile the deployment ref with the revision actually serving.
- Do not deploy repeatedly while diagnosing an outage; each restart temporarily
  removes the machine-local daemon path and can reproduce the symptom under
  investigation.
