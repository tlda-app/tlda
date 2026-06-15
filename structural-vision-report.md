# report

## the-complete-vision {#the-complete-vision}

**Worktree `structural-vision` — the complete structural-invalidation vision, end-to-end and tested.**

This is the lesson from the physics package made real: **invalidation along the dependency graph**, surfaced as tasks and rendered as a cascade. Built on what's already on `main` (typed inbox + the pure cascade engine), it adds the two layers you sketched.

### What it does

An edit goes stale on the ribbon → the proof-dependency graph is walked → the consequences show up in the inbox two ways:

- **Directly-stale** — a proof node whose *own* statement source changed. Shows in **Tasks** with an **approve** action.
- **Cascade-stale** — a node that (transitively) *depends on* a changed node. Shows in **Cascade** as "depends on …". It has no edit of its own; it clears when its upstream is re-approved.

**Approve-upstream-clears-downstream**: approving a root re-vets its span and clears everything reachable beneath it. Approving Prop 8.2 clears Prop 8.2 **and** its cascade Prop 8.3 — while the independent Prop 7.1 is untouched. All of it is *derived from the live ribbon*, so it auto-resolves with no separate store.

### Three views (time / type / **graph**)

**Tasks + Cascade, grouped by type:**

/Users/skip/work/tlda/.worktrees/structural-vision/inbox-structural-before.png

**The cascade rendered as an actual graph** — amber roots up top, the nodes that rest on them below, arrows following the dependency edges. Click a root to approve-and-clear-downstream right from the graph:

/Users/skip/work/tlda/.worktrees/structural-vision/inbox-structural-graph.png

### One algorithm, two entry points

`src/invalidationGraph.ts` (client) mirrors `server/lib/invalidation-graph.mjs` (the dry-run engine on `main`) exactly — the live inbox needs no server round-trip, and a *proposed* edit can dry-run the same cascade for the scratch-file-commit edit-driver later.

### Tested

Headless on `balancing-act`, **6/6 checks** (`bin/inbox-structural-test.mjs`): editing Prop 8.2's statement surfaces directly-stale Prop 8.2 + cascade-stale Prop 8.3 ("depends on Prop 8.2"); the graph view shows both roots, the cascade node, and the edge `prop:matching-cost → prop:matching-achievable`; approving Prop 8.2 from the graph clears it and Prop 8.3, leaves Prop 7.1, and re-anchors the span to the current commit.

Two commits on the worktree (`d25d6b02` task surface, `5060032d` graph + approve-from-graph). Nothing merged — your call. Want a headed tour, or should I queue the merge?
