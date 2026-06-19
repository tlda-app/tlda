import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isWorktreePath,
  resolveDaemonIsolation,
  daemonHelloDecision,
} from '../shared/daemon-identity.mjs'

test('isWorktreePath detects worktree daemon paths', () => {
  assert.equal(isWorktreePath('/Users/skip/work/tlda/.worktrees/activity-fallback/bin/fleet-daemon.mjs'), true)
  assert.equal(isWorktreePath('/Users/skip/.claude/worktrees/foo/bin/fleet-daemon.mjs'), true)
  assert.equal(isWorktreePath('/Users/skip/work/tlda/bin/fleet-daemon.mjs'), false)
  assert.equal(isWorktreePath(''), false)
})

test('resolveDaemonIsolation: main-tree daemon with no overrides starts clean', () => {
  const r = resolveDaemonIsolation({ env: {}, scriptPath: '/Users/skip/work/tlda/bin/fleet-daemon.mjs' })
  assert.equal(r.refuseReason, null)
  assert.equal(r.usingCustomConfigDir, false)
})

test('resolveDaemonIsolation: worktree rig with a custom config dir starts clean (isolated)', () => {
  const r = resolveDaemonIsolation({
    env: { TLDA_DAEMON_CONFIG_DIR: '/tmp/rig-cfg' },
    scriptPath: '/Users/skip/work/tlda/.worktrees/rig/bin/fleet-daemon.mjs',
  })
  assert.equal(r.refuseReason, null)
  assert.equal(r.isolated, true)
})

test('resolveDaemonIsolation: worktree rig with TLDA_SERVER alone starts clean (server-isolated)', () => {
  // TLDA_SERVER is now honored as an isolation signal — the daemon targets that
  // server, never the live Fly instance. (This is exactly what the RPC test does.)
  const r = resolveDaemonIsolation({
    env: { TLDA_SERVER: 'http://localhost:5599' },
    scriptPath: '/Users/skip/work/tlda/.worktrees/rig/bin/fleet-daemon.mjs',
  })
  assert.equal(r.refuseReason, null)
  assert.equal(r.isolated, true)
})

test('resolveDaemonIsolation: worktree daemon with NEITHER signal is refused (the rogue leak)', () => {
  const r = resolveDaemonIsolation({
    env: {},
    scriptPath: '/Users/skip/work/tlda/.worktrees/activity-fallback/bin/fleet-daemon.mjs',
  })
  assert.match(r.refuseReason, /worktree/)
  assert.equal(r.isolated, false)
})

test('daemonHelloDecision: empty slot accepts', () => {
  assert.equal(daemonHelloDecision({ existing: null, incoming: { bootId: 5, installPath: '/a' } }), 'accept')
})

test('daemonHelloDecision: existing connection closed → accept', () => {
  assert.equal(
    daemonHelloDecision({ existing: { open: false, bootId: 5, installPath: '/a' }, incoming: { bootId: 6, installPath: '/b' } }),
    'accept',
  )
})

test('daemonHelloDecision: a DIFFERENT install live on the machine_id is refused (the rogue-worktree case)', () => {
  // The real daemon (older boot) holds `air`; a newer worktree daemon must NOT
  // be able to evict it just by having a larger boot_id.
  assert.equal(
    daemonHelloDecision({
      existing: { open: true, bootId: 1000, installPath: '/Users/skip/work/tlda/bin/fleet-daemon.mjs' },
      incoming: { bootId: 9999, installPath: '/Users/skip/work/tlda/.worktrees/activity-fallback/bin/fleet-daemon.mjs' },
    }),
    'refuse',
  )
})

test('daemonHelloDecision: same install restarting with a newer boot evicts the stale connection', () => {
  assert.equal(
    daemonHelloDecision({
      existing: { open: true, bootId: 1000, installPath: '/Users/skip/work/tlda/bin/fleet-daemon.mjs' },
      incoming: { bootId: 2000, installPath: '/Users/skip/work/tlda/bin/fleet-daemon.mjs' },
    }),
    'evict-existing',
  )
})

test('daemonHelloDecision: same install with an OLDER boot is refused (stale reconnect)', () => {
  assert.equal(
    daemonHelloDecision({
      existing: { open: true, bootId: 2000, installPath: '/x/bin/fleet-daemon.mjs' },
      incoming: { bootId: 1000, installPath: '/x/bin/fleet-daemon.mjs' },
    }),
    'refuse',
  )
})

test('daemonHelloDecision: unknown install_path (un-upgraded daemon) falls back to boot-id newer-wins, not a hard refuse', () => {
  // Transitional: a daemon that does not yet report install_path must still be
  // able to restart over its own stale connection.
  assert.equal(
    daemonHelloDecision({ existing: { open: true, bootId: 1000, installPath: undefined }, incoming: { bootId: 2000, installPath: undefined } }),
    'evict-existing',
  )
})
