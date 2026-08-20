// `thread(message_id:)` is the read that makes an id a reference. The wire it
// crosses is proven in bin/a-message-id-can-be-read-back-test.mjs against a
// real server; this covers the MCP end of it — that the tool sends the
// `event-by-id` operation, and that what comes back reads as the message
// rather than as a row dump.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.FLEET_ID = 'fleet:test-agent'
const CONFIG_DIR_FIXTURE = mkdtempSync(join(tmpdir(), 'thread-message-id-'))
process.env.TLDA_CONFIG_DIR = CONFIG_DIR_FIXTURE
process.env.TLDA_ENV = 'thread-message-id-test'
writeFileSync(join(CONFIG_DIR_FIXTURE, 'daemon.yaml'), [
  'environments:',
  '  default: thread-message-id-test',
  '  values:',
  '    thread-message-id-test:',
  '      database: http://127.0.0.1:1',
  '      store: http://127.0.0.1:1',
  '      licenseKey: ""',
  '',
].join('\n'))

const { __setFleetTransportForTest, handleFleetTool } = await import('./fleet-tools.mjs')

const EVENT = {
  id: 2923649,
  type: 'chat',
  from: 'fleet:skip',
  recipients: ['fleet:test-agent'],
  text: 'the message an id has to be able to name',
  timestamp: '2026-08-17T23:30:00.000Z',
  metadata: null,
}

function installTransport({ event = EVENT } = {}) {
  const calls = []
  __setFleetTransportForTest({
    ephemeral: async (operation, payload) => {
      calls.push({ operation, payload })
      if (operation === 'event-by-id') {
        return { event: payload.event_id === event.id ? event : null }
      }
      if (operation === 'resolve-agent') return { agent: null }
      if (operation === 'store-agents-by-ids') return []
      return {}
    },
    durable: async () => { throw new Error('thread must not send a durable operation') },
  })
  return calls
}

test('a bare id returns the message it names', async () => {
  const calls = installTransport()

  const result = await handleFleetTool('thread', { message_id: 2923649 })

  const lookup = calls.find(c => c.operation === 'event-by-id')
  assert.ok(lookup, 'thread must ask the server for the event by id')
  assert.equal(lookup.payload.event_id, 2923649)
  assert.equal(result.isError, undefined, result.content?.[0]?.text)
  assert.match(result.content[0].text, /the message an id has to be able to name/)
})

test('the canonical chat#<id> form resolves to the same message', async () => {
  installTransport()

  const result = await handleFleetTool('thread', { message_id: 'chat#2923649' })

  assert.equal(result.isError, undefined, result.content?.[0]?.text)
  assert.match(result.content[0].text, /the message an id has to be able to name/)
})

test('a canonical form naming the wrong type is an error, not the message', async () => {
  // chat#N and report#N are different references. Returning the chat for a
  // report#N read would make the type in a reference decorative.
  installTransport()

  const result = await handleFleetTool('thread', { message_id: 'report#2923649' })

  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /is a chat, not a report/)
})

test('an id nothing answers to says so instead of reading as empty history', async () => {
  installTransport()

  const result = await handleFleetTool('thread', { message_id: 4242424 })

  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /No message 4242424/)
})

test('a non-id is refused before anything is asked of the server', async () => {
  const calls = installTransport()

  const result = await handleFleetTool('thread', { message_id: 'fleet:skip' })

  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /is not a message id/)
  assert.equal(calls.filter(c => c.operation === 'event-by-id').length, 0)
})

// The lookup reused thread()'s row shaping rather than adding a third copy of
// it, which means the conversation reads go through code this change moved.
// These cover that: same message, reached the ordinary way.
test('a conversation read still renders its messages after the shaping moved', async () => {
  __setFleetTransportForTest({
    ephemeral: async (operation) => {
      if (operation === 'fleet-search') {
        return { results: [{ ...EVENT, source: 'fleet' }], unresolvedNames: [] }
      }
      if (operation === 'resolve-agent') return { agent: null }
      if (operation === 'store-agents-by-ids') return []
      return {}
    },
    durable: async () => { throw new Error('thread must not send a durable operation') },
  })

  const result = await handleFleetTool('thread', { agent: 'fleet:skip' })

  assert.equal(result.isError, undefined, result.content?.[0]?.text)
  assert.match(result.content[0].text, /the message an id has to be able to name/)
})

test('a delegate row still gets its [DELEGATE] shaping through the shared path', async () => {
  __setFleetTransportForTest({
    ephemeral: async (operation) => {
      if (operation === 'fleet-search') {
        return {
          results: [{
            ...EVENT, source: 'fleet', type: 'delegate',
            description: 'go and do the thing', text: 'with these details',
          }],
          unresolvedNames: [],
        }
      }
      if (operation === 'resolve-agent') return { agent: null }
      if (operation === 'store-agents-by-ids') return []
      return {}
    },
    durable: async () => { throw new Error('thread must not send a durable operation') },
  })

  const result = await handleFleetTool('thread', { agent: 'fleet:skip' })

  assert.equal(result.isError, undefined, result.content?.[0]?.text)
  assert.match(result.content[0].text, /\[DELEGATE\] go and do the thing/)
})

test('a persisted mint delegation renders its full payload and criteria', async () => {
  installTransport({
    event: {
      ...EVENT,
      type: 'delegate',
      text: 'Finish survival review response',
      metadata: JSON.stringify({
        message: 'Recover and finish the survival-paper review-response project.',
        criteria: ['Every referee comment is dispositioned.', 'The paper builds cleanly.'],
      }),
    },
  })

  const result = await handleFleetTool('thread', { message_id: 2923649 })

  assert.equal(result.isError, undefined, result.content?.[0]?.text)
  assert.match(result.content[0].text, /Recover and finish the survival-paper review-response project\./)
  assert.match(result.content[0].text, /1\. Every referee comment is dispositioned\./)
  assert.match(result.content[0].text, /2\. The paper builds cleanly\./)
})

test('thread with no selector at all names message_id among the options', async () => {
  installTransport()

  const result = await handleFleetTool('thread', {})

  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /message_id/)
})
