// `getRuntimeRoot` called `resolveRuntimeRootForEnv` and never imported it, so the
// ReferenceError hit a bare `catch` and every caller was told `declared: false` no
// matter what daemon.yaml said. The runtimeRoot guard therefore could never engage
// for anyone, and the failure was invisible because "not declared" is a legitimate
// answer on a fresh install.
//
// That cost a day of misdiagnosis and an outage: a daemon started from a deploy
// release was refused as an unblessed worktree because the declaration that would
// have blessed it was never seen.
//
// This runs in a subprocess because CONFIG_DIR is read once at module load.

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const SHARED = fileURLToPath(new URL('.', import.meta.url))

function runtimeRootFor(yaml, envName) {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-runtime-root-'))
  writeFileSync(join(dir, 'daemon.yaml'), yaml)
  const out = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { getRuntimeRoot } from ${JSON.stringify(join(SHARED, 'config.mjs'))}
       process.stdout.write(JSON.stringify(getRuntimeRoot(${JSON.stringify(envName)}, '/FALLBACK')))`,
    ],
    { env: { ...process.env, TLDA_CONFIG_DIR: dir }, encoding: 'utf8' },
  )
  return JSON.parse(out)
}

const WITH_ROOT = `environments:
  default: testing
  values:
    testing:
      runtimeRoot: /declared/runtime/root
      database: https://example.invalid
      store: https://example.invalid
      licenseKey: test-license-key
    stable:
      database: https://example.invalid
      store: https://example.invalid
      licenseKey: test-license-key
`

test('a declared runtimeRoot is reported as declared', () => {
  // The regression: this returned { declared: false } for every input.
  const got = runtimeRootFor(WITH_ROOT, 'testing')
  assert.equal(got.declared, true)
  assert.equal(got.runtimeRoot, '/declared/runtime/root')
})

test('an environment with no runtimeRoot falls back, still undeclared', () => {
  const got = runtimeRootFor(WITH_ROOT, 'stable')
  assert.equal(got.declared, false)
  assert.equal(got.runtimeRoot, '/FALLBACK')
})

test('an unknown environment falls back rather than throwing', () => {
  const got = runtimeRootFor(WITH_ROOT, 'no-such-env')
  assert.equal(got.declared, false)
  assert.equal(got.runtimeRoot, '/FALLBACK')
})
