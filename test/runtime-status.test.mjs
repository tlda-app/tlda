import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRuntimeStatus, daemonRuntimeStatus, summarizeAgents } from '../server/lib/runtime-status.mjs'
import { formatSystemStatus } from '../cli/lib/system-status.mjs'

test('daemon runtime status reports remote install identity as unavailable, not guessed', () => {
  const daemonConnections = new Map([
    ['remote', {
      readyState: 1,
      _hostname: 'other-host',
      _installPath: '/remote/tlda/bin/fleet-daemon.mjs',
    }],
  ])

  const rows = daemonRuntimeStatus({
    daemonConnections,
    localHostname: 'server-host',
    resolveIdentity: () => {
      throw new Error('must not stat remote daemon path')
    },
  })

  assert.equal(rows.length, 1)
  assert.equal(rows[0].install_path, '/remote/tlda/bin/fleet-daemon.mjs')
  assert.equal(rows[0].identity.available, false)
  assert.match(rows[0].identity.reason, /remote host/)
})

test('daemon runtime status resolves local install identity when stat-able', () => {
  const daemonConnections = new Map([
    ['air', {
      readyState: 1,
      _hostname: 'air.local',
      _installPath: '/Users/skip/work/tlda/bin/fleet-daemon.mjs',
    }],
  ])

  const rows = daemonRuntimeStatus({
    daemonConnections,
    localHostname: 'air.local',
    resolveIdentity: (p) => ({ available: true, checkoutPath: p, gitSha: 'abcdef123456', ref: 'main', dirty: false, isWorktree: false }),
  })

  assert.equal(rows[0].identity.available, true)
  assert.equal(rows[0].identity.gitSha, 'abcdef123456')
})

test('runtime status includes server, deploy stamp, daemon, and fleet roster summary', () => {
  const status = buildRuntimeStatus({
    env: { TLDA_CONFIG: 'dev-preview/foo', TLDA_DEV_SERVER: '1', TLDA_FLEET_DB: '/tmp/fleet.db' },
    serverScriptPath: '/repo/server/unified-server.mjs',
    fleetStore: { db: { name: '/tmp/fleet.db' } },
    buildInfo: { gitSha: '1234567890abcdef', ref: 'main', branch: 'main', dirty: false, builtAt: '2026-06-28T12:00:00.000Z' },
    agents: [
      { id: 'fleet:a', friendly_name: 'a', machine_id: 'air', dead: false },
      { id: 'fleet:b', friendly_name: 'b', machine_id: 'mini', dead: true },
    ],
    daemonConnections: new Map(),
    resolveIdentity: () => ({ available: true, gitSha: 'fedcba987654', ref: 'main', dirty: false, isWorktree: false }),
  })

  assert.equal(status.server.mode, 'test')
  assert.equal(status.server.config, 'dev-preview/foo')
  assert.equal(status.deploy.gitSha, '1234567890abcdef')
  assert.equal(status.fleet.live, 1)
  assert.deepEqual(status.fleet.byMachine, { air: 1 })
})

test('summarizeAgents keeps compact live roster and counts by machine', () => {
  const summary = summarizeAgents([
    { id: 'fleet:a', friendly_name: 'a', machine_id: 'air', dead: false, cwd: '/a' },
    { id: 'fleet:b', friendly_name: 'b', machine_id: 'air', dead: false },
    { id: 'fleet:c', friendly_name: 'c', machine_id: 'mini', dead: true },
  ])

  assert.equal(summary.total, 3)
  assert.equal(summary.live, 2)
  assert.deepEqual(summary.byMachine, { air: 2 })
  assert.equal(summary.agents.length, 2)
})

test('formatSystemStatus prints compact endpoint output', () => {
  const text = formatSystemStatus({
    server: {
      mode: 'prod',
      config: 'default',
      fleet_db: '/db/fleet.db',
      identity: { available: true, gitSha: 'abcdef1234567890', ref: 'main', dirty: false, isWorktree: false },
    },
    deploy: { gitSha: '1234567890abcdef', ref: 'main', dirty: false, builtAt: '2026-06-28T12:00:00.000Z' },
    daemon: [
      {
        machine_id: 'air',
        connected: true,
        install_path: '/repo/bin/fleet-daemon.mjs',
        identity: { available: false, reason: 'daemon is on a remote host' },
      },
    ],
    fleet: { live: 2, total: 3, byMachine: { air: 2 } },
  })

  assert.match(text, /System status/)
  assert.match(text, /Server: prod config=default/)
  assert.match(text, /Deploy stamp: 1234567890ab main clean/)
  assert.match(text, /air: connected/)
  assert.match(text, /unavailable \(daemon is on a remote host\)/)
  assert.match(text, /Agents: 2 live \/ 3 total/)
})
