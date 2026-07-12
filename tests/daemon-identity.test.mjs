import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveDaemonIsolation, resolveMainDaemonScript } from '../shared/daemon-identity.mjs'

test('custom daemon config dir requires isolated JSONL projects dir', () => {
  const decision = resolveDaemonIsolation({
    env: { TLDA_DAEMON_CONFIG_DIR: '/tmp/tlda-daemon-cfg' },
    scriptPath: '/Users/skip/work/tlda/bin/fleet-daemon.mjs',
    resolveIdentity: () => ({ isWorktree: false }),
  })

  assert.match(decision.refuseReason, /TLDA_DAEMON_CONFIG_DIR but no PROJECTS_DIR/)
})

test('custom daemon config dir plus projects dir is isolated', () => {
  const decision = resolveDaemonIsolation({
    env: {
      TLDA_DAEMON_CONFIG_DIR: '/tmp/tlda-daemon-cfg',
      PROJECTS_DIR: '/tmp/tlda-projects',
    },
    scriptPath: '/Users/skip/work/tlda/bin/fleet-daemon.mjs',
    resolveIdentity: () => ({ isWorktree: false }),
  })

  assert.equal(decision.refuseReason, null)
  assert.equal(decision.isolated, true)
})

test('linked worktree daemon without isolation is refused by repo identity', () => {
  const decision = resolveDaemonIsolation({
    env: {},
    scriptPath: '/Users/skip/work/tlda-chat-css-selectors/bin/fleet-daemon.mjs',
    resolveIdentity: () => ({ isWorktree: true }),
  })

  assert.match(decision.refuseReason, /git worktree/)
})

test('server supervisor resolves linked worktree daemon script to main checkout', () => {
  const script = resolveMainDaemonScript(
    '/Users/skip/work/tlda-chat-css-selectors/server/unified-server.mjs',
    () => ({
      isWorktree: true,
      checkoutPath: '/Users/skip/work/tlda-chat-css-selectors',
      mainCheckoutPath: '/Users/skip/work/tlda',
    }),
  )

  assert.equal(script, '/Users/skip/work/tlda/bin/fleet-daemon.mjs')
})

test('main daemon script resolution preserves spaces in checkout path', () => {
  const script = resolveMainDaemonScript(
    '/Users/skip/work/tlda-chat-css-selectors/server/unified-server.mjs',
    () => ({
      isWorktree: true,
      checkoutPath: '/Users/skip/work/tlda-chat-css-selectors',
      mainCheckoutPath: '/Users/skip/work/tlda with spaces',
    }),
  )

  assert.equal(script, '/Users/skip/work/tlda with spaces/bin/fleet-daemon.mjs')
})
