import assert from 'node:assert/strict'
import test from 'node:test'

const { defaultFleetLayoutChatFilters } = await import('../src/shapes/fleet-layout-seeding.ts')

const filterFor = name => [[['from', name]], [['to', name]]]

test('four-chat layout seeds four distinct recent conversations when available', () => {
  const agents = [
    { id: 'fleet:self', friendly_name: 'skip', human: true, last_seen: '2026-08-11T12:00:00Z' },
    { id: 'fleet:alpha', friendly_name: 'alpha', last_seen: '2026-08-11T08:00:00Z' },
    { id: 'fleet:beta', friendly_name: 'beta', last_seen: '2026-08-11T07:00:00Z' },
    { id: 'fleet:gamma', friendly_name: 'gamma', last_seen: '2026-08-11T06:00:00Z' },
    { id: 'fleet:delta', friendly_name: 'delta', last_seen: '2026-08-11T05:00:00Z' },
  ]
  const events = [
    { id: 1, type: 'chat', timestamp: '2026-08-11T10:00:00Z', from: 'fleet:self', recipients: ['fleet:delta'] },
    { id: 2, type: 'chat', timestamp: '2026-08-11T10:01:00Z', from: 'fleet:gamma', recipients: ['fleet:self'] },
    { id: 3, type: 'chat', timestamp: '2026-08-11T10:02:00Z', from: 'fleet:self', recipients: ['fleet:beta'] },
    { id: 4, type: 'chat', timestamp: '2026-08-11T10:03:00Z', from: 'fleet:alpha', recipients: ['fleet:self'] },
  ]

  const filters = defaultFleetLayoutChatFilters({
    agents,
    events,
    humanId: 'fleet:self',
    humanName: 'skip',
    panelCount: 4,
  })

  assert.deepEqual(filters, [
    filterFor('alpha'),
    filterFor('beta'),
    filterFor('gamma'),
    filterFor('delta'),
  ])
})

test('four-chat layout leaves remaining panels empty only when distinct conversations are insufficient', () => {
  const filters = defaultFleetLayoutChatFilters({
    agents: [
      { id: 'fleet:self', friendly_name: 'skip', human: true, last_seen: '2026-08-11T12:00:00Z' },
      { id: 'fleet:alpha-old', friendly_name: 'alpha', dead: true, last_seen: '2026-08-11T12:00:00Z' },
      { id: 'fleet:alpha', friendly_name: 'alpha', last_seen: '2026-08-11T11:00:00Z' },
      { id: 'fleet:beta', friendly_name: 'beta', last_seen: '2026-08-11T10:00:00Z' },
    ],
    events: [
      { id: 1, type: 'chat', timestamp: '2026-08-11T10:00:00Z', from: 'fleet:self', recipients: ['fleet:alpha'] },
      { id: 2, type: 'chat', timestamp: '2026-08-11T09:00:00Z', from: 'fleet:beta', recipients: ['fleet:self'] },
      { id: 3, type: 'chat', timestamp: '2026-08-11T08:00:00Z', from: 'fleet:self', recipients: ['fleet:alpha-old'] },
    ],
    humanId: 'fleet:self',
    humanName: 'skip',
    panelCount: 4,
  })

  assert.deepEqual(filters, [
    filterFor('alpha'),
    filterFor('beta'),
    [],
    [],
  ])
})
