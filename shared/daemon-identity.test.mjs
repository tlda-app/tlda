// The isolation guard refuses a worktree daemon that would join the live fleet
// as the shared machine_id. The deploy hook materialises every release with
// `git worktree add --detach`, so the sanctioned runtime tree is a worktree too —
// and on 2026-09-20 that guard refused the release and crash-looped the daemon,
// taking minting down. A declared runtimeRoot is what separates the two.
//
// The refusing cases are the point of these tests: if they stop failing, the
// guard has been widened into uselessness rather than corrected.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { resolveDaemonIsolation } from './daemon-identity.mjs'

const RELEASE = '/Users/skip/work/deploy/testing-releases/9c69f0c9/bin/fleet-daemon.mjs'
const RELEASE_ROOT = '/Users/skip/work/deploy/testing-releases/9c69f0c9'
const RIG = '/Users/skip/work/tlda/.worktrees/my-rig/bin/fleet-daemon.mjs'

// Paths here do not exist on disk, so the realpath calls fall back to resolve().
// That is the comparison being tested: declared root vs where the script sits.
const asWorktree = () => ({ isWorktree: true })

test('a worktree inside the declared runtimeRoot may start', () => {
  const { refuseReason, isolated } = resolveDaemonIsolation({
    env: {},
    scriptPath: RELEASE,
    declaredRuntimeRoot: RELEASE_ROOT,
    resolveIdentity: asWorktree,
  })
  assert.equal(refuseReason, null)
  assert.equal(isolated, true)
})

test('a worktree with NO declared runtimeRoot is still refused', () => {
  const { refuseReason } = resolveDaemonIsolation({
    env: {},
    scriptPath: RIG,
    declaredRuntimeRoot: null,
    resolveIdentity: asWorktree,
  })
  assert.match(String(refuseReason), /running from a git worktree/)
})

test('a worktree OUTSIDE the declared runtimeRoot is still refused', () => {
  // The dev-rig case that the guard exists for, on a box that has since
  // declared a runtime root. Declaring one must not bless every worktree.
  const { refuseReason } = resolveDaemonIsolation({
    env: {},
    scriptPath: RIG,
    declaredRuntimeRoot: RELEASE_ROOT,
    resolveIdentity: asWorktree,
  })
  assert.match(String(refuseReason), /running from a git worktree/)
})

test('a prefix that is not a path boundary does not count as inside', () => {
  // /a/b-evil must not be treated as inside /a/b.
  const { refuseReason } = resolveDaemonIsolation({
    env: {},
    scriptPath: `${RELEASE_ROOT}-evil/bin/fleet-daemon.mjs`,
    declaredRuntimeRoot: RELEASE_ROOT,
    resolveIdentity: asWorktree,
  })
  assert.match(String(refuseReason), /running from a git worktree/)
})

test('config dir without projects dir is still refused, declared or not', () => {
  const { refuseReason } = resolveDaemonIsolation({
    env: { TLDA_DAEMON_CONFIG_DIR: '/tmp/cfg' },
    scriptPath: RELEASE,
    declaredRuntimeRoot: RELEASE_ROOT,
    resolveIdentity: asWorktree,
  })
  assert.match(String(refuseReason), /no PROJECTS_DIR/)
})

test('a non-worktree daemon is unaffected', () => {
  const { refuseReason } = resolveDaemonIsolation({
    env: {},
    scriptPath: '/Users/skip/work/tlda/bin/fleet-daemon.mjs',
    declaredRuntimeRoot: null,
    resolveIdentity: () => ({ isWorktree: false }),
  })
  assert.equal(refuseReason, null)
})
