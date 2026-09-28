// thread() bounds: the window a bounded read measured, and the `limit` alias.
//
// Defect 1 (2026-09-28): a pair read with `since` after the messages came
// back "you two have not exchanged messages" — the strong sentence an
// unbounded read earns, asserted by a bound that cannot establish it, while
// two of the pair's messages sat in the caller's inbox. The bounded empty
// names its window; only the unbounded empty keeps the strong sentence.
//
// Defect 2 (2026-09-28): `limit: 3` was silently ignored — thread's schema
// has only `page_size`, and the handler read only that — so the caller got
// the whole 200-row page. `limit` is the fleet-wide spelling (search,
// roster), so it is honoured as an alias rather than refused.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.FLEET_ID = 'fleet:test-agent'
const CONFIG_DIR_FIXTURE = mkdtempSync(join(tmpdir(), 'thread-bounds-'))
process.env.TLDA_CONFIG_DIR = CONFIG_DIR_FIXTURE
process.env.TLDA_ENV = 'thread-bounds-test'
writeFileSync(join(CONFIG_DIR_FIXTURE, 'daemon.yaml'), [
  'environments:',
  '  default: thread-bounds-test',
  '  values:',
  '    thread-bounds-test:',
  '      database: http://127.0.0.1:1',
  '      store: http://127.0.0.1:1',
  '      licenseKey: ""',
  '',
].join('\n'))

const { __setFleetTransportForTest, handleFleetTool } = await import('./fleet-tools.mjs')

function installTransport(results) {
  const calls = []
  __setFleetTransportForTest({
    ephemeral: async (operation, payload) => {
      calls.push({ operation, payload })
      if (operation === 'fleet-search') return { results, unresolvedNames: [] }
      if (operation === 'resolve-agent') return { agent: null }
      if (operation === 'store-agents-by-ids') return []
      return {}
    },
    durable: async () => { throw new Error('thread must not send a durable operation') },
  })
  return calls
}

const row = (id, timestamp) => ({
  id, type: 'chat', source: 'fleet',
  from: 'fleet:skip', recipients: ['fleet:test-agent'],
  text: `message ${id}`, timestamp, metadata: null,
})

test('a since-bounded empty pair names the window, not the pair', async () => {
  installTransport([])

  const result = await handleFleetTool('thread', { agent: 'fleet:skip', since: '2026-09-28T03:20:00.000Z' })
  const text = result.content[0].text

  assert.equal(result.isError, undefined, text)
  assert.match(text, /since 2026-09-28T03:20:00\.000Z/)
  assert.match(text, /says nothing about the conversation outside the window/)
  assert.doesNotMatch(text, /have not exchanged messages/)
})

test('an until-bounded empty pair names its bound', async () => {
  installTransport([])

  const result = await handleFleetTool('thread', { agent: 'fleet:skip', until: '2026-09-01T00:00:00.000Z' })
  const text = result.content[0].text

  assert.equal(result.isError, undefined, text)
  assert.match(text, /until 2026-09-01T00:00:00\.000Z/)
  assert.doesNotMatch(text, /have not exchanged messages/)
})

test('a both-bounded empty pair says to widen the window', async () => {
  installTransport([])

  const result = await handleFleetTool('thread', {
    agent: 'fleet:skip',
    since: '2026-09-01T00:00:00.000Z',
    until: '2026-09-02T00:00:00.000Z',
  })
  const text = result.content[0].text

  assert.equal(result.isError, undefined, text)
  assert.match(text, /Widen the window/)
  assert.doesNotMatch(text, /have not exchanged messages/)
})

test('an unbounded empty pair keeps the strong sentence', async () => {
  installTransport([])

  const result = await handleFleetTool('thread', { agent: 'fleet:skip' })
  const text = result.content[0].text

  assert.equal(result.isError, undefined, text)
  assert.match(text, /have not exchanged messages/)
})

test('limit is honoured as the page size', async () => {
  const calls = installTransport([
    row(1, '2026-09-27T01:00:00.000Z'),
    row(2, '2026-09-27T02:00:00.000Z'),
    row(3, '2026-09-27T03:00:00.000Z'),
    row(4, '2026-09-27T04:00:00.000Z'),
  ])

  const result = await handleFleetTool('thread', { agent: 'fleet:skip', limit: 3 })
  const text = result.content[0].text

  const fetch = calls.find(c => c.operation === 'fleet-search')
  assert.equal(fetch.payload.limit, 4, 'pageSize+1 so overflow is detectable')
  assert.equal(result.isError, undefined, text)
  assert.match(text, /Showing the first 3 message\(s\)/)
  assert.match(text, /message 3/)
  assert.doesNotMatch(text, /message 4/)
})

test('page_size wins when both page_size and limit are given', async () => {
  const calls = installTransport([
    row(1, '2026-09-27T01:00:00.000Z'),
    row(2, '2026-09-27T02:00:00.000Z'),
    row(3, '2026-09-27T03:00:00.000Z'),
  ])

  const result = await handleFleetTool('thread', { agent: 'fleet:skip', page_size: 2, limit: 5 })

  const fetch = calls.find(c => c.operation === 'fleet-search')
  assert.equal(fetch.payload.limit, 3, 'page_size 2 + 1, not limit 5 + 1')
  assert.equal(result.isError, undefined, result.content?.[0]?.text)
})
