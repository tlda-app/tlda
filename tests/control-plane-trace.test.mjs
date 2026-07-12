import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createControlPlaneTraceStore,
  renderControlPlaneTraceMarkdown,
  traceIdFromFleetEvent,
} from '../server/lib/observability/control-plane-trace.mjs'

test('trace id is read from persisted fleet event metadata', () => {
  assert.equal(traceIdFromFleetEvent({ metadata: { trace_id: 'chat:abc' } }), 'chat:abc')
  assert.equal(traceIdFromFleetEvent({ trace_id: 'delegate:def' }), 'delegate:def')
  assert.equal(traceIdFromFleetEvent({ metadata: {} }), null)
})

test('store groups hops by trace and renders a single-operation timeline', () => {
  const store = createControlPlaneTraceStore({ maxEvents: 10, maxTraces: 10 })
  store.append({
    trace_id: 'chat:abc',
    ts: '2026-07-12T10:00:00.000Z',
    component: 'server',
    operation: 'chat.ingress',
    status: 'received',
    detail: { from: 'fleet:skip', to: 'mend' },
  })
  store.append({
    trace_id: 'chat:abc',
    ts: '2026-07-12T10:00:01.000Z',
    component: 'fleet-store',
    operation: 'chat.insert',
    status: 'stored',
    detail: { event_id: 123 },
  })

  const snapshot = store.snapshot({ traceId: 'chat:abc' })
  assert.equal(snapshot.trace.events.length, 2)
  assert.equal(snapshot.trace.events[1].detail.event_id, 123)

  const md = renderControlPlaneTraceMarkdown(snapshot)
  assert.match(md, /Trace: `chat:abc`/)
  assert.match(md, /chat\.ingress/)
  assert.match(md, /event_id=123/)
})

test('store trims old traces when event retention is exceeded', () => {
  const store = createControlPlaneTraceStore({ maxEvents: 2, maxTraces: 10 })
  store.append({ trace_id: 'one', ts: '2026-07-12T10:00:00.000Z', operation: 'first' })
  store.append({ trace_id: 'two', ts: '2026-07-12T10:00:01.000Z', operation: 'second' })
  store.append({ trace_id: 'three', ts: '2026-07-12T10:00:02.000Z', operation: 'third' })

  assert.equal(store.get('one'), null)
  assert.equal(store.get('two').events.length, 1)
  assert.deepEqual(store.recent(3).map(t => t.trace_id), ['three', 'two'])
})
