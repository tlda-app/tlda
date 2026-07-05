import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolveSpawnMachine } from '../server/lib/spawn-routing.mjs'
import { resolveFreshSpawnCapabilityModels } from '../server/lib/spawn-capability-models.mjs'
import { flattenAvailableSpawnModels, spawnModelsFromCapabilitiesResponse } from '../shared/spawn-model-options.mjs'
import { loadAvailableSpawnModels } from '../src/fleet/useAvailableSpawnModels.ts'

const user = { id: 'fleet:skip', human: true }

function capability({ machine = 'mini', harnesses, defaultAlias }) {
  return {
    schema: 1,
    machine,
    generated_at: '2026-06-28T00:00:00.000Z',
    default: defaultAlias ? { alias: defaultAlias, kind: 'test', model: defaultAlias } : null,
    harnesses,
  }
}

const codexOnly = capability({
  defaultAlias: 'gpt',
  harnesses: {
    claude: { available: false, models: [{ alias: 'opus48', available: true, verified: true }] },
    codex: {
      available: true,
      models: [
        { alias: 'codex', available: true, verified: true },
        { alias: 'gpt', available: true, verified: true },
        { alias: 'gpt55', available: true, verified: true },
      ],
    },
    goose: { available: false, models: [{ alias: 'deepseek', available: true, verified: true }] },
  },
})

const multiHarness = capability({
  defaultAlias: 'opus',
  harnesses: {
    claude: {
      available: true,
      models: [
        { alias: 'opus', available: true, verified: true },
        { alias: 'fable', available: true, verified: true },
        { alias: 'sonnet', available: true, verified: true },
      ],
    },
    codex: {
      available: true,
      models: [
        { alias: 'gpt', available: true, verified: true },
        { alias: 'unverified-codex', available: true, verified: false },
      ],
    },
    goose: {
      available: true,
      models: [
        { alias: 'deepseek', available: true, verified: true },
        { alias: 'cursor', available: false, verified: true },
      ],
    },
  },
})

test('Codex-only capability yields only Codex aliases and Codex default', () => {
  assert.deepEqual(flattenAvailableSpawnModels(codexOnly), {
    aliases: ['codex', 'gpt', 'gpt55'],
    defaultAlias: 'gpt',
    machine: 'mini',
    generated_at: '2026-06-28T00:00:00.000Z',
  })
})

test('multi-harness capability yields available verified aliases and Claude default', () => {
  const flattened = flattenAvailableSpawnModels(multiHarness)
  assert.deepEqual(flattened.aliases, ['opus', 'fable', 'sonnet', 'gpt', 'deepseek'])
  assert.equal(flattened.defaultAlias, 'opus')
})

test('no capability response collapses model UI data to Default-only inputs', () => {
  const flattened = spawnModelsFromCapabilitiesResponse({
    schema: 1,
    target: 'fresh-spawn-current',
    ok: false,
    error: 'No fleet daemon connected',
    aliases: [],
    defaultAlias: '',
  })
  assert.deepEqual(flattened.aliases, [])
  assert.equal(flattened.defaultAlias, '')
  assert.equal(flattened.ok, false)
})

test('frontend loader uses fresh-spawn-current endpoint instead of global model registry', async () => {
  const calls = []
  const result = await loadAvailableSpawnModels('fleet:skip', async (url) => {
    calls.push(String(url))
    return {
      ok: true,
      json: async () => ({
        schema: 1,
        target: 'fresh-spawn-current',
        ok: true,
        machine_id: 'mini',
        route: 'sole-connected-daemon',
        capabilities: codexOnly,
      }),
    }
  })
  assert.deepEqual(calls, ['/api/fleet/spawn-capabilities?target=fresh-spawn-current&user=fleet%3Askip'])
  assert.deepEqual(result.aliases, ['codex', 'gpt', 'gpt55'])
  assert.equal(result.defaultAlias, 'gpt')
})

test('fresh-spawn endpoint helper resolves target machine server-side before probing', async () => {
  const daemonConnections = new Map([['mini:stable', { _machineId: 'mini', _envName: 'stable' }]])
  const fleetStore = {
    getAgent: id => id === user.id ? user : null,
    getFleetPref: () => undefined,
  }
  const rpcCalls = []
  const result = await resolveFreshSpawnCapabilityModels({
    userId: user.id,
    fleetStore,
    daemonConnections,
    resolveSpawnMachine,
    sendRpc: async (machineId, op) => {
      rpcCalls.push({ machineId, op })
      return multiHarness
    },
  })

  assert.deepEqual(rpcCalls, [{ machineId: 'mini', op: 'spawn-capabilities' }])
  assert.equal(result.ok, true)
  assert.equal(result.machine_id, 'mini')
  assert.equal(result.route, 'sole-connected-daemon')
  assert.deepEqual(result.aliases, ['opus', 'fable', 'sonnet', 'gpt', 'deepseek'])
  assert.equal(result.defaultAlias, 'opus')
})

test('fresh-spawn endpoint helper returns no aliases when no target capability exists', async () => {
  const result = await resolveFreshSpawnCapabilityModels({
    userId: user.id,
    fleetStore: {
      getAgent: id => id === user.id ? user : null,
      getFleetPref: () => undefined,
    },
    daemonConnections: new Map(),
    resolveSpawnMachine,
    sendRpc: async () => { throw new Error('should not probe without a route') },
  })

  assert.equal(result.ok, false)
  assert.deepEqual(result.aliases, [])
  assert.equal(result.defaultAlias, '')
  assert.match(result.error, /No fleet daemon connected/)
})

test('voice backend picker is server/browser gated, not a static backend list', () => {
  const prefs = readFileSync(new URL('../src/panels/PrefsTab.tsx', import.meta.url), 'utf8')
  const server = readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')

  assert.match(prefs, /fetch\('\/api\/voice\/backends'\)/)
  assert.match(prefs, /SpeechRecognition \|\| speechWindow\.webkitSpeechRecognition/)
  assert.match(prefs, /voiceBackends\.map\(backend =>/)
  assert.doesNotMatch(prefs, /value=['"]deepgram-sdk['"][^]*value=['"]whisper['"]/)

  assert.match(server, /if \(hasDeepgramKey\(\)\) backends\.push/)
  assert.match(server, /if \(await isBridgeUp\(WHISPER_BRIDGE_URL\)\) backends\.push/)
})
