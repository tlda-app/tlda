#!/usr/bin/env node

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const PY = `
import importlib.util
spec = importlib.util.spec_from_file_location("fleet_spawn", "bin/fleet-spawn.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

assert mod.infer_harness_kind("claude", "gpt-5.5") == "codex"
assert mod.infer_harness_kind(None, "gpt-5.5") == "codex"
assert mod.infer_harness_kind("claude", "gpt-5.5-codex") == "codex"
assert mod.infer_harness_kind("claude", "opus46") == "claude"
assert mod.infer_harness_kind("goose", "gpt-5.5") == "goose"
assert mod.harness_for_spawn("claude", "gpt-5.5").kind == "codex"

cmd = mod.build_codex_cmd(
    "fleet:test123",
    "fleet-canary",
    model="gpt-5.5",
    name="canary",
    cwd="/Users/skip/work/tlda",
    capability="workspace-write+net",
)
assert "-s workspace-write" in cmd
assert "sandbox_workspace_write.network_access=true" in cmd
assert "/Users/skip/.config/tlda" in cmd
assert "/Users/skip/work/tlda/.git" in cmd

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
