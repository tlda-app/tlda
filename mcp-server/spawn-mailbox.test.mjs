import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.FLEET_ID = 'fleet:test-agent'
const CONFIG_DIR_FIXTURE = mkdtempSync(join(tmpdir(), 'spawn-mailbox-bindings-'))
process.env.TLDA_CONFIG_DIR = CONFIG_DIR_FIXTURE
process.env.TLDA_ENV = 'spawn-mailbox-test'
writeFileSync(join(CONFIG_DIR_FIXTURE, 'daemon.yaml'), [
  'environments:',
  '  default: spawn-mailbox-test',
  '  values:',
  '    spawn-mailbox-test:',
  '      database: http://127.0.0.1:1',
  '      store: http://127.0.0.1:1',
  '      licenseKey: ""',
  '',
].join('\n'))

const { __setFleetTransportForTest, handleFleetTool } = await import('./fleet-tools.mjs')

function installMailboxStub(status) {
  __setFleetTransportForTest({
    ephemeral: async (operation, payload) => {
      assert.equal(operation, 'spawn-mailbox')
      assert.equal(payload.mailbox_id, 'mailbox:1')
      return status
    },
    durable: async (operation) => { throw new Error(`unexpected durable operation ${operation}`) },
  })
}

test('a pending mailbox says what is launching and the bound on waiting', async () => {
  installMailboxStub({
    ok: true, mailbox_id: 'mailbox:1', status: 'pending',
    agent_id: 'fleet:abc', requested_name: 'agent-x', waited_ms: 20_000, remaining_ms: 280_000,
  })
  const result = await handleFleetTool('spawn-mailbox', { mailbox_id: 'mailbox:1' })
  assert.equal(result.isError, undefined)
  assert.match(result.content[0].text, /still launching/)
  assert.match(result.content[0].text, /Do not chat it yet/)
})

test('a completed mailbox names the addressable agent', async () => {
  installMailboxStub({
    ok: true, mailbox_id: 'mailbox:1', status: 'completed',
    agent_id: 'fleet:abc', requested_name: 'agent-x', assigned_name: 'agent-x-jr',
    name_changed: true, task_id: 'task-9', live: { state: 'live', pending: false },
  })
  const result = await handleFleetTool('spawn-mailbox', { mailbox_id: 'mailbox:1' })
  assert.equal(result.isError, undefined)
  assert.match(result.content[0].text, /agent-x-jr \(fleet:abc\)/)
  assert.match(result.content[0].text, /Addressable now/)
})

test('a completed mailbox with a diverged row warns instead of blessing the handle', async () => {
  installMailboxStub({
    ok: true, mailbox_id: 'mailbox:1', status: 'completed',
    agent_id: 'fleet:abc', assigned_name: 'agent-x', live: { state: 'missing' },
  })
  const result = await handleFleetTool('spawn-mailbox', { mailbox_id: 'mailbox:1' })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /Do not trust this handle/)
})

test('a failed mailbox preserves the launch error and says re-mint', async () => {
  installMailboxStub({
    ok: true, mailbox_id: 'mailbox:1', status: 'failed', expired: false,
    agent_id: 'fleet:abc', requested_name: 'agent-x',
    error: 'mint refused: 30 agents awake on mini:testing, cap is 30. Nothing was queued — this launch is declined, not deferred. Hibernate one, or raise the ceiling.',
  })
  const result = await handleFleetTool('spawn-mailbox', { mailbox_id: 'mailbox:1' })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /declined, not deferred/)
  assert.match(result.content[0].text, /re-mint rather than wait/)
})

test('an expired mailbox reads stuck, not slow', async () => {
  installMailboxStub({
    ok: true, mailbox_id: 'mailbox:1', status: 'failed', expired: true, reason: 'deadline-exceeded',
    agent_id: 'fleet:abc', requested_name: 'agent-x', error: 'deadline exceeded', waited_ms: 300_000,
  })
  const result = await handleFleetTool('spawn-mailbox', { mailbox_id: 'mailbox:1' })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /stuck, not slow/)
})

test('an unknown mailbox id is reported honestly', async () => {
  installMailboxStub({ ok: true, mailbox_id: 'mailbox:1', status: 'unknown' })
  const result = await handleFleetTool('spawn-mailbox', { mailbox_id: 'mailbox:1' })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /No record of mailbox/)
})
