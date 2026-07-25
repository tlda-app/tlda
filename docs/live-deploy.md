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

### If the checkout is dirty with someone else's work

Preflight requires the **main checkout on branch `main`, clean** — it rejects
worktrees explicitly (`identity.isWorktree`), so "deploy from a clean worktree at
the commit" is not available as a way around a dirty tree. In a shared checkout
that other agents work in, the blocker is usually somebody's uncommitted WIP.

The right first move is to get its owner to commit it. If that is not possible
and the deploy is genuinely urgent, parking it is acceptable — but:

**Parking someone's uncommitted work is a promise to restore it, and that promise
has been broken more than once.** `git stash list` on this repo has carried
entries like *"AGENTS.md process guard (not mine, stashing to unblock Gate2A
deploy preflight)"* — parked by an agent that never came back for it. A stash is
invisible: nobody discovers their work is missing until they look.

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
