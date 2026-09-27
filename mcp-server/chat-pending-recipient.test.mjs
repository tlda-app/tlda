import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.FLEET_ID = 'fleet:test-agent'
const CONFIG_DIR_FIXTURE = mkdtempSync(join(tmpdir(), 'chat-pending-bindings-'))
process.env.TLDA_CONFIG_DIR = CONFIG_DIR_FIXTURE
process.env.TLDA_ENV = 'chat-pending-test'
writeFileSync(join(CONFIG_DIR_FIXTURE, 'daemon.yaml'), [
  'environments:',
  '  default: chat-pending-test',
  '  values:',
  '    chat-pending-test:',
  '      database: http://127.0.0.1:1',
  '      store: http://127.0.0.1:1',
  '      licenseKey: ""',
  '',
].join('\n'))

const { __resetAgentPreambleForTest, __setFleetTransportForTest, handleFleetTool, isPendingShellRow, pendingRefusalNote } = await import('./fleet-tools.mjs')

const PENDING_ROW = {
  id: 'fleet:fc28fcee',
  friendly_name: 'pw-mcp-init',
  dead: false,
  metadata: { shell: true },
}

function installTransportStub({ resolveAgentRow = null } = {}) {
  const durableCalls = []
  __setFleetTransportForTest({
    ephemeral: async (operation) => {
      // A pending shell is excluded from chat resolution, so the name
      // resolves to no recipients — the refusal this file makes honest.
      if (operation === 'resolve-chat-recipients') return { recipients: [] }
      if (operation === 'resolve-agent') return { agent: resolveAgentRow }
      if (operation === 'store-agents-by-ids') return []
      throw new Error(`unexpected ephemeral operation ${operation}`)
    },
    durable: async (operation, payload) => {
      durableCalls.push({ operation, payload })
      throw new Error(`unexpected durable operation ${operation}`)
    },
  })
  return { durableCalls }
}

// The validator used to answer a pending agent's name with "no agent matched
// X. Check the name/label" — sending the caller to check a name that was
// right, when the cause was time.
test('a name that belongs to a pending agent says so instead of blaming the name', async () => {
  __resetAgentPreambleForTest()
  const { durableCalls } = installTransportStub({ resolveAgentRow: PENDING_ROW })

  const result = await handleFleetTool('chat', {
    to: 'pw-mcp-init',
    message: 'follow-up requirement',
  })

  assert.equal(result.isError, true)
  assert.equal(durableCalls.length, 0)
  assert.match(result.content[0].text, /pw-mcp-init/)
  assert.match(result.content[0].text, /still starting \(pending\)/)
  assert.match(result.content[0].text, /cause is time/)
  assert.doesNotMatch(result.content[0].text, /Check the name\/label/)
})

test('pending is a live row whose login never completed', () => {
  assert.equal(isPendingShellRow(PENDING_ROW), true)
  assert.equal(isPendingShellRow({ ...PENDING_ROW, metadata: { shell: 1 } }), true)
  assert.equal(isPendingShellRow({ ...PENDING_ROW, metadata: { shell: null } }), false)
  assert.equal(isPendingShellRow({ ...PENDING_ROW, metadata: {} }), false)
  assert.equal(isPendingShellRow({ ...PENDING_ROW, dead: true }), false)
  assert.equal(isPendingShellRow(null), false)
})

test('an observed refusal to all-pending recipients is rewritten time-honestly', () => {
  const note = pendingRefusalNote({
    recipients: ['fleet:fc28fcee'],
    rows: [PENDING_ROW],
    delivery: 'not delivered',
  })
  assert.match(note, /pw-mcp-init \(fleet:fc28fcee\)/)
  assert.match(note, /still starting \(pending\)/)
  assert.match(note, /not stored and will not arrive later/)
  assert.match(note, /Resend after it joins/)
  assert.doesNotMatch(note, /Re-sending will not help/)
})

test('anything else keeps the existing refusal wording', () => {
  const live = { ...PENDING_ROW, metadata: { shell: null } }
  // One live recipient among the refused: not attributable to pending.
  assert.equal(pendingRefusalNote({ recipients: ['fleet:fc28fcee', 'fleet:live'], rows: [PENDING_ROW, live], delivery: 'not delivered' }), null)
  // No row for the recipient: unknown, not known-pending.
  assert.equal(pendingRefusalNote({ recipients: ['fleet:ghost'], rows: [], delivery: 'not delivered' }), null)
  // Never rewrite a guess: a queued or unknown send may still land.
  assert.equal(pendingRefusalNote({ recipients: ['fleet:fc28fcee'], rows: [PENDING_ROW], delivery: 'unknown' }), null)
  assert.equal(pendingRefusalNote({ recipients: [], rows: [PENDING_ROW], delivery: 'not delivered' }), null)
})

test('a name that matches nothing still reports no match', async () => {
  __resetAgentPreambleForTest()
  const { durableCalls } = installTransportStub({ resolveAgentRow: null })

  const result = await handleFleetTool('chat', {
    to: 'nobody-called-this',
    message: 'hello?',
  })

  assert.equal(result.isError, true)
  assert.equal(durableCalls.length, 0)
  assert.match(result.content[0].text, /no agent matched/)
  assert.match(result.content[0].text, /Check the name\/label/)
  assert.doesNotMatch(result.content[0].text, /pending/)
})
