import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.FLEET_ID = 'fleet:test-agent'
const CONFIG_DIR_FIXTURE = mkdtempSync(join(tmpdir(), 'search-single-call-'))
process.env.TLDA_CONFIG_DIR = CONFIG_DIR_FIXTURE
process.env.TLDA_ENV = 'search-single-call-test'
writeFileSync(join(CONFIG_DIR_FIXTURE, 'daemon.yaml'), [
  'environments:',
  '  default: search-single-call-test',
  '  values:',
  '    search-single-call-test:',
  '      database: http://127.0.0.1:1',
  '      store: http://127.0.0.1:1',
  '      licenseKey: ""',
  '',
].join('\n'))

const { __setFleetTransportForTest, handleFleetTool } = await import('./fleet-tools.mjs')

const TS = '2026-09-27T00:00:00.000Z'
function installSearchStub() {
  const calls = []
  __setFleetTransportForTest({
    ephemeral: async (operation, params) => {
      calls.push({ operation, params })
      if (operation !== 'fleet-search') throw new Error(`unexpected ephemeral operation ${operation}`)
      return {
        results: [{
          source: 'fleet', id: 1, type: 'chat', timestamp: TS,
          from: 'fleet:a', fromName: 'ann', fromNameNow: 'ann',
          recipients: [], toNames: [], toNamesNow: [],
          text: 'a needle in the haystack', snippet: 'a ⟨⟨needle⟩⟩ in the haystack',
        }],
        context: { [TS]: { before: [{ from_id: 'fleet:b', fromName: 'bee', recipients: [], text: 'thread before', timestamp: TS }], after: [] } },
        unresolvedNames: [],
      }
    },
    durable: async (operation) => { throw new Error(`unexpected durable operation ${operation}`) },
  })
  return { calls }
}

test('a context search issues one fleet-search carrying the window', async () => {
  const { calls } = installSearchStub()
  const result = await handleFleetTool('search', { query: 'needle', context: 3 })
  assert.equal(result.isError, undefined)
  assert.equal(calls.length, 1, 'one search, not a search plus a second search for context')
  assert.equal(calls[0].operation, 'fleet-search')
  assert.equal(calls[0].params.context_window, 3)
  assert.equal(calls[0].params.context_timestamps, undefined)
  const text = result.content[0].text
  assert.match(text, /← MATCH/, 'the context block renders from the single call')
  assert.match(text, /thread before/)
})

test('a search without context sends no window', async () => {
  const { calls } = installSearchStub()
  const result = await handleFleetTool('search', { query: 'needle' })
  assert.equal(result.isError, undefined)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].params.context_window, undefined)
  assert.doesNotMatch(result.content[0].text, /← MATCH/)
})
