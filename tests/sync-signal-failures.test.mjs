import assert from 'node:assert/strict'
import test from 'node:test'

import { broadcastSignal, initSyncRooms, onSignal } from '../server/lib/sync-rooms.mjs'

test('broadcastSignal reports listener failures without throwing', () => {
  const failures = []
  initSyncRooms('/tmp/tlda-sync-signal-test', {
    onSignalFailure(failure) {
      failures.push(failure)
    },
  })

  const unsubscribe = onSignal('doc-signal-failure-test', () => {
    throw new Error('listener failed')
  })

  try {
    assert.doesNotThrow(() => {
      broadcastSignal('doc-signal-failure-test', 'signal:test', { value: 1 })
    })
  } finally {
    unsubscribe()
  }

  assert.equal(failures.length, 1)
  assert.equal(failures[0].operation, 'listener')
  assert.equal(failures[0].docName, 'doc-signal-failure-test')
  assert.equal(failures[0].key, 'signal:test')
  assert.match(failures[0].error, /listener failed/)
  assert.equal(typeof failures[0].timestamp, 'number')
})
