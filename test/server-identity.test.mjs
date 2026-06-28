import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveServerIsolation } from '../shared/server-identity.mjs'

const WORKTREE_SERVER = '/Users/skip/work/tlda/.worktrees/branch/server/unified-server.mjs'
const MAIN_SERVER = '/Users/skip/work/tlda/server/unified-server.mjs'
const TMP_WORKTREE_SERVER = '/tmp/tlda-rl-prod-identity/server/unified-server.mjs'

test('main checkout server can start without dev isolation env', () => {
  const r = resolveServerIsolation({ env: {}, scriptPath: MAIN_SERVER })
  assert.equal(r.refuseReason, null)
  assert.equal(r.isolated, false)
})

test('worktree server without isolation is refused', () => {
  const r = resolveServerIsolation({ env: {}, scriptPath: WORKTREE_SERVER })
  assert.match(r.refuseReason, /worktree server must not start as the prod server/i)
  assert.equal(r.isolated, false)
  assert.equal(r.isWorktree, true)
})

test('real git worktree server without isolation is refused even outside .worktrees path', () => {
  const r = resolveServerIsolation({
    env: {},
    scriptPath: TMP_WORKTREE_SERVER,
    resolveIdentity: () => ({ isWorktree: true }),
  })
  assert.match(r.refuseReason, /worktree server must not start as the prod server/i)
  assert.equal(r.isWorktree, true)
})

test('worktree server with tlda-dev serve signal can start', () => {
  const r = resolveServerIsolation({
    env: {
      TLDA_DEV_SERVER: '1',
      TLDA_CONFIG: 'dev-preview/branch',
      PROJECTS_DIR: '/tmp/projects',
      TLDA_FLEET_DB: '/tmp/fleet.db',
    },
    scriptPath: WORKTREE_SERVER,
  })
  assert.equal(r.refuseReason, null)
  assert.equal(r.devServer, true)
  assert.equal(r.isolated, true)
  assert.equal(r.isWorktree, true)
})

test('worktree server with isolated test data dirs can start', () => {
  const r = resolveServerIsolation({
    env: {
      PROJECTS_DIR: '/tmp/projects',
      TLDA_FLEET_DB: '/tmp/fleet.db',
    },
    scriptPath: WORKTREE_SERVER,
  })
  assert.equal(r.refuseReason, null)
  assert.equal(r.isolatedData, true)
  assert.equal(r.isolated, true)
})

test('TLDA_SERVER alone is not server isolation', () => {
  const r = resolveServerIsolation({
    env: { TLDA_SERVER: 'http://localhost:5599' },
    scriptPath: WORKTREE_SERVER,
  })
  assert.match(r.refuseReason, /no server isolation signal/i)
  assert.equal(r.isolated, false)
})
