import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveLiveSessionIdentity } from '../agent-launch/harness/claude.mjs'

test('Claude identity resolver binds the process-owned transcript, not an adjacent same-cwd transcript', async () => {
  const calls = []
  const identity = await resolveLiveSessionIdentity({
    agent: { id: 'fleet:claude-process-owned', cwd: '/tmp/shared-cwd' },
    tmuxSession: 'fleet-claude-process-owned',
    processOwnedOnly: true,
    _deps: {
      execFile: async (command) => command === 'tmux'
        ? { stdout: '101\n' }
        : { stdout: '101 1 bash\n202 101 claude\n404 1 claude\n' },
      resolveTranscript: async (args) => {
        calls.push(args)
        return args.pid === '202' ? '/tmp/.claude/projects/-tmp-shared-cwd/process-owned.jsonl' : '/tmp/.claude/projects/-tmp-shared-cwd/adjacent.jsonl'
      },
      readFileSync: () => JSON.stringify({ model: 'claude-sonnet' }) + '\n',
    },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].pid, '202')
  assert.equal(calls[0].processOwnedOnly, true)
  assert.equal(identity.sessionId, 'process-owned')
  assert.equal(identity.jsonlPath.endsWith('process-owned.jsonl'), true)
  assert.equal(identity.model, 'claude-sonnet')
})

test('Claude identity resolver returns pending when the target pane has ambiguous Claude descendants', async () => {
  const identity = await resolveLiveSessionIdentity({
    agent: { id: 'fleet:claude-ambiguous', cwd: '/tmp/shared-cwd' },
    tmuxSession: 'fleet-claude-ambiguous',
    processOwnedOnly: true,
    _deps: {
      execFile: async (command) => command === 'tmux'
        ? { stdout: '101\n' }
        : { stdout: '101 1 bash\n202 101 claude\n303 101 claude\n' },
      resolveTranscript: async () => { throw new Error('must not resolve an ambiguous owner') },
    },
  })
  assert.equal(identity, null)
})
