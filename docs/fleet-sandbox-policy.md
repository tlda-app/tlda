# Fleet Sandbox Policy

This is the intended permission model for spawned fleet agents.

## Core Model

The primary policy axis is write scope: who can write, and where.

- `no-dev`: no native developer surface. The agent may use safe MCP/context tools, but should not get shell/file-edit tools that can mutate the machine.
- `cwd`: the agent may write inside its launch working directory.
- `tlda-projects`: the agent may write configured tlda project/source roots. This is a TLDA-specific mode: broader than one working directory, but still bounded to frequently versioned project material.
- `unsandboxed`: no fence write restriction. This is for trusted owner/operator lanes, not ordinary spawned work. The current public spawn label for this is `full-access`; that label should map to this policy explicitly.

These names are the policy vocabulary. Harness-specific permission modes and tool prompts are projections of this policy, not the authority.

## Authority Boundary

Fence, or the configured outer sandbox runner, is the authority for native developer access.

The harness should run as normally as possible inside that boundary. For Codex, that means avoiding a nested Codex/macOS sandbox when an outer fence lease is active, because the nested sandbox can fail before commands run. For Claude, it means using the least noisy permission mode compatible with the lease. For other harnesses, the adapter should project the same lease into that harness without changing the policy semantics.

MCP approval prompts are not the security boundary. TLDA MCP tools should be trusted or denied by server-side policy and by the outer sandbox, not by asking Skip about routine `register`, `my_task`, `chat`, `read_doc`, etc.

## Secondary Knobs

Write scope is the core policy. Other grants are secondary knobs attached to the lease:

- read roots
- git rights
- network access
- local control-plane access for the fleet/tlda server
- trusted MCP servers/tools
- artifact/cache write locations

Network may be part of the capability model, but it should not obscure the write-scope vocabulary. For example, a `cwd` agent may need local/Fly control-plane access so `my_task()` works; that does not mean it gets broader write authority.

### Git Rights

Git rights are an orthogonal lease axis:

- `git: none`: do not rely on git commands being available.
- `git: read`: workspace writes may be allowed, but git metadata writes must be denied. Agents can inspect status, diffs, logs, and history, but they cannot stage, commit, move branches, update refs, or mutate the index.
- `git: write`: the lease may write git metadata. This should be reserved for lanes that are explicitly allowed to manage commits.

For `git: read`, enforcement should happen at the filesystem boundary, not by prompt text. The denied write set must include repository `.git/` directories, linked-worktree gitdirs, submodule gitdirs, common git dirs discovered from git, and other ref/index/reflog storage. Set `GIT_OPTIONAL_LOCKS=0` where possible so read-only git commands do not attempt unnecessary index refreshes.

## Spawn Capability Labels

Current MCP/API labels such as `read-only`, `workspace-write-no-net`, and `workspace-write+net` are implementation labels. They should be reconciled against the policy vocabulary above:

- `read-only` should map to a fence lease with no workspace write roots.
- `workspace-write-*` should map to `cwd` write scope, with network as a secondary knob.
- `full-access` should map to explicit `unsandboxed` while that escape hatch exists. If the goal is "everything goes through fence," then it should become a permissive fence lease rather than bypassing fence.

Until this reconciliation is complete, do not present the implementation labels as the product spec.

## Invariants

- A spawned agent cannot receive a stronger policy than its caller is allowed to grant.
- A model/harness ceiling may cap the strongest policy available to that model.
- The caller may choose any policy at or below those ceilings; ceilings do not force an upgrade.
- Missing policy for a non-human agent should resolve to a conservative default, not `unsandboxed`.
- Human/owner rows may be treated as root for spawning, but that should be explicit in server policy.

## Operational Requirements

For a spawned agent, these should work inside the granted policy:

- `register()` and `my_task()`
- chat wakeups
- clean `git status --short` when git read access is allowed
- expected write success or denial according to write scope
- no routine harness approval prompts for trusted TLDA MCP tools

For Codex on macOS/Fly, current implementation details include:

- inject the Fly/tlda API into Codex MCP config, because Codex does not pass process env to MCP subprocesses
- preload a Node DNS alias for the Fly tailnet hostname when fenced Node DNS cannot resolve it
- allow only the needed local/Tailnet control-plane path for fleet tools
- redirect Git/Xcode temp/config reads into `/tmp` so normal read-only commands do not fail on user-level files

Those are implementation details, not policy vocabulary.
