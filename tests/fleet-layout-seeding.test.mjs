import assert from 'node:assert/strict'
import test from 'node:test'

globalThis.window = {
  location: { search: '' },
  addEventListener() {},
  __TLDA_CONFIG__: {
    name: 'test',
    database: { http: 'http://127.0.0.1:5176', ws: 'ws://127.0.0.1:5176' },
    store: { http: 'http://127.0.0.1:5176', ws: 'ws://127.0.0.1:5176' },
    licenseKey: '',
  },
}
globalThis.localStorage = {
  getItem() { return null },
  setItem() {},
}

const { defaultFleetLayoutChatFilters } = await import('../src/shapes/fleet-layout-seeding.ts')

const filterFor = name => [[['from', name]], [['to', name]]]

test('default layout replaces duplicate preserved chat assignments with a distinct agent', () => {
  const duplicate = filterFor('alpha')
  const filters = defaultFleetLayoutChatFilters({
    agents: [
      { id: 'agent-alpha', friendly_name: 'alpha', last_seen: '2026-07-11T12:00:00Z' },
      { id: 'agent-beta', friendly_name: 'beta', last_seen: '2026-07-11T11:00:00Z' },
    ],
    humanId: 'fleet:skip',
    existingChatFilters: [duplicate, duplicate],
    panelCount: 2,
  })

  assert.deepEqual(filters, [filterFor('alpha'), filterFor('beta')])
})

test('default layout preserves distinct existing chat assignments', () => {
  const filters = defaultFleetLayoutChatFilters({
    agents: [
      { id: 'agent-alpha', friendly_name: 'alpha', last_seen: '2026-07-11T12:00:00Z' },
      { id: 'agent-beta', friendly_name: 'beta', last_seen: '2026-07-11T11:00:00Z' },
    ],
    humanId: 'fleet:skip',
    existingChatFilters: [filterFor('beta'), filterFor('alpha')],
    panelCount: 2,
  })

  assert.deepEqual(filters, [filterFor('beta'), filterFor('alpha')])
})
