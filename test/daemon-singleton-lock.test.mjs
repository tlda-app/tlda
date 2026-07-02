// INVARIANT TEST: at most ONE fleet-daemon process per active-config origin.
//
// A second daemon launched from ANY install/worktree must be REFUSED UP FRONT
// when it targets the same origin (before opening any WS to the server), not
// evicted later. A daemon for a different origin must be allowed to run in
// parallel. We prove this at the lock layer the daemon uses:
// bin/lib/singleton-lock.mjs. The harness
// (test/fixtures/singleton-lock-harness.mjs) acquires the lock the EXACT same way
// the daemon does at startup.
//
// Isolation: every test uses a throwaway lock path under os.tmpdir(), so it never
// touches the live daemon's origin-keyed lock under ~/.config/tlda.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { daemonSingletonLockPath } from '../bin/lib/singleton-lock.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const HARNESS = path.join(__dirname, 'fixtures', 'singleton-lock-harness.mjs')

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-singleton-'))
  return dir
}

function waitFor(predicate, timeoutMs = 4000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve()
      if (Date.now() > deadline) return reject(new Error('timeout waiting for condition'))
      setTimeout(tick, stepMs)
    }
    tick()
  })
}

test('second daemon for the same origin is REFUSED while the first holds the origin lock', async () => {
  const dir = tmpDir()
  const origin = 'https://fleet-a.example.test:5176'
  const lockPath = daemonSingletonLockPath({ configDir: dir, origin })

  // First daemon: a real long-lived process holding the lock, launched as if
  // from one worktree's install path, with that worktree as cwd.
  const installA = '/Users/skip/work/tlda/bin/fleet-daemon.mjs'
  let firstOut = ''
  const first = spawn(process.execPath, [HARNESS, 'hold', lockPath, installA, origin], {
    cwd: os.homedir(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  first.stdout.on('data', (d) => { firstOut += d.toString() })

  try {
    await waitFor(() => firstOut.includes('ACQUIRED'))
    assert.match(firstOut, /ACQUIRED \d+/, 'first daemon should acquire the lock')

    // Second daemon: a DIFFERENT install path AND a different cwd. It must be
    // refused synchronously — non-zero exit, clear holder-naming message.
    const installB = '/Users/skip/work/tlda/.worktrees/spawn-node-lib/bin/fleet-daemon.mjs'
    const second = spawnSync(process.execPath, [HARNESS, 'try', lockPath, installB, `${origin}/docs/bregman`], {
      cwd: path.dirname(lockPath),
      encoding: 'utf8',
      timeout: 5000,
    })

    assert.notEqual(second.status, 0, 'second daemon must exit non-zero (refused)')
    assert.match(second.stderr, /REFUSED holder pid=\d+/, 'refusal must name the holder pid')
    assert.match(second.stderr, new RegExp(`install=${installA.replace(/[/.]/g, '\\$&')}`),
      'refusal must name the holder install path')
    assert.doesNotMatch(second.stdout, /ACQUIRED/, 'second must NOT acquire')

    // The first daemon SURVIVES — the refusal must not have disturbed it.
    assert.equal(first.exitCode, null, 'first daemon must still be alive after the same-origin refusal')
    assert.equal(first.killed, false)
  } finally {
    first.kill('SIGKILL')
  }

  // After the holder dies, the kernel releases the lock → a fresh daemon can
  // reclaim it (no manual stale-pid cleanup). Proves there's no permanent wedge.
  await waitFor(() => first.exitCode !== null || first.signalCode !== null)
  const reclaim = spawnSync(process.execPath, [HARNESS, 'try', lockPath, installA, origin], {
    encoding: 'utf8', timeout: 5000,
  })
  assert.equal(reclaim.status, 0, 'a fresh daemon reclaims the lock after the holder dies')
  assert.match(reclaim.stdout, /ACQUIRED \d+/)
})

test('same-origin lock is install-path-agnostic', async () => {
  // Two "installs" with different cwds and different installPath labels still
  // contend for the origin-keyed lockPath (the daemon derives it from CONFIG_DIR
  // + SERVER origin, not __dirname), so the second is refused.
  const dir = tmpDir()
  const origin = 'https://fleet-a.example.test:5176'
  const lockPath = daemonSingletonLockPath({ configDir: dir, origin })
  let out = ''
  const holder = spawn(process.execPath, [HARNESS, 'hold', lockPath, '/install/one/bin/fleet-daemon.mjs', origin], {
    cwd: '/tmp', stdio: ['ignore', 'pipe', 'pipe'],
  })
  holder.stdout.on('data', (d) => { out += d.toString() })
  try {
    await waitFor(() => out.includes('ACQUIRED'))
    const other = spawnSync(process.execPath, [HARNESS, 'try', lockPath, '/totally/other/install/bin/fleet-daemon.mjs', origin], {
      cwd: os.homedir(), encoding: 'utf8', timeout: 5000,
    })
    assert.notEqual(other.status, 0)
    assert.match(other.stderr, /REFUSED/)
  } finally {
    holder.kill('SIGKILL')
  }
})

test('daemons for different origins can hold independent locks concurrently', async () => {
  const dir = tmpDir()
  const originA = 'https://fleet-a.example.test:5176'
  const originB = 'https://fleet-b.example.test:5176'
  const lockA = daemonSingletonLockPath({ configDir: dir, origin: originA })
  const lockB = daemonSingletonLockPath({ configDir: dir, origin: originB })
  assert.notEqual(lockA, lockB)

  let out = ''
  const holder = spawn(process.execPath, [HARNESS, 'hold', lockA, '/install/one/bin/fleet-daemon.mjs', originA], {
    cwd: '/tmp', stdio: ['ignore', 'pipe', 'pipe'],
  })
  holder.stdout.on('data', (d) => { out += d.toString() })
  try {
    await waitFor(() => out.includes('ACQUIRED'))
    const other = spawnSync(process.execPath, [HARNESS, 'try', lockB, '/install/two/bin/fleet-daemon.mjs', originB], {
      cwd: os.homedir(), encoding: 'utf8', timeout: 5000,
    })
    assert.equal(other.status, 0)
    assert.match(other.stdout, /ACQUIRED \d+/)
  } finally {
    holder.kill('SIGKILL')
  }
})
