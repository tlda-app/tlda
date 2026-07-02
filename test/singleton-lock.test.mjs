import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { acquireSingletonLock, inspectSingletonLock } from '../bin/lib/singleton-lock.mjs'

test('inspectSingletonLock reports held while a daemon lock fd is open', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-singleton-lock-'))
  const lockPath = path.join(dir, 'fleet-daemon.lock')
  const installPath = '/tmp/tlda/bin/fleet-daemon.mjs'
  const lock = acquireSingletonLock({ lockPath, installPath })
  assert.equal(lock.ok, true)

  try {
    const held = inspectSingletonLock({ lockPath })
    assert.equal(held.held, true)
    assert.equal(held.holder.pid, process.pid)
    assert.equal(held.holder.installPath, installPath)
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
