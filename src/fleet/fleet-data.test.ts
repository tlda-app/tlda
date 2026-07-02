/// <reference types="node" />

import assert from 'node:assert/strict'
import test from 'node:test'

import { matchesFleetFilter } from './filter-semantics.mjs'
import { makeEventStore } from './event-store.mjs'
import { pretty_name_parts, pretty_name_plain_text } from '../../shared/pretty_name.mjs'
import {
  fleetFilterHasMatchingAgent,
  getAwakeFleetAgentCount,
  getFilteredFleetEvents,
  getFleetEvents,
  getResolvedFleetAgentIdsForLabel,
  getResolvedFleetAgentIds,
  replaceFleetEvents,
  replaceFleetAgents,
  resetFleetAgentStoreForTest,
  resetFleetEventStoreForTest,
  upsertFleetAgents,
  upsertFleetEvent,
  viewFleetEvents,
  type FleetEvent,
} from './fleet-data.ts'

type TestEvent = {
  type: string
  from?: string
  to?: string
  text: string
  timestamp: string
  _dbId: number
  read?: boolean
}

const agents = [
  { id: 'fleet:skip', friendly_name: 'skip', status: 'human', labels: [] },
  { id: 'fleet:alpha', friendly_name: 'alpha', status: 'alive', labels: ['math'] },
  { id: 'fleet:beta', friendly_name: 'beta', status: 'alive', labels: ['apps'] },
  { id: 'fleet:gamma', friendly_name: 'gamma', status: 'alive', labels: ['math', 'apps'] },
]

const context = { agents, humanId: 'fleet:skip', humanName: 'skip' }
const filters = [
  null,
  [[['from', 'math']]],
  [[['to', 'skip']]],
  [[['dm', 'alpha']]],
  [[['from', 'apps']], [['to', 'apps']]],
]

function eventAt(id: number, from: string, to: string | undefined, minute: number): TestEvent {
  return {
    type: 'chat',
    from,
    to,
    text: `event ${id}`,
    timestamp: `2026-06-20T12:${String(minute).padStart(2, '0')}:00.000Z`,
    _dbId: id,
    read: false,
  }
}

function visible(event: FleetEvent, filter: unknown): boolean {
  return matchesFleetFilter(filter, event, context)
}

function ids(events: readonly { _dbId?: string | number }[]): (string | number | undefined)[] {
  return events.map((event) => event._dbId)
}

test('fleet event views match old getEvents().filter(matchesFilter) after every event', () => {
  resetFleetEventStoreForTest()
  const oldStore = makeEventStore()
  const views = filters.map((filter, i) => ({
    filter,
    view: viewFleetEvents(filter, {
      key: `equivalence:${i}`,
      matchesFilter: (f, event) => visible(event, f),
    }),
  }))

  const stream = [
    eventAt(1, 'fleet:alpha', 'fleet:skip', 1),
    eventAt(2, 'fleet:skip', 'fleet:alpha', 2),
    eventAt(3, 'fleet:beta', 'fleet:skip', 3),
    eventAt(4, 'fleet:gamma', undefined, 4),
    eventAt(5, 'system', undefined, 5),
    { ...eventAt(3, 'fleet:beta', 'fleet:skip', 3), text: 'event 3 patched', read: true },
    eventAt(6, 'fleet:skip', 'fleet:gamma', 6),
    eventAt(7, 'fleet:alpha', undefined, 7),
  ]

  for (const event of stream) {
    const { event: oldEvent } = oldStore.upsert(event)
    upsertFleetEvent(oldEvent)

    for (const { filter, view } of views) {
      const expected = oldStore.all().filter((candidate: FleetEvent) => visible(candidate, filter))
      assert.deepEqual(ids(view.get()), ids(expected))
    }
  }

  for (const { view } of views) view.dispose()
})

test('replaceFleetEvents preserves old store ordering for scrollback prepends', () => {
  resetFleetEventStoreForTest()
  const oldStore = makeEventStore()
  const view = viewFleetEvents(null, {
    key: 'scrollback-order',
    matchesFilter: (filter, event) => visible(event, filter),
  })

  const liveTail = [
    eventAt(10, 'fleet:alpha', 'fleet:skip', 10),
    eventAt(11, 'fleet:beta', 'fleet:skip', 11),
  ]
  for (const event of liveTail) {
    const { event: oldEvent } = oldStore.upsert(event)
    upsertFleetEvent(oldEvent)
  }

  const scrollback = [
    eventAt(8, 'fleet:skip', 'fleet:alpha', 8),
    eventAt(9, 'fleet:gamma', undefined, 9),
  ]
  for (const event of scrollback) oldStore.upsert(event)
  replaceFleetEvents(oldStore.all())

  assert.deepEqual(ids(view.get()), ids(oldStore.all()))
  assert.deepEqual(ids(getFleetEvents()), [8, 9, 10, 11])
  view.dispose()
})

