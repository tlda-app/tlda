import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.FLEET_ID = 'fleet:test-agent'
// The project↔checkout map is machine-local daemon state. Point CONFIG_DIR at a
// fixture so these tests read their own bindings rather than the developer's.
// The fixture needs a daemon.yaml too: it is the environment authority, and the
// environment names the bindings file.
const CONFIG_DIR_FIXTURE = mkdtempSync(join(tmpdir(), 'preamble-bindings-'))
process.env.TLDA_CONFIG_DIR = CONFIG_DIR_FIXTURE
process.env.TLDA_ENV = 'preamble-test'
writeFileSync(join(CONFIG_DIR_FIXTURE, 'daemon.yaml'), [
  'environments:',
  '  default: preamble-test',
  '  values:',
  '    preamble-test:',
  '      database: http://127.0.0.1:1',
  '      store: http://127.0.0.1:1',
  '      licenseKey: ""',
  '',
].join('\n'))

const { daemonStateSuffix } = await import('../shared/daemon-socket-path.mjs')
const { getActiveEnvName } = await import('../shared/config.mjs')
const BINDINGS_FILE = join(CONFIG_DIR_FIXTURE, `source-bindings${daemonStateSuffix(getActiveEnvName())}.json`)

function writeSourceBindings(bindings) {
  writeFileSync(BINDINGS_FILE, JSON.stringify(bindings))
}

function clearSourceBindings() {
  rmSync(BINDINGS_FILE, { force: true })
}

const {
  __resetAgentPreambleForTest,
  __setFleetTransportForTest,
  handleFleetTool,
  setAgentPreambleDoc,
} = await import('./fleet-tools.mjs')

function installFetchStub({ macros = {} } = {}) {
  const originalFetch = globalThis.fetch
  const setMetadataCalls = []
  globalThis.fetch = async (url, opts = {}) => {
    const href = String(url)
    if (href.includes('/api/set-metadata')) {
      const body = JSON.parse(opts.body || '{}')
      setMetadataCalls.push(body)
      return new Response(JSON.stringify({ ok: true, metadata: body }), { status: 200 })
    }
    if (href.includes('/api/projects/paper/macros')) {
      return new Response(JSON.stringify({ macros }), { status: 200 })
    }
    if (href.endsWith('/api/projects') || href.includes('/api/projects?')) {
      return new Response(JSON.stringify({ projects: [] }), { status: 200 })
    }
    if (href.includes('/api/projects/paper/history/shadow')) {
      return new Response(JSON.stringify({ versions: [{ hash: 'freshver' }] }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }
  return { restore: () => { globalThis.fetch = originalFetch }, setMetadataCalls }
}

function installTransportStub({ persistedPreamble = null, failMetadataReads = 0 } = {}) {
  const durableCalls = []
  let metadataReads = 0
  __setFleetTransportForTest({
    ephemeral: async (operation, payload) => {
      if (operation === 'store-agents-by-ids') {
        const isPreambleRead = payload.ids.length === 1 && payload.ids[0] === 'fleet:test-agent'
        if (isPreambleRead) {
          metadataReads += 1
          if (metadataReads <= failMetadataReads) throw new Error('metadata read failed')
        }
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
  return { durableCalls, metadataReads: () => metadataReads }
}

test('chat preamble reloads from agent metadata after MCP reconnect', async () => {
  __resetAgentPreambleForTest()
  const { restore } = installFetchStub({ macros: { '\\foo': 'x' } })
  const { durableCalls } = installTransportStub({
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
    restore()
  }
})

test('transient preamble metadata read failure is retried on the next chat', async () => {
  __resetAgentPreambleForTest()
  const { restore } = installFetchStub({ macros: { '\\foo': 'x' } })
  const { durableCalls, metadataReads } = installTransportStub({
    persistedPreamble: { doc: 'paper', version: 'pinned' },
    failMetadataReads: 1,
  })
  try {
    const first = await handleFleetTool('chat', {
      to: 'fleet:skip',
      message: 'Uses paper macro $\\foo$.',
    })
    assert.equal(first.isError, undefined)
    assert.equal(durableCalls.length, 1)
    assert.match(first.content[0].text, /Won't render properly/)

    const second = await handleFleetTool('chat', {
      to: 'fleet:skip',
      message: 'Uses paper macro $\\foo$.',
    })
    assert.equal(second.isError, undefined)
    assert.equal(durableCalls.length, 2)
    assert.equal(metadataReads(), 2)
    assert.deepEqual(durableCalls[1].payload.preambleRef, { doc: 'paper', version: 'pinned' })
  } finally {
    restore()
  }
})

test('configuration preamble write persists metadata used by a fresh MCP process', async () => {
  __resetAgentPreambleForTest()
  const { restore, setMetadataCalls } = installFetchStub({ macros: { '\\foo': 'x' } })
  try {
    await setAgentPreambleDoc('paper', 'pinned', { persist: true })
    assert.deepEqual(setMetadataCalls, [{
      agent: 'fleet:test-agent',
      chatPreamble: { doc: 'paper', version: 'pinned' },
    }])

    __resetAgentPreambleForTest()
    const { durableCalls } = installTransportStub({
      persistedPreamble: setMetadataCalls[0].chatPreamble,
    })
    const result = await handleFleetTool('chat', {
      to: 'fleet:skip',
      message: 'Uses paper macro $\\foo$.',
    })

    assert.equal(result.isError, undefined)
    assert.deepEqual(durableCalls[0].payload.preambleRef, { doc: 'paper', version: 'pinned' })
  } finally {
    restore()
  }
})

test('missing paper macro warning remains post-delivery when no preamble is loaded', async () => {
  __resetAgentPreambleForTest()
  clearSourceBindings()
  const { restore } = installFetchStub()
  const { durableCalls } = installTransportStub()
  try {
    const result = await handleFleetTool('chat', {
      to: 'fleet:skip',
      message: 'Uses missing paper macro $\\foo$.',
    })

    assert.equal(result.isError, undefined)
    assert.equal(durableCalls.length, 1)
    assert.match(result.content[0].text, /Won't render properly/)
    assert.match(result.content[0].text, /macros that aren't loaded/)
  } finally {
    restore()
  }
})

// The defect this file exists for: a fresh agent that never calls
// configuration() still has to render its project's math. Its preamble comes
// from the project its working directory belongs to — the daemon's
// source-bindings — with no tool call it has to know to make. The fixture binds
// the project to the directory this process is running in, which is the
// directory the agent-cwd probe reports.
test('a fresh agent gets its working project as its preamble with no configuration() call', async () => {
  __resetAgentPreambleForTest()
  writeSourceBindings({ paper: process.cwd() })
  const { restore, setMetadataCalls } = installFetchStub({ macros: { '\\foo': 'x' } })
  const { durableCalls } = installTransportStub()
  try {
    const result = await handleFleetTool('chat', {
      to: 'fleet:skip',
      message: 'Uses paper macro $\\foo$.',
    })

    assert.equal(result.isError, undefined)
    assert.equal(durableCalls.length, 1)
    assert.deepEqual(durableCalls[0].payload.preambleRef, { doc: 'paper', version: 'freshve' })
    // Nothing was written to agent metadata: the default is derived, not stored.
    assert.deepEqual(setMetadataCalls, [])
    // The macros resolved, so the renderer can display the message.
    assert.doesNotMatch(result.content[0].text, /macros that aren't loaded/)
  } finally {
    clearSourceBindings()
    restore()
  }
})
