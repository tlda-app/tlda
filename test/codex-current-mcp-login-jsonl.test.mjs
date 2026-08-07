import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { formatLoginMarker, extractIdentityFromRecord } from '../agent-runtime/daemon-jsonl-hot-path.mjs'
import { scanCodexRolloutIdentity } from '../agent-launch/resume.mjs'

const loginText = [
  formatLoginMarker({
    mint_id: 'local:current-codex-login',
    fleet_id: 'fleet:current-codex-login',
    friendly_name: 'current-codex-login',
  }),
  'Logged in fleet:current-codex-login.',
  'Your name: "current-codex-login"',
].join('\n')

test('daemon JSONL hot path reads current Codex MCP login item results', () => {
  const identity = extractIdentityFromRecord({
    type: 'event_msg',
    payload: {
      item: {
        type: 'McpToolCall',
        server: 'tlda',
        tool: 'login',
        result: { content: [{ type: 'text', text: loginText }] },
      },
    },
  })

  assert.equal(identity.fleet_id, 'fleet:current-codex-login')
  assert.equal(identity.friendly_name, 'current-codex-login')
  assert.equal(identity.marker.mint_id, 'local:current-codex-login')
})

test('Codex rollout scanner reads current MCP login events', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-current-codex-login-'))
  const fpath = join(dir, 'rollout-current.jsonl')
  try {
    writeFileSync(fpath, [
      JSON.stringify({ payload: { type: 'session_meta', id: 'current', cwd: dir, timestamp: '2026-08-07T00:00:00.000Z' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          item: {
            type: 'McpToolCall',
            server: 'tlda',
            tool: 'login',
            result: { content: [{ type: 'text', text: loginText }] },
          },
        },
      }),
      '',
    ].join('\n'))

    const identity = scanCodexRolloutIdentity(fpath)
    assert.equal(identity.ownId, 'fleet:current-codex-login')
    assert.equal(identity.localAgentId, 'local:current-codex-login')
    assert.equal(identity.agentName, 'current-codex-login')
    assert.equal(identity.sessionMeta.cwd, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
