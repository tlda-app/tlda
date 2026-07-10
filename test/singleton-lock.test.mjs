import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { isPidfileHolderCurrent } from '../agent-runtime/singleton-lock.mjs'

test('pidfile fallback rejects stale holder from a previous boot', () => {
  const holder = {
    pid: process.pid,
    bootId: 'old-boot',
    processStartTime: '123',
  }
  const alive = isPidfileHolderCurrent(holder, () => ({
    bootId: 'new-boot',
    startTime: '123',
  }))
  assert.equal(alive, false)
})

test('pidfile fallback rejects reused pid with different process start time', () => {
  const holder = {
    pid: process.pid,
    bootId: 'same-boot',
    processStartTime: '123',
  }
  const alive = isPidfileHolderCurrent(holder, () => ({
    bootId: 'same-boot',
    startTime: '456',
  }))
  assert.equal(alive, false)
})

test('pidfile fallback keeps legacy live-holder behavior when identity is absent', () => {
  const holder = { pid: process.pid }
  const alive = isPidfileHolderCurrent(holder, () => ({
    bootId: 'boot',
    startTime: '456',
  }))
  assert.equal(alive, true)
})

test('pidfile fallback rejects legacy lock files from before current Linux boot', { skip: process.platform !== 'linux' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-lock-'))
  const lockPath = path.join(dir, 'fleet-daemon.test.lock')
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid }))
  fs.utimesSync(lockPath, new Date(0), new Date(0))

  const alive = isPidfileHolderCurrent(
    { pid: process.pid },
    () => ({ bootId: 'boot', startTime: '456' }),
    { lockPath },
  )
  assert.equal(alive, false)
})
