import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { normalizeSpawnModelKwargs, resolveLaunchModelSpec } from './models.mjs'
import * as claude from './harness/claude.mjs'

// Live regression (2026-09-17): the `opus` alias declares
// `options.effort.default: medium`, but a mint naming only the alias launched
// `claude-opus-5` with no `--effort`, so Claude inherited xhigh. The alias
// default must reach the harness command with no explicit effort in the call.
const OPUS_CONFIG = {
  modelSpecs: {
    opus: {
      alias: 'opus',
      id: 'claude-opus-5',
      harness: 'claude',
      options: {
        effort: { default: 'medium', values: { low: {}, medium: {}, high: {} } },
      },
    },
  },
  modelCatalog: { default: 'opus', values: {} },
}

function launchEffort({ model = 'opus', effort = undefined } = {}) {
  const spec = resolveLaunchModelSpec(model, { config: OPUS_CONFIG })
  return effort ?? spec.normalizedOptions?.effort ?? null
}

test('alias normalize fills the configured effort default', () => {
  const normalized = normalizeSpawnModelKwargs({ model: 'opus' }, { config: OPUS_CONFIG })
  assert.equal(normalized.options.effort, 'medium')
})

test('launch helper resolves the alias default when nothing is explicit', () => {
  assert.equal(launchEffort({}), 'medium')
})

test('launch helper emits --effort medium on the claude command', () => {
  const cmd = claude.buildCmd({
    cwd: '/tmp',
    fleetId: 'fleet:test',
    localAgentId: 'test',
    tmuxSession: 'fleet-test',
    model: 'claude-opus-5',
    name: 'test',
    effort: launchEffort({}),
  })
  assert.match(cmd, /--effort 'medium'/)
})

test('an explicit effort still wins over the alias default', () => {
  assert.equal(launchEffort({ effort: 'low' }), 'low')
})

test('a model with no options resolves a null launch effort', () => {
  const spec = resolveLaunchModelSpec('opus', {
    config: {
      modelSpecs: { opus: { alias: 'opus', id: 'claude-opus-5', harness: 'claude' } },
    },
  })
  assert.equal(undefined ?? spec.normalizedOptions?.effort ?? null, null)
})

// Scoped exception, stated plainly: `rpcMint` in bin/fleet-daemon.mjs cannot be
// imported in a unit test (module top-level binds the runtime and starts the
// daemon), so no test here exercises the mint call-site. What reverted
// silently once was the call-site wiring — raw `resolveModelSpec` plus
// `effort: params.effort` — so the minimum that catches that revert is a
// structural read of the two wires this file exists to protect.
test('rpcMint keeps the launch-model wiring (revert of bin/fleet-daemon.mjs fails this)', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const daemon = readFileSync(join(here, '..', 'bin', 'fleet-daemon.mjs'), 'utf8')
  assert.match(daemon, /: resolveLaunchModelSpec\(params\.model,/)
  assert.match(daemon, /effort: params\.effort \?\? modelSpec\.normalizedOptions\?\.effort \?\? null,/)
})
