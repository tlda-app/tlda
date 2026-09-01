// A re-delegation must not retitle the task it is handed.
//
// `delegate` derives a description from the message when the caller gives none.
// That derived string is the hand-off note, and on the transfer branch the
// server writes whatever `description` it receives over the task's real title
// (d416d6edf, on the stated premise that callers omit the field -- this client
// never did). So a bulk hand-off stamped its own note across every row it
// touched: 39 open tasks read as 3 distinct sentences, and the work underneath
// them was unreadable.
//
// What these assert is the payload that crosses to the server, which is the
// only place the decision is made. Delete the `args.task_id ?` guard in
// fleet-tools.mjs and the first test goes red on the exact substitution.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.FLEET_ID = 'fleet:test-agent'
const CONFIG_DIR_FIXTURE = mkdtempSync(join(tmpdir(), 'delegate-transfer-title-'))
process.env.TLDA_CONFIG_DIR = CONFIG_DIR_FIXTURE
process.env.TLDA_ENV = 'delegate-transfer-title-test'
writeFileSync(join(CONFIG_DIR_FIXTURE, 'daemon.yaml'), [
  'environments:',
  '  default: delegate-transfer-title-test',
  '  values:',
  '    delegate-transfer-title-test:',
  '      database: http://127.0.0.1:1',
  '      store: http://127.0.0.1:1',
  '      licenseKey: ""',
  '',
].join('\n'))

const { __setFleetTransportForTest, handleFleetTool, deriveTaskDescription } = await import('./fleet-tools.mjs')

function installTransportStub() {
  const durableCalls = []
  __setFleetTransportForTest({
    ephemeral: async () => null,
    durable: async (operation, payload) => {
      durableCalls.push({ operation, payload })
      if (operation === 'delegate') return { ok: true, task_id: payload.task_id || 'task-new' }
      throw new Error(`unexpected durable operation ${operation}`)
    },
  })
  return { durableCalls }
}

const PARKING_NOTE = 'Parking stale backlog task during fleet cleanup. Owner is hibernating; pick it up when the lane reopens.'

test('a transfer that does not retitle sends no description at all', async () => {
  const { durableCalls } = installTransportStub()

  await handleFleetTool('delegate', {
    agent: 'fleet:nobody',
    task_id: 'fleet:abcd-existing',
    message: PARKING_NOTE,
  })

  const delegateCall = durableCalls.find(c => c.operation === 'delegate')
  assert.ok(delegateCall, 'delegate was sent')
  assert.equal(delegateCall.payload.task_id, 'fleet:abcd-existing')
  // The whole defect in one assertion: absent, not "Parking stale backlog task
  // during fleet cleanup." The server keeps the task's existing title only when
  // the field does not arrive.
  assert.equal(delegateCall.payload.description, undefined)
})

test('a transfer that does retitle sends exactly the title the caller gave', async () => {
  const { durableCalls } = installTransportStub()

  await handleFleetTool('delegate', {
    agent: 'fleet:nobody',
    task_id: 'fleet:abcd-existing',
    description: 'Rebuild index page to Skip’s spec',
    message: PARKING_NOTE,
  })

  const delegateCall = durableCalls.find(c => c.operation === 'delegate')
  assert.equal(delegateCall.payload.description, 'Rebuild index page to Skip’s spec')
})

test('a new task still gets a derived description', async () => {
  const { durableCalls } = installTransportStub()

  await handleFleetTool('delegate', {
    agent: 'fleet:nobody',
    message: 'Fix the invisible math-agent messages. Details follow.',
  })

  const delegateCall = durableCalls.find(c => c.operation === 'delegate')
  assert.equal(delegateCall.payload.task_id, undefined)
  assert.equal(delegateCall.payload.description, 'Fix the invisible math-agent messages.')
})

// A task row is one line. A derived headline carrying a newline splits it, which
// is how one row rendered with its id on one line and its title on the next.
test('a derived description is a single line', () => {
  const derived = deriveTaskDescription('## How I work — Skip, 09-01 13:0x EDT\n\n> YOU DO NOT HAVE THE CONTEXT')
  assert.ok(!derived.includes('\n'), `derived headline must not contain a newline: ${JSON.stringify(derived)}`)
  assert.equal(derived, '## How I work — Skip, 09-01 13:0x EDT')
})

test('a derived description stays within the headline budget', () => {
  const derived = deriveTaskDescription('Ownership transfer while the chief/package lane has the next action on assembly and release')
  assert.ok(derived.length <= 60, `derived headline too long: ${derived.length}`)
  assert.ok(!derived.includes('\n'))
})