test('pure snapshots and repeated keyed views do not duplicate event rows', () => {
  resetFleetEventStoreForTest([
    eventAt(20, 'fleet:skip', 'fleet:alpha', 20),
    eventAt(21, 'fleet:alpha', 'fleet:skip', 21),
  ])
  const filter = [[['from', 'skip']], [['to', 'skip']]]
  const opts = {
    key: 'chat-lifecycle',
    matchesFilter: (f: unknown, event: FleetEvent) => visible(event, f),
  }

  assert.deepEqual(ids(getFilteredFleetEvents(filter, opts)), [20, 21])

  const first = viewFleetEvents(filter, opts)
  const second = viewFleetEvents(filter, opts)
  assert.equal(first, second)

  upsertFleetEvent(eventAt(22, 'fleet:skip', 'fleet:beta', 22))
  assert.deepEqual(ids(first.get()), [20, 21, 22])
  assert.deepEqual(ids(second.get()), [20, 21, 22])
  assert.equal(new Set(ids(second.get())).size, second.get().length)

  first.dispose()
  assert.deepEqual(ids(second.get()), [20, 21, 22])
  second.dispose()
  upsertFleetEvent(eventAt(23, 'fleet:skip', 'fleet:gamma', 23))
  assert.deepEqual(ids(second.get()), [])
})

test('fleet agent indexed resolver matches live/dead filter semantics', () => {
  resetFleetAgentStoreForTest([
    { id: 'fleet:old-chief', friendly_name: 'chief', status: 'hibernating', dead: true, labels: [] },
    { id: 'fleet:chief', friendly_name: 'chief', status: 'awake', dead: false, labels: [] },
    { id: 'fleet:chat-render-fix', friendly_name: 'chat-render-fix', status: 'hibernating', dead: false, labels: [] },
  ])

  assert.deepEqual(
    [...getResolvedFleetAgentIds([[['from', 'chief']], [['to', 'chief']]])].sort(),
    ['fleet:chief']
  )
  assert.deepEqual(
    [...getResolvedFleetAgentIds([[['from', 'chief']], [['to', 'chief']]], { status: 'hibernating' })],
    []
  )
  assert.deepEqual(
    [...getResolvedFleetAgentIds([[['from', 'chat-render-fix']], [['to', 'chat-render-fix']]], { status: 'hibernating' })],
    ['fleet:chat-render-fix']
  )

  upsertFleetAgents([{ id: 'fleet:chief', friendly_name: 'chief', status: 'dead', dead: true, labels: [] }])

  assert.deepEqual(
    [...getResolvedFleetAgentIds([[['from', 'chief']], [['to', 'chief']]])].sort(),
    ['fleet:chief', 'fleet:old-chief']
  )
  resetFleetAgentStoreForTest()
})

test('replaceFleetAgents and deltas maintain the label index without roster scans', () => {
  resetFleetAgentStoreForTest()
  replaceFleetAgents([
    { id: 'fleet:alpha', friendly_name: 'alpha', status: 'awake', labels: ['math'] },
    { id: 'fleet:beta', friendly_name: 'beta', status: 'hibernating', labels: ['math'] },
  ])
  assert.deepEqual(
    [...getResolvedFleetAgentIds([[['from', 'math']]], { status: 'hibernating' })],
    ['fleet:beta']
  )

  upsertFleetAgents([{ id: 'fleet:alpha', friendly_name: 'alpha', status: 'hibernating', labels: ['math'] }])
  assert.deepEqual(
    [...getResolvedFleetAgentIds([[['from', 'math']]], { status: 'hibernating' })].sort(),
    ['fleet:alpha', 'fleet:beta']
  )
  resetFleetAgentStoreForTest()
})

test('fleet agent label resolver uses the maintained label index', () => {
  resetFleetAgentStoreForTest([
    { id: 'fleet:old-chief', friendly_name: 'chief', status: 'dead', dead: true, labels: [] },
    { id: 'fleet:chief', friendly_name: 'chief', status: 'awake', dead: false, labels: [] },
    { id: 'fleet:helper', friendly_name: 'helper', status: 'awake', labels: ['math'] },
  ])

  assert.deepEqual(getResolvedFleetAgentIdsForLabel('chief'), ['fleet:chief'])
  assert.deepEqual(getResolvedFleetAgentIdsForLabel('math'), ['fleet:helper'])
  assert.deepEqual(getResolvedFleetAgentIdsForLabel('missing'), [])
  assert.deepEqual(getResolvedFleetAgentIdsForLabel('fleet:direct'), ['fleet:direct'])

  resetFleetAgentStoreForTest()
})

