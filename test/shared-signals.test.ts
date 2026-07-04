import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SignalBus } from '../src/signalBus.ts'
import { SIGNAL_REPLAY_WINDOWS, getSignalReplayMs } from '../shared/signals.ts'

test('shared replay table is soft replay, not durable state', () => {
  assert.deepEqual(SIGNAL_REPLAY_WINDOWS, {
    'signal:build-status': 600_000,
    'signal:build-progress': 300_000,
    'signal:agent-heartbeat': 30_000,
    'signal:diff-review': 86_400_000,
    'signal:diff-summaries': 86_400_000,
    'signal:viewport': 300_000,
    'signal:presenter': 600_000,
    'signal:slide-index': 600_000,
    'signal:slide-fragment': 600_000,
  })

  assert.equal(getSignalReplayMs('signal:reload'), undefined)
  assert.equal(getSignalReplayMs('signal:compare'), undefined)
  assert.equal(getSignalReplayMs('signal:file-updated'), undefined)
  assert.equal(getSignalReplayMs('signal:screenshot-request'), undefined)
})

test('direct signal dispatch drops stale and out-of-order signals', () => {
  const bus = new SignalBus()
  const seen: number[] = []
  const handle = bus.register<{ timestamp: number; value: string }>({ key: 'signal:test' })
  handle.on((signal) => {
    seen.push(signal.timestamp)
  })

  bus.dispatchDirect('signal:test', { timestamp: 20, value: 'new' })
  bus.dispatchDirect('signal:test', { timestamp: 10, value: 'stale' })
  bus.dispatchDirect('signal:test', { timestamp: 20, value: 'duplicate' })
  bus.dispatchDirect('signal:test', { timestamp: 30, value: 'newer' })

  assert.deepEqual(seen, [20, 30])
})
