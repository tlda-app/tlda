import test from 'node:test'
import assert from 'node:assert/strict'

process.env.FLEET_ID = 'fleet:test-agent'

const {
  __resetAgentPreambleForTest,
  __setFleetTransportForTest,
  handleFleetTool,
} = await import('./fleet-tools.mjs')

function installFetchStub({ macros = {}, projects = [] } = {}) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const href = String(url)
    if (href.includes('/api/projects/paper/macros')) {
      return new Response(JSON.stringify({ macros }), { status: 200 })
    }
    if (href.endsWith('/api/projects') || href.includes('/api/projects?')) {
      return new Response(JSON.stringify({ projects }), { status: 200 })
    }
    if (href.includes('/api/projects/paper/history/shadow')) {
      return new Response(JSON.stringify({ versions: [{ hash: 'freshver' }] }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }
  return () => { globalThis.fetch = originalFetch }
}

function installTransportStub({ persistedPreamble = null } = {}) {
  const durableCalls = []
  __setFleetTransportForTest({
    ephemeral: async (operation, payload) => {
      if (operation === 'store-agents-by-ids') {
        return payload.ids.map(id => ({
          id,
          friendly_name: id.replace(/^fleet:/, ''),
          metadata: id === 'fleet:test-agent' && persistedPreamble
            ? { chatPreamble: persistedPreamble }
            : {},
        }))
      }
      if (operation === 'resolve-chat-recipients') return { recipients: ['fleet:skip'] }
      if (operation === 'agent-status') return { ok: true }
      throw new Error(`unexpected ephemeral operation ${operation}`)
    },
    durable: async (operation, payload) => {
      durableCalls.push({ operation, payload })
      if (operation === 'chat') {
        return { ok: true, event_ids: [123], receipts: [] }
      }
      throw new Error(`unexpected durable operation ${operation}`)
    },
  })
  return durableCalls
}

test('chat preamble reloads from agent metadata after MCP reconnect', async () => {
  __resetAgentPreambleForTest()
  const restoreFetch = installFetchStub({ macros: { '\\foo': 'x' } })
  const durableCalls = installTransportStub({
    persistedPreamble: { doc: 'paper', version: 'pinned' },
  })
  try {
    const result = await handleFleetTool('chat', {
      to: 'fleet:skip',
      message: 'Uses paper macro $\\foo$.',
    })

    assert.equal(result.isError, undefined)
    assert.equal(durableCalls.length, 1)
    assert.equal(durableCalls[0].operation, 'chat')
    assert.deepEqual(durableCalls[0].payload.preambleRef, { doc: 'paper', version: 'pinned' })
  } finally {
    restoreFetch()
  }
})

test('chat render validity failure blocks delivery before durable chat', async () => {
  __resetAgentPreambleForTest()
  const restoreFetch = installFetchStub()
  const durableCalls = installTransportStub()
  try {
    const result = await handleFleetTool('chat', {
      to: 'fleet:skip',
      message: 'Uses missing paper macro $\\foo$.',
    })

    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /Message NOT sent/)
    assert.match(result.content[0].text, /macros that aren't loaded/)
    assert.equal(durableCalls.length, 0)
  } finally {
    restoreFetch()
  }
})
