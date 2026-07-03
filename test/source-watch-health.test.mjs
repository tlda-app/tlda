import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { createRearmableFsWatcher } from '../bin/lib/source-watch-health.mjs'

class FakeWatcher extends EventEmitter {
  constructor() {
    super()
    this.closed = false
  }

  close() {
    this.closed = true
    this.emit('close')
  }
}

function fakeTimers() {
  let nextId = 1
  const timers = new Map()
  return {
    set(fn, ms) {
      const id = nextId++
      timers.set(id, { fn, ms })
      return id
    },
    clear(id) {
      timers.delete(id)
    },
    runNext() {
      const first = [...timers.entries()][0]
      assert.ok(first, 'expected a pending timer')
      timers.delete(first[0])
      first[1].fn()
      return first[1].ms
    },
    count() {
      return timers.size
    },
  }
}

function fakeLog() {
  const entries = []
  return {
    entries,
    info: (msg) => entries.push(['info', msg]),
    warn: (msg) => entries.push(['warn', msg]),
    error: (msg) => entries.push(['error', msg]),
  }
}

test('rearmable fs watcher retries after watcher error', () => {
  const timers = fakeTimers()
  const log = fakeLog()
  const watchers = []
  const subject = createRearmableFsWatcher({
    label: 'paper',
    dir: '/tmp/paper',
    onEvent: () => {},
    log,
    setTimer: timers.set,
    clearTimer: timers.clear,
    watch() {
      const watcher = new FakeWatcher()
      watchers.push(watcher)
      return watcher
    },
  })

  assert.equal(subject.start('test'), true)
  assert.equal(watchers.length, 1)

  watchers[0].emit('error', new Error('fsevents died'))
  assert.equal(watchers[0].closed, true)
  assert.equal(subject.isWatching(), false)
  assert.equal(subject.hasPendingRetry(), true)
  assert.equal(timers.count(), 1)

  assert.equal(timers.runNext(), 1000)
  assert.equal(watchers.length, 2)
  assert.equal(subject.isWatching(), true)
  assert.ok(log.entries.some(([level, msg]) => level === 'warn' && msg.includes('fsevents died')))
})

test('unexpected watcher close schedules a re-arm but intentional stop does not', () => {
  const timers = fakeTimers()
  const watchers = []
  const subject = createRearmableFsWatcher({
    label: 'paper',
    dir: '/tmp/paper',
    onEvent: () => {},
    log: fakeLog(),
    setTimer: timers.set,
    clearTimer: timers.clear,
    watch() {
      const watcher = new FakeWatcher()
      watchers.push(watcher)
      return watcher
    },
  })

  subject.start('test')
  watchers[0].emit('close')
  assert.equal(subject.isWatching(), false)
  assert.equal(subject.hasPendingRetry(), true)
  timers.runNext()
  assert.equal(watchers.length, 2)

  subject.stop()
  assert.equal(watchers[1].closed, true)
  assert.equal(subject.isWatching(), false)
  assert.equal(subject.hasPendingRetry(), false)
  assert.equal(timers.count(), 0)
})

test('manual rearm replaces the active watcher immediately', () => {
  const watchers = []
  const events = []
  const subject = createRearmableFsWatcher({
    label: 'paper',
    dir: '/tmp/paper',
    onEvent: (eventType, filename) => events.push([eventType, filename]),
    log: fakeLog(),
    watch(_dir, _options, onEvent) {
      const watcher = new FakeWatcher()
      watcher.fire = onEvent
      watchers.push(watcher)
      return watcher
    },
  })

  subject.start('viewer connected')
  watchers[0].fire('rename', Buffer.from('main.tex'))
  assert.deepEqual(events, [['rename', Buffer.from('main.tex')]])

  assert.equal(subject.rearm('missed main.tex'), true)
  assert.equal(watchers[0].closed, true)
  assert.equal(watchers.length, 2)
  assert.equal(subject.isWatching(), true)
})

test('watch start failure is retried while the watch is still wanted', () => {
  const timers = fakeTimers()
  let attempts = 0
  const subject = createRearmableFsWatcher({
    label: 'paper',
    dir: '/tmp/paper',
    onEvent: () => {},
    log: fakeLog(),
    setTimer: timers.set,
    clearTimer: timers.clear,
    watch() {
      attempts += 1
      if (attempts === 1) throw new Error('too many open files')
      return new FakeWatcher()
    },
  })

  assert.equal(subject.start('viewer connected'), false)
  assert.equal(subject.hasPendingRetry(), true)
  timers.runNext()
  assert.equal(attempts, 2)
  assert.equal(subject.isWatching(), true)
})
