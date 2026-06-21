/// <reference types="node" />

import assert from 'node:assert/strict'
import test from 'node:test'

import { matchesFleetFilter } from './filter-semantics.mjs'
import { makeEventStore } from './event-store.mjs'
import {
  getFleetEvents,
  replaceFleetEvents,
  resetFleetEventStoreForTest,
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
