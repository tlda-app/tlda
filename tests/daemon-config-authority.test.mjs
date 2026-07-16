import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { harnessKindForAgent } from '../agent-runtime/daemon-guards.mjs'
import { normalizeSpawnModelKwargs, resolveModelSpec, listModels } from '../agent-launch/models.mjs'
import { readDaemonConfig, withDaemonModelAliases } from '../agent-launch/permission-ledger.mjs'
import { createHarnessRuntime } from '../daemon/harness-runtime.mjs'
import { harnessKindFromEnv } from '../mcp-server/lib/harness-adapters.mjs'
import { normalizeRegionPolicy, normalizeSpawnPolicy, resolveSpawnGrant } from '../server/lib/spawn-policy.mjs'

test('model specs use the daemon-declared harness and retain daemon metadata', () => {
  const config = withDaemonModelAliases({}, {
    models: {
      default: 'terra',
      values: {
        terra: {
          id: 'gpt-5.6-terra',
          verified: false,
          harness: { kind: 'codex' },
          group: 'codex',
          level: 3,
          description: 'Codex Terra',
          options: {
            effort: {
              default: 'high',
              values: {
                low: {},
                high: {},
              },
            },
          },
        },
      },
    },
  })

  const spec = resolveModelSpec('terra', { config })
  assert.equal(spec.harness, 'codex')
  assert.equal(spec.verified, false)
  assert.deepEqual(spec.options.effort, { default: 'high', values: { low: {}, high: {} } })
  assert.deepEqual(normalizeSpawnModelKwargs({ model: 'terra' }, { config }).options, { effort: 'high' })
  assert.throws(() => normalizeSpawnModelKwargs({ model: 'terra', effort: 'medium' }, { config }), /invalid model option effort="medium"/)
  assert.deepEqual(listModels(config).models, [{
    alias: 'terra',
    id: 'gpt-5.6-terra',
    verified: false,
    available: true,
    kind: 'codex',
    harness: 'codex',
    provider: 'codex',
    group: 'codex',
    level: 3,
    description: 'Codex Terra',
    tags: [],
    options: { effort: { default: 'high', values: { low: {}, high: {} } } },
    harnessOptions: { required: [], preferences: [], controls: false, options: {} },
  }])
})

test('model resolution refuses a provider-only spec instead of inferring a harness', () => {
  assert.throws(
    () => resolveModelSpec('external', {
      config: { modelSpecs: { external: { alias: 'external', id: 'vendor/model', provider: 'openrouter' } } },
    }),
    /unknown daemon model "external"/,
  )
})

test('daemon YAML models use recursive default/values/options schema', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-daemon-model-schema-'))
  const file = path.join(dir, 'daemon.yaml')
  try {
    fs.writeFileSync(file, 'models:\n  default: terra\n  values:\n    terra:\n      id: gpt-5.6-terra\n      harness:\n        kind: codex\n      group: codex\n      level: 3\n      description: Codex Terra\n      options:\n        effort:\n          default: high\n          values:\n            low: {}\n            high:\n              options:\n                verbosity:\n                  default: short\n                  values:\n                    short: {}\n                    long: {}\n')
    const normalized = withDaemonModelAliases({}, readDaemonConfig(file))
    assert.equal(normalized.modelSpecs.terra.harness, 'codex')
    assert.equal(normalized.modelCatalog.default, 'terra')
    assert.deepEqual(normalizeSpawnModelKwargs({}, { config: normalized }).options, { effort: 'high', verbosity: 'short' })
    assert.deepEqual(
      normalizeSpawnModelKwargs({ model: 'terra', verbosity: 'long' }, { config: normalized }).options,
      { effort: 'high', verbosity: 'long' },
    )
    assert.throws(
      () => normalizeSpawnModelKwargs({ model: 'terra', effort: 'low', verbosity: 'long' }, { config: normalized }),
      /unknown model option\(s\) for "terra": verbosity/,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('daemon YAML rejects legacy grouped and provider-only model rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-daemon-flat-model-schema-'))
  const file = path.join(dir, 'daemon.yaml')
  try {
    fs.writeFileSync(file, 'models:\n  codex:\n    terra: gpt-5.6-terra\n')
    assert.throws(() => withDaemonModelAliases({}, readDaemonConfig(file)), /daemon models must use \{ default, values \}/)

    fs.writeFileSync(file, 'models:\n  external:\n    provider: openrouter\n    id: vendor/model\n')
    const providerOnly = readDaemonConfig(file)
    assert.throws(() => withDaemonModelAliases({}, providerOnly), /daemon models must use \{ default, values \}/)

    fs.writeFileSync(file, 'models:\n  default: external\n  values:\n    external:\n      provider: openrouter\n      id: vendor/model\n')
    assert.throws(() => withDaemonModelAliases({}, readDaemonConfig(file)), /daemon model "external" must specify a harness/)

    fs.writeFileSync(file, 'models:\n  default: external\n  values:\n    external:\n      provider: openrouter\n      id: vendor/model\n      kind: codex\n')
    const normalized = withDaemonModelAliases({}, readDaemonConfig(file))
    assert.equal(normalized.modelSpecs.external.provider, 'openrouter')
    assert.equal(normalized.modelSpecs.external.harness, 'codex')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('harness resolution fails loudly without an explicit recorded harness', async () => {
  assert.throws(() => harnessKindFromEnv({}), /FLEET_HARNESS is required/)
  assert.throws(() => harnessKindForAgent({ id: 'fleet:missing-kind' }), /has no metadata\.kind/)

  const runtime = createHarnessRuntime({ log: { warn() {} } })
  await assert.rejects(runtime.resolveAgentKind({ id: 'fleet:missing-kind' }), /has no metadata\.kind/)
  assert.equal(await runtime.resolveAgentKind({ id: 'fleet:codex', metadata: { kind: 'codex' } }), 'codex')
})

test('policy normalizers reject legacy and missing defaults', () => {
  assert.throws(() => normalizeSpawnPolicy(), /spawn policy is required/)
  assert.throws(() => normalizeSpawnPolicy('write'), /must include a configured permission and region/)
  assert.throws(() => normalizeRegionPolicy('full-access'), /unknown spawn policy region/)
  assert.throws(() => normalizeRegionPolicy('workspace-write'), /unknown spawn policy region/)
  assert.deepEqual(normalizeRegionPolicy({ name: 'ops', policy: 'unsandboxed' }), { name: 'ops', policy: 'unsandboxed' })
})

test('a daemon profile without projectedPolicy derives its region from its configured zones', () => {
  const profile = {
    type: 'permission-set',
    name: 'workspace',
    operations: {
      read: { allow: ['/tmp/work/**'], deny: [] },
      write: { allow: ['/tmp/work/**'], deny: [] },
      spawn: { allow: ['**'], deny: [] },
    },
    rules: [],
    compiledFrom: 'daemon.yaml',
  }
  const spawner = {
    type: 'permission-set',
    name: 'operator',
    operations: {
      read: { allow: ['**'], deny: [] },
      write: { allow: ['**'], deny: [] },
      spawn: { allow: ['**'], deny: [] },
    },
    rules: [],
  }
  const grant = resolveSpawnGrant({
    permissionRequest: 'workspace',
    config: { spawnPolicy: { permissionProfiles: { workspace: profile } } },
    spawnerPermissionSet: spawner,
    cwd: '/tmp/work',
  })
  assert.deepEqual(grant.grantedPolicy, { name: 'cwd', policy: 'cwd' })
})
