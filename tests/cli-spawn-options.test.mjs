import assert from 'node:assert/strict'
import test from 'node:test'

import {
  bindLifecycleCodexResumeIdentity,
  collectSpawnModelOptionsFromRaw,
  spawnPositionalFromRaw,
} from '../cli/tlda.mjs'

test('CLI spawn forwards recursive model option flags as modelOptions', () => {
  const args = [
    '--fresh',
    '--model', 'terra',
    '--verbosity', 'long',
    '--effort', 'high',
    '--permissions', 'app-dev',
    'helm',
  ]

  assert.equal(spawnPositionalFromRaw(args, 0), 'helm')
  assert.deepEqual(collectSpawnModelOptionsFromRaw(args), {
    verbosity: 'long',
    effort: 'high',
  })
})

test('CLI lifecycle codex spawn binds resume identity into existing ledger row', async () => {
  const result = {
    harness: 'codex',
    fleetId: 'fleet:test-cli-bind',
    tmuxSession: 'fleet-test-cli-bind',
    name: 'test-cli-bind',
  }
  const writes = []
  const resolved = await bindLifecycleCodexResumeIdentity(result, {
    cwd: '/tmp/tlda-cli-bind',
    name: 'test-cli-bind',
    timeoutMs: 0,
    intervalMs: 0,
    ledger: {
      setSessionSync(id, row) {
        writes.push({ id, row })
      },
    },
    resolveIdentity: async ({ agent, tmuxSession }) => {
      assert.equal(agent.id, 'fleet:test-cli-bind')
      assert.equal(agent.friendly_name, 'test-cli-bind')
      assert.equal(agent.cwd, '/tmp/tlda-cli-bind')
      assert.equal(agent.registered_at, undefined)
      assert.equal(tmuxSession, 'fleet-test-cli-bind')
      return {
        sessionId: '11111111-2222-4333-8444-555555555555',
        jsonlPath: '/tmp/rollout-11111111-2222-4333-8444-555555555555.jsonl',
      }
    },
  })

  assert.equal(resolved.bound, true)
  assert.equal(result.resumeId, '11111111-2222-4333-8444-555555555555')
  assert.deepEqual(writes, [{
    id: 'fleet:test-cli-bind',
    row: {
      sessionId: '11111111-2222-4333-8444-555555555555',
      sessionKind: 'codex',
      sessionPath: '/tmp/rollout-11111111-2222-4333-8444-555555555555.jsonl',
      cwd: '/tmp/tlda-cli-bind',
      friendlyName: 'test-cli-bind',
    },
  }])
})

test('CLI lifecycle codex wake treats existing resume id as bound', async () => {
  const result = {
    harness: 'codex',
    fleetId: 'fleet:test-cli-existing-bind',
    tmuxSession: 'fleet-test-cli-existing-bind',
    name: 'test-cli-existing-bind',
    resumeId: '22222222-2222-4333-8444-555555555555',
  }
  const writes = []
  const resolved = await bindLifecycleCodexResumeIdentity(result, {
    cwd: '/tmp/tlda-cli-existing-bind',
    name: 'test-cli-existing-bind',
    ledger: {
      setSessionSync(id, row) {
        writes.push({ id, row })
      },
    },
  })

  assert.equal(resolved.bound, true)
  assert.equal(resolved.existing, true)
  assert.deepEqual(writes, [{
    id: 'fleet:test-cli-existing-bind',
    row: {
      sessionId: '22222222-2222-4333-8444-555555555555',
      sessionKind: 'codex',
      cwd: '/tmp/tlda-cli-existing-bind',
      friendlyName: 'test-cli-existing-bind',
    },
  }])
})
