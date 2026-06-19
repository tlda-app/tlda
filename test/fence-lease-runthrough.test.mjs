#!/usr/bin/env node

// Run-through acceptance gate (lease level). For each role profile, resolve the
// fence lease the way a real spawn does and assert it covers that role's actual
// job — so the fence never blocks legitimate work (Skip's "most important thing").
//
// This is the OFFLINE half of the run-through gate: it proves the lease is
// structurally correct for every role. The LIVE half — spawning a fenced agent
// of each role and running it through real work — is the team's pre-flip step
// (it re-sandboxes the running fleet, which is Skip's one-word go).

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const PY = `
import importlib.util, types, sys, json
sys.modules["websocket"] = types.SimpleNamespace(create_connection=lambda *a, **k: None)
spec = importlib.util.spec_from_file_location("fleet_spawn", "bin/fleet-spawn.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

CWD = "/Users/skip/work/tlda"

def lease_for(capability, policy_name):
    pn, dev, wr, matched, policy = mod.resolve_harness_sandbox(
        "claude", "opus48", CWD, explicit_policy=policy_name)
    policy = mod.apply_spawn_capability_to_policy(policy, capability, CWD)
    if policy is None:
        return pn, None, None
    return pn, policy, mod._fence_settings(policy)

# --- app role: workspace-write+net / cwd --------------------------------------
pn, policy, s = lease_for("workspace-write+net", "cwd")
assert pn == "cwd", pn
fs = s["filesystem"]; cmd = s["command"]
# job: write the worktree + dev caches
assert CWD in fs["allowWrite"]
assert mod.PLAYWRIGHT_CACHE_ROOT in fs["allowWrite"]
assert mod.TLDA_FENCE_TMP_ROOT in fs["allowWrite"]
assert mod.os.path.expanduser("~/.config/tlda") in fs["allowWrite"]
# job: dev server / npm
assert "/tmp" in fs["allowWrite"]
assert any("/.npm/" in p for p in fs["allowWrite"]), fs["allowWrite"]
# job: LOCAL git (commit/add/branch) must work -> .git NOT blanket-denied,
# and the repo's .git is a writable root.
assert "**/.git/**" not in fs["denyWrite"], fs["denyWrite"]
assert (CWD + "/.git") in fs["allowWrite"], fs["allowWrite"]
# job: broad network on; dev server binds a local port
assert policy["network"] is True
assert s["network"]["allowLocalBinding"] is True
# safety: the irrevocable / destructive commands stay blocked even for app
for banned in ("git push", "git reset", "git clean", "git rebase", "git merge", "sudo", "npm publish"):
    assert banned in cmd["deny"], (banned, cmd["deny"])

# --- math role: workspace-write+net / tlda-projects ---------------------------
pn, policy, s = lease_for("workspace-write+net", "tlda-projects")
assert pn == "tlda-projects", pn
assert policy["network"] is True
assert "**/.git/**" not in s["filesystem"]["denyWrite"]

# --- untrusted role: same lane as app (cwd) -----------------------------------
pn, policy, s = lease_for("workspace-write+net", "cwd")
assert pn == "cwd"

# --- read-only role: no writes, no broad net, git stays read-only -------------
# (local outbound to the tlda API stays allowed so the agent can still register/
# chat -- that is _api_needs_local_outbound, not the broad-internet flag.)
pn, policy, s = lease_for("read-only", "cwd")
assert pn == "cwd"
assert policy["network"] is False
assert policy["write_roots"] == []
assert "**/.git/**" in s["filesystem"]["denyWrite"]   # read-only cannot commit
assert (CWD + "/.git") not in s["filesystem"]["allowWrite"]

# --- ops role: full-access is unsandboxed (no fence at all) --------------------
pn, dev, wr, matched, policy = mod.resolve_harness_sandbox(
    "claude", "opus48", CWD, explicit_policy="unsandboxed")
assert pn == "unsandboxed", pn
assert policy is None   # no fence lease -> machine-level

print("OK")
`

describe('fence lease run-through gate', () => {
  it('every role profile gets a lease that covers its job and blocks the irrevocable', () => {
    const result = spawnSync('python3', ['-c', PY], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /OK/)
  })
})
