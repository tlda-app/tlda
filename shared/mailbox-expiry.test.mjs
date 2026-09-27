// P2: expiry is a visible non-verdict. It marks `expired` (never `failed`),
// and it does not consume the once-only settle — a late real verdict
// overwrites it and delivers normally. True terminals stay once-only.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MailboxLibrarian } from './mailbox-librarian.ts'

function harness() {
  const timers = new Map()
  let seq = 0
  const expired = []
  const librarian = new MailboxLibrarian({
    now: () => 1_000_000,
    idGenerator: () => `mailbox:test-${seq}`,
    setTimeoutFn: (fn) => { const id = `t${seq++}`; timers.set(id, fn); return id },
    clearTimeoutFn: (id) => { timers.delete(id) },
    onExpire: (entry) => { expired.push(entry) },
  })
  const fire = (id) => { timers.get(id)?.() }
  const timerIds = () => [...timers.keys()]
  return { librarian, fire, timerIds, expired }
}

function start(librarian) {
  return librarian.start({ kind: 'spawn', ownerId: 'fleet:owner', timeoutMs: 60_000, meta: { name: 'probe' } })
}

test('expiry marks expired, not failed, and calls onExpire', () => {
  const { librarian, fire, timerIds, expired } = harness()
  const entry = start(librarian)
  fire(timerIds()[0])
  const current = librarian.get(entry.id)
  assert.equal(current.status, 'expired')
  assert.equal(current.error, 'deadline exceeded')
  assert.equal(expired.length, 1)
  assert.equal(expired[0].id, entry.id)
})

test('late fail after expiry overwrites and delivers (returns the entry)', () => {
  const { librarian, fire, timerIds } = harness()
  const entry = start(librarian)
  fire(timerIds()[0])
  const settled = librarian.fail(entry.id, 'never-joined', { verdict: 'absent' })
  assert.ok(settled, 'the late verdict must settle, not drop')
  assert.equal(settled.status, 'failed')
  assert.equal(settled.error, 'never-joined')
})

test('late complete after expiry clears the deadline error', () => {
  const { librarian, fire, timerIds } = harness()
  const entry = start(librarian)
  fire(timerIds()[0])
  const settled = librarian.complete(entry.id, { agentId: 'fleet:x' })
  assert.ok(settled)
  assert.equal(settled.status, 'completed')
  assert.equal(settled.error, undefined, 'a verdict naming no error must not inherit the deadline')
})

test('terminals stay once-only: second settle returns null', () => {
  const { librarian } = harness()
  const entry = start(librarian)
  assert.ok(librarian.fail(entry.id, 'boom'))
  assert.equal(librarian.fail(entry.id, 'again'), null)
  assert.equal(librarian.complete(entry.id), null)
  const entry2 = start(librarian)
  assert.ok(librarian.indeterminate(entry2.id, 'waiting'))
  assert.equal(librarian.fail(entry2.id, 'late'), null)
})

test('settle before expiry cancels the timer', () => {
  const { librarian, timerIds } = harness()
  const entry = start(librarian)
  assert.equal(timerIds().length, 1)
  librarian.complete(entry.id)
  assert.equal(timerIds().length, 0)
})
