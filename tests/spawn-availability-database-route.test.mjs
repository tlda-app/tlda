import assert from 'node:assert/strict'
import test from 'node:test'

globalThis.window = {
  __TLDA_CONFIG__: {
    name: 'preview',
    database: { http: 'https://fleet.example.test', ws: 'wss://fleet.example.test' },
    store: { http: 'https://preview.example.test', ws: 'wss://preview.example.test' },
    licenseKey: '',
  },
}

const { loadAvailableSpawnModels } = await import('../src/fleet/useAvailableSpawnModels.ts')

test('availability queries the configured fleet database, not the preview store', async () => {
  let url = null
  const models = await loadAvailableSpawnModels('fleet:skip', { doc: 'bregman' }, async nextUrl => {
    url = nextUrl
    return new Response(JSON.stringify({
      ok: true,
      machine_id: 'mini',
      route: 'caller-configured-spawn-machine',
      aliases: ['terra'],
      defaultAlias: 'terra',
      capabilities: {
        machine: 'mini',
        default: { alias: 'terra' },
        harnesses: {
          codex: {
            kind: 'codex',
            available: true,
            models: [{ alias: 'terra', available: true, verified: true }],
          },
        },
      },
    }))
  })

  assert.equal(
    url,
    'https://fleet.example.test/api/fleet/spawn-availability?target=fresh-spawn-current&user=fleet%3Askip&doc=bregman',
  )
  assert.deepEqual(models.aliases, ['terra'])
  assert.equal(models.defaultAlias, 'terra')
})
