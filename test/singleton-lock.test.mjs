import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  acquireSingletonLock,
  daemonSingletonLockPath,
  inspectSingletonLock,
  normalizeLockOrigin,
} from '../bin/lib/singleton-lock.mjs'

test('daemonSingletonLockPath keys locks by normalized origin', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-singleton-lock-'))
  try {
    const a = daemonSingletonLockPath({ configDir: dir, origin: 'https://example.test:5176/some/path' })
    const b = daemonSingletonLockPath({ configDir: dir, origin: 'https://example.test:5176/other/path/' })
    const c = daemonSingletonLockPath({ configDir: dir, origin: 'https://other.example.test:5176' })

    assert.equal(a, b)
    assert.notEqual(a, c)
    assert.equal(path.dirname(a), dir)
    assert.match(path.basename(a), /^fleet-daemon\.[0-9a-f]{16}\.lock$/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('normalizeLockOrigin strips path but preserves origin identity', () => {
  assert.equal(normalizeLockOrigin('https://example.test:5176/some/path'), 'https://example.test:5176')
  assert.equal(normalizeLockOrigin('http://example.test/'), 'http://example.test')
  assert.throws(() => normalizeLockOrigin('not a url'))
})

test('inspectSingletonLock reports held while a daemon lock fd is open', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-singleton-lock-'))
  const lockPath = path.join(dir, 'fleet-daemon.lock')
  const installPath = '/tmp/tlda/bin/fleet-daemon.mjs'
  const origin = 'https://example.test:5176'
  const lock = acquireSingletonLock({ lockPath, installPath, origin })
  assert.equal(lock.ok, true)

  try {
    const held = inspectSingletonLock({ lockPath })
    assert.equal(held.held, true)
    assert.equal(held.holder.pid, process.pid)
    assert.equal(held.holder.installPath, installPath)
    assert.equal(held.holder.origin, origin)
  } finally {
    fs.closeSync(lock.fd)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('inspectSingletonLock reports unheld after the daemon lock fd closes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-singleton-lock-'))
  const lockPath = path.join(dir, 'fleet-daemon.lock')
  const lock = acquireSingletonLock({ lockPath, installPath: '/tmp/daemon-a.mjs' })
  assert.equal(lock.ok, true)
  fs.closeSync(lock.fd)

  try {
    const unheld = inspectSingletonLock({ lockPath })
    assert.equal(unheld.held, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('inspectSingletonLock treats a stale holder record as unheld', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-singleton-lock-'))
  const lockPath = path.join(dir, 'fleet-daemon.lock')
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999999, installPath: '/tmp/dead-daemon.mjs' }))

  try {
    const stale = inspectSingletonLock({ lockPath })
    assert.equal(stale.held, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('inspectSingletonLock treats a corrupt unheld lock record as unheld', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-singleton-lock-'))
  const lockPath = path.join(dir, 'fleet-daemon.lock')
  fs.writeFileSync(lockPath, '{not-json')

  try {
    const corrupt = inspectSingletonLock({ lockPath })
    assert.equal(corrupt.held, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
