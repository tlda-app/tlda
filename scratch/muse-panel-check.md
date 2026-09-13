# The panel check for a Muse agent, prepared before the ref moves

Written 2026-09-12 ~23:0x EDT by `muse-keychain-start`, against branch
`muse-harness-land` (current `main` + the one Muse adapter commit).

This exists so the panel observation is not improvised at midnight. Everything
below except the final step has already been run.

## What the panel row actually proves, and what it does not

`agent-launch/tmux.mjs` `runtimeStateFromProcessList(panePids, psText)` walks the
pane's process subtree and returns `{ runtime, mcp, daemonKey, fleetId, envName }`.
The Muse commit adds one alternative to its matcher, `muse(?:-bin-[\w.-]+)?`,
because the launcher execs a versioned binary and that binary becomes the pane
process itself.

Measured against the still-live `fleet-muse-spark-framing` pane, real `ps`
snapshot, pane pid 36556:

```
runtime: true   mcp: true   daemonKey: null   fleetId: null   envName: null
```

### Three false passes, in the order you are likely to hit them

**1. The row appearing is not evidence.** The agents panel renders a row for
every agent in the store, hibernating included — all six existing Muse agents
already list under `roster(filter: "model:muse")` with no process anywhere. Seeing
`muse-...` in the panel says nothing about runtime detection.

**2. `runtime: true` is not evidence either, and this is the sharp one.** The
matcher's second alternative is `node ... .mjs`, which matches our own MCP server
child. With the Muse alternative deleted, the walk falls through to it and
**still returns `runtime: true`.** Measured, same real snapshot:

```
muse alternative removed →  runtime: true   mcp: false
```

So an assertion on "the agent reads as running" goes green with the Muse work
removed. It cannot go red, and it is therefore not a measurement.

**3. `probed: false` reads as an absence.** `sessionRuntimeState` returns
`runtime: false` both when tmux answered and there is no runtime, and when tmux
was missing or `ps` blew its 5s timeout. The comment above it says so. On a box
with 750+ processes under load, that timeout is live. Require `probed: true`
before believing a negative.

### The one discriminating field

**`mcp === true`.** It is `true` only when the Muse binary matched first, which
is what puts the MCP server in its descendant set; when the walk falls through to
the node branch it stops *at* the MCP server, which then has no matching
descendant, so `mcp` flips `false`. That single field is the whole difference.

The counterfactual is already run and it is clean. Patching the Muse alternative
out of `tmux.mjs` turns the existing unit test red on exactly that assertion, and
restoring it turns it green:

```sh
node --test agent-launch/harness/muse.test.mjs      # 10/10 with the pattern
                                                    # 1 fail without it, rc 1
```

**So no new instrument is needed.** `agent-launch/harness/muse.test.mjs` already
discriminates — it asserts `mcp === true` and carries its own negative control
for the whole mechanism. What is missing is only the end-to-end observation, not
a check to make.

## The identity fields are null, and this is the Claude case, not a Muse gap

The Muse pane process exposes no identity in `argv`, because `buildCmd` puts the
assignments ahead of `muse` inside `zsh -lc`, so they become environment rather
than argv and the exec leaves only the binary and its flags. Hence the three
nulls.

**That is the same shape Claude has, and it is already designed for.** Of the 111
processes in the snapshot carrying `FLEET_ID=` in argv, 53 are `node` MCP servers
and 53 are `codex`; none are `claude`. The Claude pane process checked carries it
nowhere in its full 800-character args. `daemon/partial-mint-runtime-recovery.mjs`
names this outright — its case 14 comment reads *"This is the Claude case: no
FLEET_ID in the command for the probe to read."*

The adoption path handles it two ways. A ledger-derived fleet id with a coherent
single binding carries the adoption on its own (`rebind`, `identity:fleetId`); and
where the ledger has drifted, the fleet id is demoted but adoption still succeeds
on the full arrangement tuple (`rebind`, `coherent-tuple`) — *"the demotion costs
the shortcut, not the adoption."* It holds only when the ledger has drifted **and**
`model`/`daemonKey` are also missing, and both of those come off the binding the
mint writes.

So this is **cleared, not merely located**, and Muse needs nothing here.

## The run, when the ref has moved and the testing daemon is restarted

```sh
tlda agent mint muse-panel-proof --model muse
```

Then, in order:

1. `roster(filter: "muse-panel-proof")` shows status **awake**, model `muse`.
   Necessary, not sufficient — see false pass 1.
2. The pane: `tmux capture-pane -p -t fleet-muse-panel-proof` shows
   `2 MCP calls · tlda · ✓ ×2`, login then inbox.
3. **The assertion that counts:** `sessionRuntimeState('fleet-muse-panel-proof')`
   returns `mcp: true` and `probed: true`.
4. The panel itself, in Skip's own tab, read-only over CDP via `ssh air-agent` —
   the row present and reading as running. Before doing this, read `AGENTS.md`
   §"A browser is a last resort, not a gate" and the `app-testing` skill
   §"Skip's Chrome is observe-only"; both bound what you may do to that tab.

Read `AGENTS.md` §"A verification claim carries its evidence, or it is not a
claim" before writing the result up. It governs what this run has to carry and
what to do when a step stops.

## Left alone deliberately

`muse-live-check` and `muse-panel-proof` are husk rows from two failed mints:
live rows with no process, which is hibernating, which is correct. Nothing infers
death from a failed mint. They become wakeable once the adapter is live.
