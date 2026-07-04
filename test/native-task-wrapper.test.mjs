import test from 'node:test'
import assert from 'node:assert/strict'

import { FleetStore } from '../server/lib/fleet-store.mjs'
import { applyNativeTaskEvents } from '../server/lib/native-task-wrapper.mjs'

test('native task events create flagged tasks first and completion removes them from active list', () => {
  const store = new FleetStore(':memory:')
  try {
    store.upsertAgent({ id: 'fleet:a1', friendly_name: 'agent-one', labels: [] })
    store.upsertTask({
      id: 'ordinary-1',
      agent: 'fleet:a1',
      description: 'Ordinary assigned work',
      message: 'Ordinary assigned work',
      delegated_at: '2026-07-04T12:00:00.000Z',
      status: 'pending',
    })

    const create = applyNativeTaskEvents(store, {
      agent_id: 'fleet:a1',
      harness: 'claude',
      session_id: 'sess1',
      source_path: '/tmp/session.jsonl',
      events: [{
        action: 'create',
        nativeSystem: 'claude',
        nativeTaskId: '2',
        timestamp: '2026-07-04T12:01:00.000Z',
        subject: 'Native wrapper proof',
        description: 'This should surface in inbox.',
        activeForm: 'checking the wrapper',
        status: 'pending',
        input: { subject: 'Native wrapper proof' },
      }],
    })
    assert.equal(create.changed, true)

    let active = store.getActiveTasksByAgent('fleet:a1')
    assert.equal(active.length, 2)
    assert.equal(active[0].id, 'native:claude:fleet:a1:sess1:2')
    assert.equal(active[0].metadata.native, true)
    assert.equal(active[0].metadata.native_system, 'claude')
    assert.match(active[0].message, /Native task in Claude Code/)
    assert.match(active[0].message, /Subject: Native wrapper proof/)

    applyNativeTaskEvents(store, {
      agent_id: 'fleet:a1',
      harness: 'claude',
      session_id: 'sess1',
      events: [{
        action: 'update',
        nativeSystem: 'claude',
        nativeTaskId: '2',
        timestamp: '2026-07-04T12:02:00.000Z',
        status: 'working',
        description: 'Working status update',
      }],
    })
    active = store.getActiveTasksByAgent('fleet:a1')
    assert.equal(active[0].status, 'working')
    assert.match(active[0].message, /Subject: Native wrapper proof/)
    assert.match(active[0].message, /Description: Working status update/)

    applyNativeTaskEvents(store, {
      agent_id: 'fleet:a1',
      harness: 'claude',
      session_id: 'sess1',
      events: [{
        action: 'update',
        nativeSystem: 'claude',
        nativeTaskId: '2',
        timestamp: '2026-07-04T12:03:00.000Z',
        status: 'done',
      }],
    })
    active = store.getActiveTasksByAgent('fleet:a1')
    assert.deepEqual(active.map(t => t.id), ['ordinary-1'])

    const history = store.getTask('native:claude:fleet:a1:sess1:2')
    assert.equal(history.status, 'done')
    assert.equal(history.metadata.native, true)
    assert.equal(history.completed_at, '2026-07-04T12:03:00.000Z')
  } finally {
    store.close()
  }
})