test('pretty_name labels do not resolve as stripped behavior names', () => {
  resetFleetAgentStoreForTest([
    { id: 'fleet:chief-day', friendly_name: 'chief:day', pretty_name: 'chief:day', status: 'awake', dead: false, labels: [] },
  ])

  assert.deepEqual(pretty_name_parts(null, 'chief:day'), ['chief:day'])
  assert.equal(pretty_name_plain_text(null, 'chief:day'), 'chief:day')
  assert.deepEqual(getResolvedFleetAgentIds([[['dm', 'chief']]]), [])
  assert.deepEqual(
    getResolvedFleetAgentIds([[['dm', 'chief:day']]]),
    ['fleet:chief-day']
  )

  resetFleetAgentStoreForTest()
})

test('pretty_name supports convention-owned glyph rules without changing friendly_name', () => {
  const friendly_name = 'the-artist-formerly-known-as:prince'
  const pretty_name = [{ kind: 'glyph', id: 'love-symbol', glyph: 'Love' }, 'the-artist-formerly-known-as']

  assert.deepEqual(pretty_name_parts(pretty_name, friendly_name), [
    { kind: 'glyph', id: 'love-symbol', glyph: 'Love', label: 'Love' },
    'the-artist-formerly-known-as',
  ])
  assert.equal(pretty_name_plain_text(pretty_name, friendly_name), 'Love the-artist-formerly-known-as')
  assert.equal(friendly_name, 'the-artist-formerly-known-as:prince')
})

test('fleet filter possible check is stable across unrelated agent churn', () => {
  resetFleetAgentStoreForTest([
    { id: 'fleet:chief', friendly_name: 'chief', status: 'awake', labels: [] },
    { id: 'fleet:helper', friendly_name: 'helper', status: 'awake', labels: ['math'] },
  ])

  const chiefFilter: [string, string][][] = [[['dm', 'chief']]]
  const missingFilter: [string, string][][] = [[['dm', 'missing']]]

  assert.equal(fleetFilterHasMatchingAgent(chiefFilter, { id: 'fleet:skip', name: 'skip' }), true)
  assert.equal(fleetFilterHasMatchingAgent(missingFilter, { id: 'fleet:skip', name: 'skip' }), false)

  upsertFleetAgents([{ id: 'fleet:unrelated', friendly_name: 'unrelated', status: 'hibernating', labels: ['other'] }])
  assert.equal(fleetFilterHasMatchingAgent(chiefFilter, { id: 'fleet:skip', name: 'skip' }), true)
  assert.equal(fleetFilterHasMatchingAgent(missingFilter, { id: 'fleet:skip', name: 'skip' }), false)

  upsertFleetAgents([{ id: 'fleet:missing', friendly_name: 'missing', status: 'awake', labels: [] }])
  assert.equal(fleetFilterHasMatchingAgent(missingFilter, { id: 'fleet:skip', name: 'skip' }), true)

  resetFleetAgentStoreForTest()
})

test('awake fleet agent count is a maintained derived index', () => {
  resetFleetAgentStoreForTest([
    { id: 'fleet:skip', friendly_name: 'skip', status: 'awake', human: true, labels: [] },
    { id: 'fleet:alpha', friendly_name: 'alpha', status: 'awake', labels: [] },
    { id: 'fleet:beta', friendly_name: 'beta', status: 'hibernating', labels: [] },
    { id: 'fleet:gamma', friendly_name: 'gamma', status: 'dead', dead: true, labels: [] },
  ])

  assert.equal(getAwakeFleetAgentCount(), 1)

  upsertFleetAgents([{ id: 'fleet:unrelated', friendly_name: 'unrelated', status: 'hibernating', labels: [] }])
  assert.equal(getAwakeFleetAgentCount(), 1)

  upsertFleetAgents([{ id: 'fleet:beta', friendly_name: 'beta', status: 'awake', labels: [] }])
  assert.equal(getAwakeFleetAgentCount(), 2)

  upsertFleetAgents([{ id: 'fleet:alpha', friendly_name: 'alpha', status: 'dead', dead: true, labels: [] }])
  assert.equal(getAwakeFleetAgentCount(), 1)

  resetFleetAgentStoreForTest()
})
