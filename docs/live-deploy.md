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

## A rejected push does not mean nothing shipped

The deploy runs inside the pre-receive hook, so the machine is updated **before**
the hook decides whether to accept the ref. If its verification window expires,
the push is rejected and the ref does not move — while the new image is already
running.

Seen twice on 2026-08-17. The hook reported:

```
verify: after 240s https://tlda-fly.cormorant-matrix.ts.net is serving nothing, wanted <sha>
push rejected: deploy did not reach the box: check whether its machine is running
```

The box came up on that exact sha about five minutes later. The server can take
longer than the verification window to bind its port, and during that time it is
alive and logging — `[event-loop-lag]` lines appear — while the proxy answers
502 with `connect: connection refused` on 5176. **An alive process that is not
yet listening looks identical to a crash loop in the logs.**

So on a rejected push:

1. **Do not assume the old code is running.** Read `/api/build-info` and see
   which sha the box actually serves.
2. **Wait for the port before concluding anything.** Poll `/api/health` for
   several minutes rather than reading the first 502 as a failed deploy.
3. **Reconcile the ref.** If the box is serving the new sha, push again — it
   verifies immediately and the deploy repo catches up. Leaving it is the
   dangerous state: the box ahead of the ref means the *next* deploy from that
   ref silently reverts what is running, which is the stale-branch failure in
   §"`main` is assembled by cherry-pick" wearing different clothes.

The frozen release-candidate interval is defined in
[Frozen release candidate](release-candidate.md).

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

## A deploy takes the daemons offline for about ninety seconds

Every app restart drops the fleet daemon's WebSocket. It reconnects with
exponential backoff, and while it is away the machine-local half of the system
is simply not there: mirrors are not accepted, source changes are not
acknowledged, terminals and sessions are unreachable.

Measured on 2026-08-17 in `~/.config/tlda/fleet-daemon.testing.log`: **1919
`Unexpected server response: 502` in 33 bursts**, each 7–9 reconnect attempts
spanning 60–120 seconds. The bursts land one per deploy. One ran nine minutes
(16:37–16:47Z), which is the window Skip's browser showed him `HTTP ERROR 502`.

Three consequences worth knowing before you push:

- **A build started just after a deploy will fail, and the failure will describe
  the wrong thing.** Its mirror lands in the disconnected window and reports
  that no daemon accepted it. That is the deploy, not the mirror.
- **Outbound source sync can be left blocked rather than merely delayed.**
  `daemon/source-sync.mjs` rebases a `stale-base` rejection once and blocks the
  project on the second failure. A reconnect storm plus a moving server head
  reaches the second failure easily, and a person's edit then sits on disk
  unaccepted until something clears the block.
- **Deploying repeatedly to chase a bug can be what keeps reproducing it.** On
  2026-08-17 the fleet deployed 33 times into a paper that was being edited, and
  several of the build failures under investigation were caused by the
  investigation's own deploys.

So: **do not deploy while Skip is working in a document**, and when a build fails
within two minutes of a push, re-run it in a quiet window before believing what
it said. Neither of these is a rule about deploying less. They are about not
reading your own outage as the app's behaviour.

**The daemon log will not tell you this if you grep it by time.** `ResilientWS`
writes its connection errors through a bare `console.log`, so those lines carry
**no timestamp** while every other line in the file does. A grep anchored on a
timestamp — the obvious way to search a log — silently excludes exactly the lines
naming the error, and leaves you reading `reason: "error"` with no cause attached.

## The hook cleans up its checkout, and the hook is not in this repository

Each deploy builds in a fresh checkout at
`${TMPDIR:-/tmp}/tlda-<repo>-deploy.XXXXXX`, several GB with `node_modules`.
**It used to leave every one of them behind.** Seventy had accumulated by
2026-08-18, on a volume that reached **100% with 179 MiB free** — found when
`git commit` printed `No space left on device` while still succeeding.

That is not housekeeping. **A deploy that hits ENOSPC mid-build is the trigger
for a project's sync pinning permanently**, so the release path was one push away
from causing the failure it exists to ship fixes for.

There *was* a cleanup trap. It never fired: the build runs inside a `{ … } 2>&1 |
tee "$log"` block, the pipe makes that a subshell, and an `EXIT` trap registered
there does not remove the directory. Reproducing the exact structure leaked on
the **successful** path, the failed path and the killed path alike — so this was
losing a checkout on every deploy, not only on abnormal ones.

Now the checkout is created in the hook's own shell and removed after the block,
where `work` is actually in scope; and each run first sweeps sibling
`tlda-<repo>-deploy.*` directories, keeping its own, which is what recovers a run
that was killed before it got there. The keep-check is by **basename**: a
trailing slash on `TMPDIR` makes `find` emit `/tmp//tlda-…`, and a `-path`
comparison would then fail to match and delete the checkout the deploy is about
to use.

**The hook lives in `~/work/deploy/_utils/pre-receive-common.sh`, outside git.**
So none of this is in any commit, `git log` will never show it, and a search of
this tree for the fix will find only this paragraph. Editing it changes the
release path for the next push with no review and no rollback but a backup —
treat it accordingly.
