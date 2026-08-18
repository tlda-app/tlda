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

// This file used to assert the bug. Between 42fe1daa2 (2026-08-08) and this
// commit, `delegate({mint:...})` sent `spawn` with await_ready, whose server
// response resolves only from the minted agent's real login() -- ~20s for a
// Claude seat -- while this client stops waiting for a durable ack at
// FLEET_DURABLE_SEND_DEADLINE_MS = 15s and answers `queued`. The queued branch
// returned without ever sending the delegation, so the task was dropped on
// every mint rather than on a slow one. The test below asserted that drop
// directly (`durableCalls.filter(c => c.operation === 'delegate').length === 0`)
// and passed the whole time, because its own comment scoped it to the error
// wording rather than to whether the delegation happened.
//
// mint+delegate is now one durable operation: the spawn carries the delegation
// and the server attaches the task to the shell row it reserves. So there is no
// separate delegate send to count, and `queued` no longer means half the work
// was discarded -- it means the whole operation is in the outbox under one
// operation_id.
test('the delegation rides on the mint rather than following it', async () => {
  const { durableCalls } = installTransportStub({
    ok: true,
    agent_id: 'fleet:minted-abc',
    assigned_name: 'agent-under-test',
    task_id: 'task-1',
  })

  const result = await handleFleetTool('delegate', {
    mint: { name: 'agent-under-test' },
    message: 'do the thing',
  })

  assert.equal(result.isError, undefined)
  assert.equal(durableCalls.length, 1)
  assert.equal(durableCalls[0].operation, 'spawn')
  // The mint no longer waits on the agent's login for its acknowledgement, which
  // is what put this path past the client's deadline in the first place.
  assert.equal(durableCalls[0].payload.await_ready, undefined)
  assert.equal(durableCalls[0].payload.delegate.message, 'do the thing')
  assert.equal(durableCalls[0].payload.delegate.allow_pending_agent, true)
  assert.equal(durableCalls[0].payload.delegate.operation_id, durableCalls[0].payload.operation_id)
  assert.match(result.content[0].text, /Minted agent-under-test and delegated \[task-1\] to fleet:minted-abc/)
})

test('a queued mint keeps its delegation instead of dropping it', async () => {
  const { durableCalls } = installTransportStub({ ok: true, queued: true, operation_id: 'op-123' })

  const result = await handleFleetTool('delegate', {
    mint: { name: 'agent-under-test' },
    message: 'do the thing',
  })

  assert.equal(durableCalls.length, 1)
  assert.equal(durableCalls[0].operation, 'spawn')
  // The delegation is in the enqueued payload, so the retry carries it. This is
  // the assertion that replaces the one asserting it was dropped.
  assert.equal(durableCalls[0].payload.delegate.message, 'do the thing')

  assert.doesNotMatch(result.content[0].text, /mint failed/)
  assert.match(result.content[0].text, /queued durably/)
  assert.match(result.content[0].text, /op-123/)
  assert.match(result.content[0].text, /nothing is lost/)
})

test('a mint whose server returns no task id is reported as not attached', async () => {
  installTransportStub({ ok: true, agent_id: 'fleet:minted-abc', assigned_name: 'agent-under-test' })

  const result = await handleFleetTool('delegate', {
    mint: { name: 'agent-under-test' },
    message: 'do the thing',
  })

  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /did not attach/)
})
