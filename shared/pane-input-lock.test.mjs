import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync } from 'node:fs'
import {
  acquirePaneInputLock,
  forceClearPaneInputLock,
  readPaneInputLock,
  readParkedWake,
  writeParkedWake,
  clearParkedWake,
  PaneInputLockTimeout,
} from './pane-input-lock.mjs'

const silent = { info() {}, warn() {}, error() {} }

function freshDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'pane-input-lock-test-'))
}

function plantOwner(dir, session, { pid = process.pid, since = Date.now(), op = 'test', token = 'planted' } = {}) {
  const lockPath = path.join(dir, `${encodeURIComponent(session)}.d`)
  fs.mkdirSync(lockPath, { recursive: true })
  fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ token, pid, op, since }))
  return lockPath
}

test('two contenders serialize with no overlap', async () => {
  const dir = freshDir()
  const session = 'pane-a'
  let inside = 0
  let maxInside = 0
  const order = []
  async function contender(name, holdMs) {
    const { release } = await acquirePaneInputLock(session, { dir, log: silent, op: name })
    try {
      inside += 1
      maxInside = Math.max(maxInside, inside)
      order.push(`enter-${name}`)
      await new Promise(r => setTimeout(r, holdMs))
      order.push(`exit-${name}`)
    } finally {
      inside -= 1
      release()
    }
  }
  await Promise.all([contender('first', 150), contender('second', 10)])
  assert.equal(maxInside, 1)
  assert.deepEqual(order, ['enter-first', 'exit-first', 'enter-second', 'exit-second'])
})

test('a contender times out against a fresh live holder', async () => {
  const dir = freshDir()
  const session = 'pane-b'
  const held = await acquirePaneInputLock(session, { dir, log: silent, op: 'holder' })
  try {
    await assert.rejects(
      acquirePaneInputLock(session, { dir, log: silent, timeoutMs: 200, pollMs: 25 }),
      err => err instanceof PaneInputLockTimeout && err.session === session && err.holder?.op === 'holder',
    )
  } finally {
    held.release()
  }
})

test('a dead owner is stolen immediately', async () => {
  const dir = freshDir()
  const session = 'pane-c'
  plantOwner(dir, session, { pid: 2 ** 30 - 1, since: Date.now() })
  const { release, stole } = await acquirePaneInputLock(session, { dir, log: silent, timeoutMs: 2000 })
  try {
    assert.equal(stole, true)
  } finally {
    release()
  }
  assert.equal(readPaneInputLock(session, { dir }), null)
})

test('an ancient live holder is stolen over the hold timeout', async () => {
  const dir = freshDir()
  const session = 'pane-d'
  plantOwner(dir, session, { pid: process.pid, since: Date.now() - 200_000 })
  const { release, stole } = await acquirePaneInputLock(session, { dir, log: silent, timeoutMs: 2000 })
  try {
    assert.equal(stole, true)
  } finally {
    assert.equal(release(), true)
  }
})

test('a stale release cannot delete the new owner', async () => {
  const dir = freshDir()
  const session = 'pane-e'
  const first = await acquirePaneInputLock(session, { dir, log: silent })
  // Simulate a takeover winning while `first` still believes it holds.
  const lockPath = path.join(dir, `${encodeURIComponent(session)}.d`)
  const staleName = `${lockPath}.stale.simulated`
  fs.renameSync(lockPath, staleName)
  fs.mkdirSync(lockPath)
  fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ token: 'second', pid: process.pid, op: 'test', since: Date.now() }))
  assert.equal(first.release(), false)
  assert.equal(readPaneInputLock(session, { dir })?.token, 'second')
})

test('break-glass steals a young live holder; normal waits', async () => {
  const dir = freshDir()
  const session = 'pane-f'
  plantOwner(dir, session, { pid: process.pid, since: Date.now() - 15_000 })
  await assert.rejects(
    acquirePaneInputLock(session, { dir, log: silent, timeoutMs: 200, pollMs: 25 }),
    PaneInputLockTimeout,
  )
  const { release, stole } = await acquirePaneInputLock(session, { dir, log: silent, breakGlass: true, timeoutMs: 2000 })
  try {
    assert.equal(stole, true)
  } finally {
    release()
  }
})

test('forceClear removes the lock and reports the previous owner', async () => {
  const dir = freshDir()
  const session = 'pane-g'
  plantOwner(dir, session, { pid: 4242, op: 'wedged' })
  const prev = forceClearPaneInputLock(session, 'test recovery', { dir, log: silent })
  assert.equal(prev?.pid, 4242)
  assert.equal(readPaneInputLock(session, { dir }), null)
  const { release } = await acquirePaneInputLock(session, { dir, log: silent })
  release()
})

test('parked-wake record round-trips', () => {
  const dir = freshDir()
  const session = 'pane-h'
  assert.equal(readParkedWake(session, { dir }), null)
  writeParkedWake(session, '📬 wake up', { dir })
  const park = readParkedWake(session, { dir })
  assert.equal(park?.line, '📬 wake up')
  assert.ok(typeof park?.at === 'number')
  clearParkedWake(session, { dir })
  assert.equal(readParkedWake(session, { dir }), null)
})
