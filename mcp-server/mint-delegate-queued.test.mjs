import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.FLEET_ID = 'fleet:test-agent'
const CONFIG_DIR_FIXTURE = mkdtempSync(join(tmpdir(), 'mint-delegate-bindings-'))
process.env.TLDA_CONFIG_DIR = CONFIG_DIR_FIXTURE
process.env.TLDA_ENV = 'mint-delegate-test'
writeFileSync(join(CONFIG_DIR_FIXTURE, 'daemon.yaml'), [
  'environments:',
  '  default: mint-delegate-test',
  '  values:',
  '    mint-delegate-test:',
  '      database: http://127.0.0.1:1',
  '      store: http://127.0.0.1:1',
  '      licenseKey: ""',
  '',
].join('\n'))

const { __setFleetTransportForTest, handleFleetTool } = await import('./fleet-tools.mjs')

function installTransportStub(spawnResult) {
  const durableCalls = []
  __setFleetTransportForTest({
    ephemeral: async operation => {
      throw new Error(`unexpected ephemeral operation ${operation}`)
    },
    durable: async (operation, payload) => {
      durableCalls.push({ operation, payload })
      if (operation === 'spawn') return spawnResult
      throw new Error(`unexpected durable operation ${operation}`)
    },
  })
  return { durableCalls }
}

// Regression test for the bug reported 2026-08-16: `delegate({mint:...})`
// reported "mint joined as X, but returned no agent id. Not delegating." as a
// hard failure whenever the client's wait for the durable spawn response hit
// FLEET_DURABLE_SEND_DEADLINE_MS -- even though the daemon was often still
// spawning the agent successfully in the background. A queued durable spawn
// must be reported as still in flight, not as a failed mint, and must not
// attempt delegation before an agent id exists.
test('mint that times out client-side reports queued, not failed', async () => {
  const { durableCalls } = installTransportStub({ ok: true, queued: true, operation_id: 'op-123' })

  const result = await handleFleetTool('delegate', {
    mint: { name: 'agent-under-test' },
    message: 'do the thing',
  })

  assert.equal(durableCalls.length, 1)
  assert.equal(durableCalls[0].operation, 'spawn')

  // Must not be reported as a failure.
  assert.doesNotMatch(result.content[0].text, /mint failed/)
  assert.doesNotMatch(result.content[0].text, /returned no agent id/)
  assert.match(result.content[0].text, /still in flight/)
  assert.match(result.content[0].text, /op-123/)
  // No second call attempting to delegate to an id that doesn't exist yet.
  assert.equal(durableCalls.filter(c => c.operation === 'delegate').length, 0)
})

test('mint that returns an agent id promptly still delegates normally', async () => {
  const { durableCalls } = installTransportStub(null)
  __setFleetTransportForTest({
    durable: async (operation, payload) => {
      durableCalls.push({ operation, payload })
      if (operation === 'spawn') return { ok: true, agent_id: 'fleet:minted-abc', assigned_name: 'agent-under-test' }
      if (operation === 'delegate') return { ok: true, task_id: 'task-1' }
      throw new Error(`unexpected durable operation ${operation}`)
    },
  })

  const result = await handleFleetTool('delegate', {
    mint: { name: 'agent-under-test' },
    message: 'do the thing',
  })

  assert.equal(result.isError, undefined)
  assert.match(result.content[0].text, /Minted agent-under-test and delegated \[task-1\]/)
  assert.equal(durableCalls.filter(c => c.operation === 'delegate').length, 1)
})
