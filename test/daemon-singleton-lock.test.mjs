// INVARIANT TEST: at most ONE fleet-daemon process per machine, ever.
//
// A second daemon launched from ANY install/worktree must be REFUSED UP FRONT
// (before opening any WS to the server), not evicted later. We prove this at the
// lock layer the daemon uses: bin/lib/singleton-lock.mjs. The harness
// (test/fixtures/singleton-lock-harness.mjs) acquires the lock the EXACT same way
// the daemon does at startup.
//
// Isolation: every test uses a throwaway lock path under os.tmpdir(), so it never
// touches the live daemon's ~/.config/tlda/fleet-daemon.lock (pid 4494).

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const HARNESS = path.join(__dirname, 'fixtures', 'singleton-lock-harness.mjs')

function tmpLock() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-singleton-'))
  return path.join(dir, 'fleet-daemon.lock')
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

test('second daemon from a different install path is REFUSED while the first holds the lock', async () => {
  const lockPath = tmpLock()

  // First daemon: a real long-lived process holding the lock, launched as if
  // from one worktree's install path, with that worktree as cwd.
  const installA = '/Users/skip/work/tlda/bin/fleet-daemon.mjs'
  let firstOut = ''
  const first = spawn(process.execPath, [HARNESS, 'hold', lockPath, installA], {
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
    const second = spawnSync(process.execPath, [HARNESS, 'try', lockPath, installB], {
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
    assert.equal(first.exitCode, null, 'first daemon must still be alive after the refusal')
    assert.equal(first.killed, false)
  } finally {
    first.kill('SIGKILL')
  }

  // After the holder dies, the kernel releases the lock → a fresh daemon can
  // reclaim it (no manual stale-pid cleanup). Proves there's no permanent wedge.
  await waitFor(() => first.exitCode !== null || first.signalCode !== null)
  const reclaim = spawnSync(process.execPath, [HARNESS, 'try', lockPath, installA], {
    encoding: 'utf8', timeout: 5000,
  })
  assert.equal(reclaim.status, 0, 'a fresh daemon reclaims the lock after the holder dies')
  assert.match(reclaim.stdout, /ACQUIRED \d+/)
})

test('lock is the SAME fixed path regardless of which install runs — install-path-agnostic', async () => {
  // Two "installs" with different cwds and different installPath labels still
  // contend for the one lockPath we hand them (the daemon derives it from
  // CONFIG_DIR, not __dirname), so the second is refused.
  const lockPath = tmpLock()
  let out = ''
  const holder = spawn(process.execPath, [HARNESS, 'hold', lockPath, '/install/one/bin/fleet-daemon.mjs'], {
    cwd: '/tmp', stdio: ['ignore', 'pipe', 'pipe'],
  })
  holder.stdout.on('data', (d) => { out += d.toString() })
  try {
    await waitFor(() => out.includes('ACQUIRED'))
    const other = spawnSync(process.execPath, [HARNESS, 'try', lockPath, '/totally/other/install/bin/fleet-daemon.mjs'], {
      cwd: os.homedir(), encoding: 'utf8', timeout: 5000,
    })
    assert.notEqual(other.status, 0)
    assert.match(other.stderr, /REFUSED/)
  } finally {
    holder.kill('SIGKILL')
  }
})
