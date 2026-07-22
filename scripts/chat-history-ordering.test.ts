import assert from 'node:assert/strict'

import { compareChatMessagesChronologically } from '../src/fleet/chat-ordering.mjs'
import {
  clearFleetEventBuffer,
  getFilteredFleetEvents,
  replaceFleetEvents,
  upsertFleetEvent,
  upsertFleetEventsForBuffer,
} from '../src/fleet/fleet-data.ts'

const bufferKey = 'chat:test-shape'
const matchesAll = () => true
const view = () => getFilteredFleetEvents(null, { matchesFilter: matchesAll, bufferKey })
const ids = () => view().map(event => event._dbId ?? event._tempId)

replaceFleetEvents([])
clearFleetEventBuffer(bufferKey)

// Create the panel-owned buffer before any writes, matching a mounted chat panel.
assert.deepEqual(ids(), [])

const optimistic = {
  _tempId: 'opt-send',
  type: 'chat',
  from: 'fleet:skip',
  to: 'fleet:agent',
  text: 'optimistic local echo',
  timestamp: '2026-07-22T10:03:00.000Z',
}
upsertFleetEvent(optimistic)
assert.deepEqual(ids(), ['opt-send'])

upsertFleetEventsForBuffer(bufferKey, [
  {
    _dbId: 101,
    type: 'chat',
    from: 'fleet:agent',
    to: 'fleet:skip',
    text: 'older history row',
    timestamp: '2026-07-22T10:01:00.000Z',
  },
  {
    _dbId: 102,
    type: 'chat',
    from: 'fleet:skip',
    to: 'fleet:agent',
    text: 'newer history row',
    timestamp: '2026-07-22T10:02:00.000Z',
  },
])
assert.deepEqual(ids(), [101, 102, 'opt-send'])

// A reconnect backfill row is fetched by rowid but must render by timestamp.
upsertFleetEvent({
  _dbId: 120,
  type: 'chat',
  from: 'fleet:agent',
  to: 'fleet:skip',
  text: 'late persisted middle row',
  timestamp: '2026-07-22T10:02:30.000Z',
})
assert.deepEqual(ids(), [101, 102, 120, 'opt-send'])

// Reconcile the optimistic object in place; the temp key should be replaced by
// the db key without losing the row from the panel-owned buffer.
optimistic._dbId = 130
delete optimistic._tempId
upsertFleetEvent(optimistic)
assert.deepEqual(ids(), [101, 102, 120, 130])
assert.deepEqual(
  [...view()].sort(compareChatMessagesChronologically).map(event => event._dbId ?? event._tempId),
  [101, 102, 120, 130]
)

clearFleetEventBuffer(bufferKey)
replaceFleetEvents([])

console.log('chat history ordering buffer test passed')
