import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scanCodexRolloutIdentity } from '../agent-launch/resume.mjs'

function writeRollout(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-rollout-login-'))
  const file = path.join(dir, 'rollout.jsonl')
  fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n')
  return { dir, file }
}

{
  const { dir, file } = writeRollout([
    { payload: { type: 'session_meta', cwd: '/tmp/tlda-login-test', timestamp: new Date().toISOString() } },
    { payload: { type: 'function_call', namespace: 'mcp__tlda', name: 'login', call_id: 'call-login' } },
    { payload: { type: 'function_call_output', call_id: 'call-login', output: 'Logged in fleet:abc_123.\nYour name: "login-smoke" — other agents and the user know you by this name.' } },
  ])
  try {
    const result = scanCodexRolloutIdentity(file)
    assert.equal(result.ownId, 'fleet:abc_123')
    assert.equal(result.agentName, 'login-smoke')
    assert.equal(result.sessionMeta.cwd, '/tmp/tlda-login-test')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

{
  const { dir, file } = writeRollout([
    { payload: { type: 'mcp_tool_call_end', invocation: { server: 'tlda', tool: 'login' }, result: [{ type: 'text', text: 'Logged in fleet:def-456.\nYour name: "dash-name" — other agents and the user know you by this name.' }] } },
  ])
  try {
    const result = scanCodexRolloutIdentity(file)
    assert.equal(result.ownId, 'fleet:def-456')
    assert.equal(result.agentName, 'dash-name')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

console.log('agent-launch resume login parser ok')
