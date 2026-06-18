#!/usr/bin/env node

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const PY = `
import importlib.util
import types
import sys
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
assert any(m["alias"] == "gpt" and m["id"] == "gpt-5.5" and m["kind"] == "codex"
           for m in mod.HARNESS_ADAPTERS["codex"].list_models())
assert "CLAUDE.md" not in mod.register_prompt("canary")
codex_prompt = mod.codex_register_prompt("canary")
assert 'register(name="canary")' in codex_prompt
assert "CLAUDE.md" in codex_prompt
assert "AGENTS.md" in codex_prompt
assert "required skill" in codex_prompt
assert 'skill("<name>")' in codex_prompt

cmd = mod.build_codex_cmd(
    "fleet:test123",
    "fleet-canary",
    model="gpt-5.5",
    name="canary",
    cwd="/Users/skip/work/tlda",
    capability="workspace-write+net",
)
assert "-s workspace-write" in cmd

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

policy_name, dev_tools, write_roots, matched, policy, role_cmd = resolve_capability("workspace-write-no-net")
assert policy_name == "cwd"
assert dev_tools is True
assert write_roots == ["/Users/skip/work/tlda"]
assert matched == "/Users/skip/work/tlda"
assert policy["write_roots"] == ["/Users/skip/work/tlda"]
assert policy["network"] is False
assert "-s danger-full-access" in role_cmd
wrapped = mod.wrap_sandbox_cmd(role_cmd, policy)
assert "fence --settings" in wrapped
assert " codex " in wrapped
settings_path = wrapped.split("--settings ", 1)[1].split(" ", 1)[0]
with open(settings_path) as f:
    settings = mod.json.load(f)
assert "/Users/skip/work/tlda" in settings["filesystem"]["allowWrite"]
assert "**/.git/**" in settings["filesystem"]["denyWrite"]

policy_name, dev_tools, write_roots, matched, policy, role_cmd = resolve_capability("workspace-write+net")
assert policy_name == "cwd"
assert dev_tools is True
assert write_roots == ["/Users/skip/work/tlda"]
assert matched == "/Users/skip/work/tlda"
assert policy["network"] is True
assert "/Users/skip/work/tlda" in policy["write_roots"]
assert "/Users/skip/work/tlda/.git" in policy["write_roots"]
assert mod.os.path.expanduser("~/.config/tlda") in policy["write_roots"]
assert "-s danger-full-access" in role_cmd

policy_name, dev_tools, write_roots, matched, policy = mod.resolve_harness_sandbox(
    "codex", "gpt-5.5", "/Users/skip/work/tlda",
    explicit_policy="tlda-projects")
policy = mod.apply_spawn_capability_to_policy(policy, "workspace-write+net", "/Users/skip/work/tlda")
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

policy_name, dev_tools, write_roots, matched, policy = mod.resolve_harness_sandbox(
    "codex", "gpt-5.5", "/Users/skip/work/tlda")
assert policy_name == "cwd"
assert dev_tools is True
assert write_roots == ["/Users/skip/work/tlda"]
assert matched == "/Users/skip/work/tlda"
assert policy is not None

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
})
