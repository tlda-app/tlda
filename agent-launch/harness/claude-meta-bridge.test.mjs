import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCmd, resolveModelSelection } from './claude.mjs'
import { readDaemonConfig, withDaemonModelAliases } from '../permission-ledger.mjs'

const META_MODEL = 'muse-spark-1.3-contributor[1m]'
const base = { model: META_MODEL, tmuxSession: 'fleet-test-session', config: {} }

test('meta-routed launch rejects provider credentials in model configuration', () => {
  for (const key of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'META_API_KEY']) {
    assert.throws(
      () => buildCmd({ ...base, harnessOptions: { env: { [key]: 'secret-test-value' } } }),
      /deployment environment/,
    )
  }
})

test('fleet meta-routed launch maps the deployment key and unsets sibling credentials', () => {
  const cmd = buildCmd({
    ...base,
    fleetId: 'fleet:example',
    env: { META_API_KEY: 'deployment-secret', ANTHROPIC_API_KEY: 'stale-operator-key', CLAUDE_CODE_OAUTH_TOKEN: 'stale-oauth' },
  })
  assert.ok(cmd.includes(`ANTHROPIC_AUTH_TOKEN='deployment-secret'`))
  assert.ok(cmd.startsWith('unset ANTHROPIC_API_KEY; unset CLAUDE_CODE_OAUTH_TOKEN; '))
  assert.ok(!cmd.includes('stale-operator-key'))
  assert.ok(!cmd.includes('stale-oauth'))
  assert.ok(cmd.includes(`--model '${META_MODEL}'`))
})

test('fleet meta-routed launch without a deployment key fails loudly instead of falling back', () => {
  assert.throws(
    () => buildCmd({ ...base, fleetId: 'fleet:example', env: {} }),
    /Muse authentication is missing for Claude-routed launch/,
  )
})

test('non-fleet meta-routed launch keeps the operator environment untouched', () => {
  const direct = buildCmd({ ...base, env: {} })
  assert.ok(!direct.includes('ANTHROPIC_AUTH_TOKEN='))
  assert.ok(!direct.startsWith('unset '))
  const keyed = buildCmd({ ...base, env: { META_API_KEY: 'operator-key' } })
  assert.ok(keyed.includes(`ANTHROPIC_AUTH_TOKEN='operator-key'`))
  assert.ok(!keyed.startsWith('unset '))
})

test('anthropic-routed launches behave exactly as before', () => {
  const cmd = buildCmd({
    model: 'opus',
    tmuxSession: 'fleet-test-session',
    fleetId: 'fleet:example',
    config: {},
    env: { ANTHROPIC_API_KEY: 'operator-anthropic-key' },
  })
  assert.ok(!cmd.includes('ANTHROPIC_AUTH_TOKEN='))
  assert.ok(!cmd.startsWith('unset '))
  assert.ok(!cmd.includes('Muse authentication'))
})

test('muse-claude alias resolves to the claude harness with the meta model id', () => {
  const config = withDaemonModelAliases({}, readDaemonConfig(new URL('../../config/daemon.yaml', import.meta.url).pathname))
  const { spec } = resolveModelSelection('muse-claude', { config })
  assert.equal(spec.harness, 'claude')
  assert.equal(spec.id, META_MODEL)
})
