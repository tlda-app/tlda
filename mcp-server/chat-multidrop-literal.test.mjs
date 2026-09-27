import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeFileSync } from 'node:fs'

process.env.FLEET_ID = 'fleet:test-agent'
const CONFIG_DIR_FIXTURE = mkdtempSync(join(tmpdir(), 'chat-multidrop-'))
process.env.TLDA_CONFIG_DIR = CONFIG_DIR_FIXTURE
process.env.TLDA_ENV = 'chat-multidrop-test'
writeFileSync(join(CONFIG_DIR_FIXTURE, 'daemon.yaml'), [
  'environments:',
  '  default: chat-multidrop-test',
  '  values:',
  '    chat-multidrop-test:',
  '      database: http://127.0.0.1:1',
  '      store: http://127.0.0.1:1',
  '      licenseKey: ""',
  '',
].join('\n'))

const { __resetAgentPreambleForTest, __setFleetTransportForTest, handleFleetTool, droppedUnionLiterals } = await import('./fleet-tools.mjs')
const { parseFilter } = await import('../shared/fleet-labels.mjs')

function installTransportStub({ recipients, resolveAgentByValue = {} }) {
  const durableCalls = []
  __setFleetTransportForTest({
    ephemeral: async (operation, params) => {
      if (operation === 'resolve-chat-recipients') return { recipients }
      if (operation === 'resolve-agent') return { agent: resolveAgentByValue[params?.agent] || null }
      if (operation === 'store-agents-by-ids') return []
      throw new Error(`unexpected ephemeral operation ${operation}`)
    },
    durable: async (operation, payload) => {
      durableCalls.push({ operation, payload })
      if (operation === 'chat') return { ok: true, event_ids: [91001], receipts: [] }
      throw new Error(`unexpected durable operation ${operation}`)
    },
  })
  return { durableCalls }
}

// The defect: `fleet:A | fleet:B` with B unresolvable is accepted with
// recipients naming only A, and nothing anywhere says B matched nothing.
test('a union member that matches nothing is named on the accepted result', async () => {
  __resetAgentPreambleForTest()
  const { durableCalls } = installTransportStub({
    recipients: ['fleet:aaa111'],
    resolveAgentByValue: { 'fleet:aaa111': { id: 'fleet:aaa111', friendly_name: 'alpha' } },
  })

  const result = await handleFleetTool('chat', {
    to: 'fleet:aaa111 | fleet:bbb222',
    message: 'brief for two owners',
  })

  assert.equal(result.isError, undefined)
  assert.equal(durableCalls.length, 1)
  const text = result.content[0].text
  assert.match(text, /fleet:aaa111/)
  assert.match(text, /fleet:bbb222/)
  assert.match(text, /matched no agent/)
  assert.match(text, /did not get this message/)
})

test('a union whose members all resolve stays quiet', async () => {
  __resetAgentPreambleForTest()
  installTransportStub({
    recipients: ['fleet:aaa111', 'fleet:bbb222'],
    resolveAgentByValue: {
      'fleet:aaa111': { id: 'fleet:aaa111', friendly_name: 'alpha' },
      'fleet:bbb222': { id: 'fleet:bbb222', friendly_name: 'beta' },
    },
  })

  const result = await handleFleetTool('chat', {
    to: 'fleet:aaa111 | fleet:bbb222',
    message: 'brief for two owners',
  })

  assert.equal(result.isError, undefined)
  assert.doesNotMatch(result.content[0].text, /matched nothing|no agent matched|did not match/i)
})

// Known residual, recorded not assumed: a bare token is ambiguous between a
// name and a label, so a bare *name* matching nothing in a union stays
// silent while its sibling delivers. Extending the warning there needs a
// product ruling on the ambiguity — see droppedUnionLiterals.
test('a filter union with a zero-matching label stays quiet', async () => {
  __resetAgentPreambleForTest()
  installTransportStub({ recipients: ['fleet:aaa111'] })

  const result = await handleFleetTool('chat', {
    to: 'fleet:aaa111 | nosuchlabel',
    message: 'brief plus a filter term',
  })

  assert.equal(result.isError, undefined)
  assert.doesNotMatch(result.content[0].text, /matched no agent|did not get this message/i)
})

test('the sender addressing themselves in a union is not a drop', async () => {
  __resetAgentPreambleForTest()
  installTransportStub({ recipients: ['fleet:aaa111'] })

  const result = await handleFleetTool('chat', {
    to: 'fleet:aaa111 | fleet:test-agent',
    message: 'brief including myself',
  })

  assert.equal(result.isError, undefined)
  assert.doesNotMatch(result.content[0].text, /matched no agent|did not get this message/i)
})

test('droppedUnionLiterals only sees top-level fleet: union members', () => {
  const dropped = (to, sentIds, selfId = 'fleet:self') =>
    droppedUnionLiterals({ filterAst: parseFilter(to), sentIds, selfId })
  assert.deepEqual(dropped('fleet:a | fleet:b', ['fleet:a']), ['fleet:b'])
  assert.deepEqual(dropped('fleet:a | fleet:b | fleet:c', ['fleet:a']), ['fleet:b', 'fleet:c'])
  assert.deepEqual(dropped('fleet:a | fleet:b', ['fleet:a', 'fleet:b']), [])
  assert.deepEqual(dropped('fleet:a', []), [])
  assert.deepEqual(dropped('fleet:a & reviewers', ['fleet:a']), [])
  assert.deepEqual(dropped('awake & reviewers', ['fleet:a']), [])
  assert.deepEqual(dropped('fleet:a | reviewers', ['fleet:a']), [])
  assert.deepEqual(dropped('fleet:a | (awake & reviewers)', ['fleet:a']), [])
  assert.deepEqual(dropped('fleet:a | fleet:self', ['fleet:a']), [])
})
