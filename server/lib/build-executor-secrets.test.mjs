/**
 * Where the build executor's two credentials come from.
 *
 * `config/deployments/` is TRACKED and public, so a token written there is a
 * committed credential — `AGENTS.md` forbids it, and the deployment file the
 * `buildExecutor` key lives in says the same thing about itself. The tokens
 * therefore come from the environment, and under `tokensFromEnvironmentOnly`
 * they come from nowhere else.
 *
 * The conflict case is the one worth a test rather than the happy path. Env and
 * config disagreeing is exactly the state where a committed token could silently
 * outrank a deployed one, which reads as configured and behaves as something
 * else — the failure `auth.mjs` shapes its own token resolution to avoid.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildTransportFor } from './build-dispatch.mjs'
import { initProjectStore, closeProjectStore } from './project-store.mjs'

// `buildTransportFor` derives the transport's staging root from the project
// store, which is incidental to credential resolution but must exist for the
// call to complete.
await initProjectStore(mkdtempSync(join(tmpdir(), 'executor-secrets-')))
test.after(async () => { await closeProjectStore() })

const CONFIG_SECRET = 'config-token-that-must-not-win'
const CONFIG_GIT_SECRET = 'config-git-token-that-must-not-win'
const ENV_SECRET = 'env-token-that-must-win'
const ENV_GIT_SECRET = 'env-git-token-that-must-win'

function withEnv(values, run) {
  const saved = {}
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try { return run() } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

// The transport is built from the resolved values, so what it was GIVEN is the
// observable. Capturing the console too: a warning about an ignored token must
// name the field and never carry the value.
function transportFor(config, env) {
  const logs = []
  const realLog = console.log
  const realWarn = console.warn
  console.log = (...a) => logs.push(a.join(' '))
  console.warn = (...a) => logs.push(a.join(' '))
  // A spy factory rather than a property on the transport: what it was HANDED is
  // the thing under test, and a real transport exposing its own credential would
  // be a worse system than the one this test is defending.
  let given = null
  const spy = options => { given = options; return { spied: true } }
  try {
    withEnv(env, () => buildTransportFor(config, spy))
    return { given, logs }
  } finally {
    console.log = realLog
    console.warn = realWarn
  }
}

const executorConfig = (extra = {}) => ({
  buildExecutor: {
    url: 'ws://executor.example:7711',
    token: CONFIG_SECRET,
    git: { url: 'https://server.example/git', daemonId: 'daemon-1', token: CONFIG_GIT_SECRET },
  },
  ...extra,
})

test('under tokensFromEnvironmentOnly the ENV tokens are what the transport gets', () => {
  const { given } = transportFor(
    executorConfig({ tokensFromEnvironmentOnly: true }),
    { TLDA_BUILD_EXECUTOR_TOKEN: ENV_SECRET, TLDA_BUILD_EXECUTOR_GIT_TOKEN: ENV_GIT_SECRET },
  )
  assert.equal(given?.token, ENV_SECRET, 'the config token outranked the deployed one')
  assert.equal(given?.git?.token, ENV_GIT_SECRET, 'the config git token outranked the deployed one')
})

// The half that makes the test above mean something. Without this, "env wins"
// could be true because config is never read at all, which is a different
// system from the one described.
test('without the flag a config token is still honoured, so the flag is what decides', () => {
  const { given } = transportFor(
    executorConfig(),
    { TLDA_BUILD_EXECUTOR_TOKEN: undefined, TLDA_BUILD_EXECUTOR_GIT_TOKEN: undefined },
  )
  assert.equal(given?.token, CONFIG_SECRET)
  assert.equal(given?.git?.token, CONFIG_GIT_SECRET)
})

test('under the flag with NO env token, the config token is refused rather than used', () => {
  const { given } = transportFor(
    executorConfig({ tokensFromEnvironmentOnly: true }),
    { TLDA_BUILD_EXECUTOR_TOKEN: undefined, TLDA_BUILD_EXECUTOR_GIT_TOKEN: undefined },
  )
  assert.equal(given?.token, null, 'a committed token was used where secrets were declared authoritative')
  assert.equal(given?.git?.token, null)
})

test('an ignored config token is named in the log and its VALUE never is', () => {
  const { logs } = transportFor(
    executorConfig({ tokensFromEnvironmentOnly: true }),
    { TLDA_BUILD_EXECUTOR_TOKEN: ENV_SECRET, TLDA_BUILD_EXECUTOR_GIT_TOKEN: ENV_GIT_SECRET },
  )
  const all = logs.join('\n')
  assert.match(all, /buildExecutor\.token in server\.yaml is ignored/)
  assert.match(all, /buildExecutor\.git\.token in server\.yaml is ignored/)
  for (const secret of [CONFIG_SECRET, CONFIG_GIT_SECRET, ENV_SECRET, ENV_GIT_SECRET]) {
    assert.equal(all.includes(secret), false, `a secret value reached the log: ${secret}`)
  }
})

test('no buildExecutor at all is the fork path, unchanged', () => {
  const { given } = transportFor({}, {})
  assert.equal(given, null, 'the remote transport was built for a deployment that configured none')
})
