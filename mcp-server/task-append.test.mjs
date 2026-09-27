import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.FLEET_ID = 'fleet:test-agent'
const CONFIG_DIR_FIXTURE = mkdtempSync(join(tmpdir(), 'task-append-bindings-'))
process.env.TLDA_CONFIG_DIR = CONFIG_DIR_FIXTURE
process.env.TLDA_ENV = 'task-append-test'
writeFileSync(join(CONFIG_DIR_FIXTURE, 'daemon.yaml'), [
  'environments:',
  '  default: task-append-test',
  '  values:',
  '    task-append-test:',
  '      database: http://127.0.0.1:1',
  '      store: http://127.0.0.1:1',
  '      licenseKey: ""',
  '',
].join('\n'))

const { __setFleetTransportForTest, handleFleetTool } = await import('./fleet-tools.mjs')

function installAppendStub(reply) {
  const durableCalls = []
  __setFleetTransportForTest({
    ephemeral: async (operation) => { throw new Error(`unexpected ephemeral operation ${operation}`) },
    durable: async (operation, payload) => {
      durableCalls.push({ operation, payload })
      if (reply instanceof Error) throw reply
      return reply
    },
  })
  return { durableCalls }
}

test('an append rides a durable op and reports the nudge', async () => {
  const { durableCalls } = installAppendStub({
    ok: true, task_id: 'task-1', owner: 'fleet:worker', appended_chars: 42, nudged: true,
  })
  const result = await handleFleetTool('task-append', {
    task_id: 'task-1',
    message: 'New requirement: check the retirement path too.',
  })
  assert.equal(result.isError, undefined)
  assert.equal(durableCalls.length, 1)
  assert.equal(durableCalls[0].operation, 'task-append')
  assert.equal(durableCalls[0].payload.task_id, 'task-1')
  assert.match(durableCalls[0].payload.message, /retirement path/)
  assert.match(result.content[0].text, /Appended to \[task-1\]/)
  assert.match(result.content[0].text, /nudged/)
})

test('an append to a pending owner says it reads at pickup', async () => {
  installAppendStub({
    ok: true, task_id: 'task-1', owner: 'fleet:worker', appended_chars: 42,
    nudged: false, nudge_skipped: 'pending',
  })
  const result = await handleFleetTool('task-append', {
    task_id: 'task-1',
    message: 'New requirement.',
  })
  assert.equal(result.isError, undefined)
  assert.match(result.content[0].text, /still starting/)
  assert.match(result.content[0].text, /reads .* at pickup/)
})

test('a refused append reports the refusal honestly', async () => {
  installAppendStub({ error: 'task-append refused: fleet:stranger is neither the owner nor the delegator of [task-1] (owner fleet:worker, delegator fleet:owner)' })
  const result = await handleFleetTool('task-append', {
    task_id: 'task-1',
    message: 'Sneaky.',
  })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /neither the owner nor the delegator/)
})

test('a transport failure reports unknown honestly', async () => {
  installAppendStub(new Error('socket down'))
  const result = await handleFleetTool('task-append', {
    task_id: 'task-1',
    message: 'New requirement.',
  })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /Delivery UNKNOWN/)
})
