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

## The front door is not in the machine being deployed

`fly.live.toml` has two process groups. `app` carries the volume, so it has to
stop to be redeployed — one volume means no blue/green, and `fleet.db` is on it.
`edge` is the tailnet node and the front door, carries nothing, and the app
deploy leaves it alone:

```bash
fly deploy -c fly.live.toml --process-groups app
```

**That flag is the deploy.** Without it, `fly deploy` updates both groups and the
tailnet name goes down with them, which is the thing this arrangement exists to
stop.

Behind the tailnet node, `scripts/fly-edge-proxy.mjs` is a TCP pipe that **waits**
for the app machine instead of answering 502. While the app machine is being
replaced a connection is held, not refused, so a browser sees one slow request
rather than a dead page. The wait is `TLDA_EDGE_HOLD_SECONDS`; past it the
connection is dropped with a line in `fly logs`.

The measured app-machine gap on 2026-08-18 was about 60 seconds — machine stop
03:11:45Z, serving 03:12:45Z. A cold start on this box has been measured near 90s.

### The cutover, once

The tldraw licence is bound to `*.cormorant-matrix.ts.net` and Skip has that URL
open, so the node has to keep its identity: the edge volume holds a **copy of the
existing `tailscaled.state`**, which makes it the same node on a different
machine. A fresh tailscaled registers a new node, Tailscale names it
`tlda-fly-1`, and his URL moves.

**Edge goes up first, while the app machine is still running its old image and
still holding the tailnet node.** That ordering is the whole safety property: if
anything about the edge machine is wrong, destroying it puts things back exactly,
and the name is never down. Deploying both groups at once would be one step
shorter and would mean a failed edge boot leaves him with no app at all.

**0. Nothing else may be deploying.** Two `fly deploy` runs against one app race,
and these steps bypass the `pre-receive` lock:

```bash
cat /Users/skip/work/deploy/locks/fly.live.toml.lock   # absent, or a dead pid
```

**1. Take a copy of the node state.** Copy, never move — the app machine keeps
its own until step 5.

```bash
fly sftp get -c fly.live.toml /app/server/persist/tailscale/tailscaled.state ./tailscaled.state
test -s tailscaled.state && echo "have $(wc -c < tailscaled.state) bytes"
```

**2. Create the edge volume, same region as the app.**

```bash
fly volumes create edge_ts_state -c fly.live.toml -r sjc -s 1
```

**3. Seed it.** A throwaway machine is the only way to write a volume no machine
has mounted yet. Use the image the app is running now:

```bash
fly machine run "$(fly status -c fly.live.toml --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).Machines[0].config.image))')" \
  -c fly.live.toml -r sjc -v edge_ts_state:/var/lib/tlda-edge --rm sleep 600
# in another shell, against the machine id it printed:
fly ssh console -c fly.live.toml -s -C "mkdir -p /var/lib/tlda-edge/tailscale"
fly sftp shell -c fly.live.toml    # put ./tailscaled.state /var/lib/tlda-edge/tailscale/tailscaled.state
```

**Check before going on:** the file is on the volume, 2.7 KB, not zero.

**4. Bring up the edge machine only.** The app group keeps its current image and
its tailscaled.

```bash
fly deploy -c fly.live.toml --process-groups edge
```

**Check, and this is the one that matters:** the node did not rename, and the
name serves through the proxy.

```bash
curl -fsS https://tlda-fly.cormorant-matrix.ts.net/api/build-info
fly logs -c fly.live.toml --no-tail | grep '\[edge\]'
```

If the hostname moved to `tlda-fly-1`, **stop**: destroy the edge machine, and
the app machine still holds `tlda-fly`. Nothing was lost and step 1 or 3 is
wrong.

There is a brief window here where the app machine and the edge machine hold the
same node key. That is why step 5 follows immediately rather than later.

**5. Land the app group.** This is the deploy that deletes tailscaled from the
app container — and it is the first live proof of the whole thing, because the
front door should hold his connections across it.

```bash
fly deploy -c fly.live.toml --process-groups app
```

**6. Make it the default.** In `/Users/skip/work/deploy/hooks/pre-receive-common.sh`,
which is outside git:

```diff
-    fly deploy -c "$fly_config"
+    fly deploy -c "$fly_config" --process-groups app
```

Until that line lands, an ordinary `git push` deploys **both** groups and takes
the name down — which is the thing this arrangement exists to stop. Do not land
it before step 5; it buys nothing until the edge group exists.

### Rollback

Before step 6, the whole cutover is undone by destroying one machine:

```bash
fly machine destroy <edge-machine-id> -c fly.live.toml --force
```

After step 5 the app container no longer runs tailscaled, so a rollback is that
destroy **plus** redeploying the app group from a `main` without these commits.

### What the move costs

`server/lib/tailscale-peers.mjs` shells out to `tailscale status --json` in the
app container to stamp a chat sender's machine name onto message metadata. There
is no tailscaled in that container any more, so the lookup returns null and the
stamp is omitted. It is omitted, never guessed wrong — that module is
fail-visible by construction. Closing it means either the edge publishing its
peer map or the app machine holding a tailnet node of its own without `serve`.

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

## What you push replaces what the daemon is running, so it must contain it

`post-receive` on the deploy repo does not only ship the server. It fetches the
deployed sha into the daemon's checkout, `reset --hard`s that checkout to it, and
`launchctl kickstart -k`s the daemon. So **the daemon tracks the deployed sha, not
`main`** — it cannot be left behind it and cannot be left ahead of it.

That makes a push a replacement rather than an addition. **If the sha you push does
not contain what the server and daemon are running now, the push removes it** — no
one chooses that, and nothing reports it.

**It fires on any accepted push, not only a push of `main`.** A hotfix, an unrelated
branch or a revert moves the daemon off its current sha just as completely.

**Check before pushing, not after:**

```sh
# what the server is running now
curl -s -H "Authorization: Bearer $TOKEN" "$SERVER/api/build-info"   # -> gitSha

# every commit live on that sha that the sha you are about to push does NOT contain
git cherry <sha-you-are-pushing> <deployed-gitSha>   # any "+" line is work the push deletes
```

`git cherry` rather than `git merge-base --is-ancestor`: `main` here is assembled by
cherry-pick, so the deployed sha is a copy and ancestry reports "missing" for work that
is fully present. `git cherry` compares patches and marks a landed copy `-`.

**A "+" line is not a merge conflict to resolve later. It is code that is running in
production and will stop running the moment the push is accepted.**

Measured instance, 2026-08-18: the server reported `gitSha fb985dd4`, which was not an
ancestor of this repo's `main`, and `main` was missing **all 29** of its commits —
including two fixes to the daemon's outbox ack path that existed nowhere else. Deploying
`main` at that moment would have reverted the running server and daemon by 29 commits
and reintroduced the outage that had been diagnosed hours earlier. The 29 were landed
onto `main` first; `git cherry main fb985dd4` then reported all 29 as `-`.

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
