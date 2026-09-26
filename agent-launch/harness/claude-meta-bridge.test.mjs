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

test('fleet launches carry the Playwright MCP server alongside tlda', () => {
  const cmd = buildCmd({
    ...base,
    fleetId: 'fleet:example',
    env: { META_API_KEY: 'deployment-secret' },
  })
  assert.ok(cmd.includes('playwright'))
  assert.ok(cmd.includes('node_modules/@playwright/mcp/cli.js'))
  assert.ok(!cmd.includes('npx'))
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

test('muse-claude alias resolves to Claude through OpenRouter', () => {
  const config = withDaemonModelAliases({}, readDaemonConfig(new URL('./fixtures/daemon-models.yaml', import.meta.url).pathname))
  const { spec } = resolveModelSelection('muse-claude', { config })
  assert.equal(spec.harness, 'claude')
  assert.equal(spec.id, 'meta/muse-spark-1.3-contributor')
  assert.equal(spec.harnessOptions.env.ANTHROPIC_BASE_URL, 'https://openrouter.ai/api')
  assert.equal(spec.options.effort.default, 'max')
  assert.ok(Object.hasOwn(spec.options.effort.values, 'max'))

  const cmd = buildCmd({
    model: spec.id,
    tmuxSession: 'fleet-test-session',
    fleetId: 'fleet:example',
    harnessOptions: spec.harnessOptions,
    env: { OPENROUTER_API_KEY: 'openrouter-deployment-secret', META_API_KEY: 'stale-meta-key' },
  })
  assert.ok(cmd.includes(`ANTHROPIC_AUTH_TOKEN='openrouter-deployment-secret'`))
  assert.ok(cmd.startsWith('unset ANTHROPIC_API_KEY; unset CLAUDE_CODE_OAUTH_TOKEN; unset META_API_KEY; '))
  assert.ok(!cmd.includes('stale-meta-key'))
  assert.ok(cmd.includes(`--model 'meta/muse-spark-1.3-contributor'`))
})

test('fleet muse-claude launch requires the OpenRouter deployment key', () => {
  const config = withDaemonModelAliases({}, readDaemonConfig(new URL('./fixtures/daemon-models.yaml', import.meta.url).pathname))
  const { spec } = resolveModelSelection('muse-claude', { config })
  assert.throws(
    () => buildCmd({ model: spec.id, tmuxSession: 'fleet-test-session', fleetId: 'fleet:example', harnessOptions: spec.harnessOptions, env: { META_API_KEY: 'wrong-provider-key' } }),
    /set OPENROUTER_API_KEY/,
  )
})

test('deepseek alias routes through Claude with the deployment key and max effort', () => {
  const config = withDaemonModelAliases({}, readDaemonConfig(new URL('./fixtures/daemon-models.yaml', import.meta.url).pathname))
  const { spec } = resolveModelSelection('deepseek', { config })
  assert.equal(spec.harness, 'claude')
  assert.equal(spec.id, 'deepseek-flash[1m]')
  assert.equal(spec.options.effort.default, 'max')
  const cmd = buildCmd({
    model: spec.id,
    tmuxSession: 'fleet-test-session',
    fleetId: 'fleet:example',
    harnessOptions: spec.harnessOptions,
    env: { DEEPSEEK_API_KEY: 'deepseek-deployment-secret', META_API_KEY: 'stale-meta-key' },
  })
  assert.ok(cmd.includes(`ANTHROPIC_AUTH_TOKEN='deepseek-deployment-secret'`))
  assert.ok(!cmd.includes('stale-meta-key'))
  assert.ok(cmd.includes(`--model 'deepseek-flash[1m]'`))
})
