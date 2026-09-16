import test from 'node:test'
import assert from 'node:assert/strict'

import { validateStrictEnvironments } from './daemon-config-schema.mjs'
import { checkRuntimeRoot, readCheckoutSha, resolveRuntimeRootForEnv, runtimeRootsMatch, runtimeStampLine, RUNTIME_STAMP_TOKEN } from './runtime-root.mjs'

const BASE = {
  default: 'testing',
  values: {
    testing: {
      database: 'https://tlda-fly.example.net',
      store: 'https://tlda-fly.example.net',
      licenseKey: '',
    },
    stable: {
      database: 'https://tlda-fly-stable.example.net',
      store: 'https://tlda-fly-stable.example.net',
      licenseKey: '',
    },
  },
}

const withRoot = (env, root) => {
  const next = structuredClone(BASE)
  next.values[env].runtimeRoot = root
  return next
}

test('absent runtimeRoot validates and resolves to the module-location fallback', () => {
  const values = validateStrictEnvironments(structuredClone(BASE))
  assert.equal(values.testing.database, 'https://tlda-fly.example.net')
  const resolved = resolveRuntimeRootForEnv(values, 'testing', '/repo/checkout')
  assert.equal(resolved.runtimeRoot, '/repo/checkout')
  assert.equal(resolved.declared, false)
})

test('explicit absolute runtimeRoot validates and is honored', () => {
  const values = validateStrictEnvironments(withRoot('testing', '/Users/you/worktrees/daemon-testing'))
  const resolved = resolveRuntimeRootForEnv(values, 'testing', '/repo/checkout')
  assert.equal(resolved.runtimeRoot, '/Users/you/worktrees/daemon-testing')
  assert.equal(resolved.declared, true)
})

test('relative runtimeRoot is rejected with the environment named', () => {
  assert.throws(
    () => validateStrictEnvironments(withRoot('testing', 'worktrees/daemon-testing')),
    /testing.*runtimeRoot|runtimeRoot.*testing/,
  )
})

test('empty runtimeRoot is rejected', () => {
  assert.throws(() => validateStrictEnvironments(withRoot('testing', '   ')), /runtimeRoot/)
})

test('non-string runtimeRoot is rejected', () => {
  const cfg = structuredClone(BASE)
  cfg.values.testing.runtimeRoot = 42
  assert.throws(() => validateStrictEnvironments(cfg), /runtimeRoot/)
})

test('unknown per-env keys are still rejected', () => {
  const cfg = structuredClone(BASE)
  cfg.values.testing.runtimeRef = 'main'
  assert.throws(() => validateStrictEnvironments(cfg), /runtimeRef/)
})

test('cross-environment isolation: testing override does not change stable or installed roots', () => {
  const values = validateStrictEnvironments(withRoot('testing', '/Users/you/worktrees/daemon-testing'))
  const testing = resolveRuntimeRootForEnv(values, 'testing', '/repo/checkout')
  const stable = resolveRuntimeRootForEnv(values, 'stable', '/installed/package')
  assert.equal(testing.runtimeRoot, '/Users/you/worktrees/daemon-testing')
  assert.equal(testing.declared, true)
  assert.equal(stable.runtimeRoot, '/installed/package')
  assert.equal(stable.declared, false)
})

test('unknown environment name throws', () => {
  const values = validateStrictEnvironments(structuredClone(BASE))
  assert.throws(() => resolveRuntimeRootForEnv(values, 'pic', '/repo/checkout'), /pic/)
})

test('runtimeRootsMatch compares by real path, tolerating missing paths', () => {
  assert.equal(runtimeRootsMatch('/a/b', '/a/b'), true)
  assert.equal(runtimeRootsMatch('/a/b', '/a/c'), false)
  assert.equal(runtimeRootsMatch('/tmp', '/tmp/'), true)
})

test('runtime stamp line carries the token, full sha, root, and env', () => {
  const line = runtimeStampLine({ sha: '7fe121ef3015820a6f6d68b90e2e96e7c1cf14c7', root: '/r', env: 'testing' })
  assert.ok(line.startsWith(`${RUNTIME_STAMP_TOKEN} `))
  assert.ok(line.includes('sha=7fe121ef3015820a6f6d68b90e2e96e7c1cf14c7'))
  assert.ok(line.includes('root=/r'))
  assert.ok(line.includes('env=testing'))
})

test('checkRuntimeRoot passes when undeclared (installed boxes keep standing behavior)', () => {
  assert.equal(checkRuntimeRoot({ declared: false, configuredRoot: null, actualRoot: '/installed/pkg' }).ok, true)
})

test('checkRuntimeRoot passes when loaded from the declared root', () => {
  assert.equal(checkRuntimeRoot({ declared: true, configuredRoot: '/tmp', actualRoot: '/tmp/' }).ok, true)
})

test('checkRuntimeRoot refuses a declared root loaded from anywhere else', () => {
  const verdict = checkRuntimeRoot({ declared: true, configuredRoot: '/managed/runtime', actualRoot: '/stray/worktree' })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.message.includes('/managed/runtime'))
  assert.ok(verdict.message.includes('/stray/worktree'))
})

test('readCheckoutSha reads HEAD of a git checkout and reports unknown elsewhere', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const here = readCheckoutSha(new URL('.', import.meta.url).pathname)
  assert.match(here, /^[0-9a-f]{40}$/)
  const empty = mkdtempSync(join(tmpdir(), 'rt-root-'))
  assert.equal(readCheckoutSha(empty), 'unknown')
})
