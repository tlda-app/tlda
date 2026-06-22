#!/usr/bin/env node

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const PY = `
import importlib.util
import types
import sys
import tempfile
import os
sys.modules["websocket"] = types.SimpleNamespace(create_connection=lambda *args, **kwargs: None)
spec = importlib.util.spec_from_file_location("fleet_spawn", "bin/fleet-spawn.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

assert mod.infer_harness_kind("claude", "gpt-5.5") == "codex"
assert mod.infer_harness_kind(None, "gpt-5.5") == "codex"
assert mod.infer_harness_kind("claude", "gpt-5.5-codex") == "codex"
assert mod.infer_harness_kind("claude", "opus46") == "claude"
assert mod.infer_harness_kind("goose", "gpt-5.5") == "goose"
assert mod.harness_for_spawn("claude", "gpt-5.5").kind == "codex"
assert mod.harness_for_spawn("claude", "gpt").kind == "codex"
assert mod.harness_for_spawn("claude", "gpt").resolve_model("gpt") == "gpt-5.5"
assert mod.harness_for_agent({"id": "fleet:stale", "metadata": {"kind": "claude", "model": "gpt-5.5"}}).kind == "codex"
assert mod.harness_for_agent({"id": "fleet:stale", "metadata": {"kind": "claude"}}, "gpt-5.5").kind == "codex"
assert any(m["alias"] == "gpt" and m["id"] == "gpt-5.5" and m["kind"] == "codex"
           for m in mod.HARNESS_ADAPTERS["codex"].list_models())
assert mod.DEFAULT_SPAWN_CAPABILITY == "write"
assert "CLAUDE.md" not in mod.register_prompt("canary")
codex_prompt = mod.codex_register_prompt("canary")
assert 'register(name="canary")' in codex_prompt
assert "CLAUDE.md" in codex_prompt
assert "AGENTS.md" in codex_prompt
assert "required skill" in codex_prompt
assert 'skill("<name>")' in codex_prompt
assert "Non-Claude guidance contract" in codex_prompt
assert "user-visible reports are ground truth" in codex_prompt
assert "proof obligations are requirements" in codex_prompt

cmd = mod.build_codex_cmd(
    "fleet:test123",
    "fleet-canary",
    model="gpt-5.5",
    name="canary",
    cwd="/Users/skip/work/tlda",
    capability="workspace-write",
)
assert "-s workspace-write" in cmd
assert "-C /Users/skip/work/tlda" in cmd

goose_cmd = mod.build_goose_cmd("fleet:test123", "fleet-goose-canary", "deepseek/deepseek-chat", name="goose-canary")
assert "XDG_CONFIG_HOME=" in goose_cmd
assert "XDG_DATA_HOME=" in goose_cmd
assert "XDG_CACHE_HOME=" in goose_cmd
assert "XDG_STATE_HOME=" in goose_cmd
assert "--with-builtin developer,summon" in goose_cmd
assert mod.os.path.expanduser("~/.local/share") in goose_cmd
assert mod.os.path.isdir(mod.os.path.join(mod.GOOSE_STATE_ROOT, "fleet-test123", "cache"))
assert mod.os.path.isdir(mod.os.path.join(mod.GOOSE_STATE_ROOT, "fleet-test123", "state"))
goose_recipe = open(mod.DEEPSEEK_RECIPE).read()
assert "Non-Claude guidance contract" in goose_recipe
assert "CLAUDE.md" in goose_recipe
assert "AGENTS.md" in goose_recipe
assert "Proof obligations are requirements" in goose_recipe

def resolve_capability(capability):
    policy_name, dev_tools, write_roots, matched, policy = mod.resolve_harness_sandbox(
        "codex", "gpt-5.5", "/Users/skip/work/tlda",
        explicit_policy=mod.sandbox_policy_for_spawn_capability(capability))
    policy = mod.apply_spawn_capability_to_policy(policy, capability, "/Users/skip/work/tlda")
    cmd = mod.build_codex_cmd(
        "fleet:test123",
        "fleet-canary",
        model="gpt-5.5",
        name="canary",
        cwd="/Users/skip/work/tlda",
        capability=capability,
        outer_sandbox=bool(policy),
    )
    return policy_name, dev_tools, write_roots, matched, policy, cmd

policy_name, dev_tools, write_roots, matched, policy, role_cmd = resolve_capability("full-access")
assert policy_name == "unsandboxed"
assert dev_tools is True
assert write_roots == []
assert matched is None
assert policy is None
assert "-s danger-full-access" in role_cmd
assert "fence --settings" not in role_cmd

# Legacy "workspace-write-no-net" is a DELETED rung: net is always on now
# (Skip: "everyone always gets network"), so it migrates to write -- net ON,
# dev write-roots added. This is a spec'd behavior change for legacy no-net
# agents, not the old no-net/cwd-only policy.
policy_name, dev_tools, write_roots, matched, policy, role_cmd = resolve_capability("workspace-write-no-net")
assert policy_name == "cwd"
assert dev_tools is True
assert write_roots == ["/Users/skip/work/tlda"]
assert matched == "/Users/skip/work/tlda"
assert policy["network"] is True
assert "/Users/skip/work/tlda/.git" in policy["write_roots"]
assert mod.os.path.expanduser("~/.config/tlda") in policy["write_roots"]
assert "-s danger-full-access" in role_cmd
# (no-net now == write; the wrapped-settings behavior is covered by the
# workspace-write block below — no need to re-test it here.)

policy_name, dev_tools, write_roots, matched, policy, role_cmd = resolve_capability("workspace-write")
assert policy_name == "cwd"
assert dev_tools is True
assert write_roots == ["/Users/skip/work/tlda"]
assert matched == "/Users/skip/work/tlda"
assert policy["network"] is True
assert "/Users/skip/work/tlda" in policy["write_roots"]
assert "/Users/skip/work/tlda/.git" in policy["write_roots"]
assert mod.os.path.expanduser("~/.config/tlda") in policy["write_roots"]
assert mod.PLAYWRIGHT_CACHE_ROOT in policy["write_roots"]
assert mod.TLDA_FENCE_TMP_ROOT in policy["write_roots"]
assert "-s danger-full-access" in role_cmd
assert mod.PLAYWRIGHT_CACHE_ROOT not in role_cmd
assert mod.TLDA_FENCE_TMP_ROOT not in role_cmd
wrapped = mod.wrap_sandbox_cmd(role_cmd, policy)
settings_path = wrapped.split("--settings ", 1)[1].split(" ", 1)[0]
with open(settings_path) as f:
    settings = mod.json.load(f)
assert mod.PLAYWRIGHT_CACHE_ROOT in settings["filesystem"]["allowWrite"]
assert mod.TLDA_FENCE_TMP_ROOT in settings["filesystem"]["allowWrite"]

policy_name, dev_tools, write_roots, matched, policy = mod.resolve_harness_sandbox(
    "codex", "gpt-5.5", "/Users/skip/work/tlda",
    explicit_policy="tlda-projects")
policy = mod.apply_spawn_capability_to_policy(policy, "workspace-write", "/Users/skip/work/tlda")
assert policy_name == "tlda-projects"
assert policy["network"] is True

policy_name, dev_tools, write_roots, matched, policy, role_cmd = resolve_capability("read-only")
assert policy_name == "cwd"
assert dev_tools is True
assert write_roots == ["/Users/skip/work/tlda"]
assert matched == "/Users/skip/work/tlda"
assert policy["write_roots"] == []
assert policy["network"] is False
assert "-s danger-full-access" in role_cmd

with tempfile.TemporaryDirectory() as td:
    cfg = os.path.join(td, "config.toml")
    assert mod.ensure_codex_project_trusted("/Users/skip/work/balancing-act", cfg) is True
    first = open(cfg).read()
    assert '[projects."/Users/skip/work/balancing-act"]' in first
    assert 'trust_level = "trusted"' in first
    assert mod.ensure_codex_project_trusted("/Users/skip/work/balancing-act", cfg) is False
    assert open(cfg).read() == first

policy_name, dev_tools, write_roots, matched, policy = mod.resolve_harness_sandbox(
    "codex", "gpt-5.5", "/Users/skip/work/tlda")
assert policy_name == "cwd"
assert dev_tools is True
assert write_roots == ["/Users/skip/work/tlda"]
assert matched == "/Users/skip/work/tlda"
assert policy is not None

effective_policy = mod._live_spawn_policy(
    mod.sandbox_policy_for_spawn_capability("write"),
    explicit=False)
assert effective_policy == "unsandboxed"
policy_name, dev_tools, write_roots, matched, policy = mod.resolve_harness_sandbox(
    "codex", "gpt-5.5", "/Users/skip/work/tlda",
    explicit_policy=effective_policy)
assert policy_name == "unsandboxed"
assert policy is None
global_off_cmd = mod.build_codex_cmd(
    "fleet:test123",
    "fleet-canary",
    model="gpt-5.5",
    name="canary",
    cwd="/Users/skip/work/tlda",
    capability="write",
    outer_sandbox=bool(policy) or policy_name == "unsandboxed",
)
assert "-s danger-full-access" in global_off_cmd

class FakeResult:
    def __init__(self, returncode=0, stdout=""):
        self.returncode = returncode
        self.stdout = stdout

calls = []
def fake_tmux(*args):
    return ["tmux", *args]
def fake_run(cmd, *args, **kwargs):
    calls.append(cmd)
    if cmd[:2] == ["tmux", "list-panes"]:
        return FakeResult(stdout="100\\n")
    if cmd[:3] == ["ps", "-eo", "pid,ppid,args"]:
        return FakeResult(stdout="""  PID  PPID ARGS
100 1 zsh
101 100 /opt/homebrew/bin/codex -m gpt-5.5
""")
    return FakeResult(returncode=1)

orig_tmux = mod.tmux
orig_run = mod.subprocess.run
try:
    mod.tmux = fake_tmux
    mod.subprocess.run = fake_run
    assert mod._session_has_runtime("fleet-child-codex") is True
finally:
    mod.tmux = orig_tmux
    mod.subprocess.run = orig_run

sent_messages = []
class FakeWs:
    def send(self, payload):
        sent_messages.append(mod.json.loads(payload))
    def recv(self):
        return '{"ok": true}'

orig_read_config = mod.read_config
orig_create_connection = mod.websocket.create_connection
try:
    mod.read_config = lambda: {"machineId": "air"}
    mod.websocket.create_connection = lambda *args, **kwargs: FakeWs()
    mod.ws_register("fleet:test123", "canary", "fleet-canary", "/tmp", kind="codex")
    assert sent_messages[-1]["machine_id"] == "air"
finally:
    mod.read_config = orig_read_config
    mod.websocket.create_connection = orig_create_connection
`

describe('fleet-spawn harness kind inference', () => {
  it('routes Codex gpt models through the Codex adapter when kind is omitted by stale callers', () => {
    const result = spawnSync('python3', ['-c', PY], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
  })

  it('does not create an agent for direct spawn dry-run', () => {
    const result = spawnSync('python3', [
      'bin/fleet-spawn.py',
      '--fresh', 'dryrun-canary',
      '--model', 'gpt-5.5',
      '--kind', 'codex',
      '--cwd', '/Users/skip/work/tlda',
      '--dry-run',
      '--no-attach',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /would fresh spawn dryrun-canary with capability write/)
    assert.doesNotMatch(result.stdout, /spawned in/)
  })
})
