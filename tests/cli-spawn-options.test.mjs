import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'

import {
  bindLifecycleCodexResumeIdentity,
  collectSpawnModelOptionsFromRaw,
  resolveWakeRecipeFields,
  runFleetSpawn,
  spawnPositionalFromRaw,
} from '../cli/tlda.mjs'
import { createLocalAgentLedger } from '../agent-launch/local-agent-ledger.mjs'
import { createPermissionLedger } from '../agent-launch/permission-ledger.mjs'

test('CLI spawn forwards recursive model option flags as modelOptions', () => {
  const args = [
    '--fresh',
    '--model', 'terra',
    '--verbosity', 'long',
    '--effort', 'high',
    '--permissions', 'app-dev',
    'helm',
  ]

  assert.equal(spawnPositionalFromRaw(args, 0), 'helm')
  assert.deepEqual(collectSpawnModelOptionsFromRaw(args), {
    verbosity: 'long',
    effort: 'high',
  })
})

test('CLI lifecycle codex spawn binds resume identity into existing ledger row', async () => {
  const result = {
    harness: 'codex',
    fleetId: 'fleet:test-cli-bind',
    tmuxSession: 'fleet-test-cli-bind',
    name: 'test-cli-bind',
  }
  const writes = []
  const resolved = await bindLifecycleCodexResumeIdentity(result, {
    cwd: '/tmp/tlda-cli-bind',
    name: 'test-cli-bind',
    timeoutMs: 0,
    intervalMs: 0,
    ledger: {
      setSessionSync(id, row) {
        writes.push({ id, row })
      },
    },
    resolveIdentity: async ({ agent, tmuxSession }) => {
      assert.equal(agent.id, 'fleet:test-cli-bind')
      assert.equal(agent.friendly_name, 'test-cli-bind')
      assert.equal(agent.cwd, '/tmp/tlda-cli-bind')
      assert.equal(agent.registered_at, undefined)
      assert.equal(tmuxSession, 'fleet-test-cli-bind')
      return {
        sessionId: '11111111-2222-4333-8444-555555555555',
        jsonlPath: '/tmp/rollout-11111111-2222-4333-8444-555555555555.jsonl',
        model: 'gpt-5.5',
      }
    },
  })

  assert.equal(resolved.bound, true)
  assert.equal(result.resumeId, '11111111-2222-4333-8444-555555555555')
  assert.deepEqual(writes, [{
    id: 'fleet:test-cli-bind',
    row: {
      sessionId: '11111111-2222-4333-8444-555555555555',
      sessionKind: 'codex',
      sessionPath: '/tmp/rollout-11111111-2222-4333-8444-555555555555.jsonl',
      tmuxSession: 'fleet-test-cli-bind',
      model: 'gpt-5.5',
      cwd: '/tmp/tlda-cli-bind',
      friendlyName: 'test-cli-bind',
    },
  }])
})

test('CLI lifecycle codex wake treats existing resume id as bound', async () => {
  const result = {
    harness: 'codex',
    fleetId: 'fleet:test-cli-existing-bind',
    tmuxSession: 'fleet-test-cli-existing-bind',
    name: 'test-cli-existing-bind',
    resumeId: '22222222-2222-4333-8444-555555555555',
  }
  const writes = []
  const resolved = await bindLifecycleCodexResumeIdentity(result, {
    cwd: '/tmp/tlda-cli-existing-bind',
    name: 'test-cli-existing-bind',
    ledger: {
      setSessionSync(id, row) {
        writes.push({ id, row })
      },
    },
  })

  assert.equal(resolved.bound, true)
  assert.equal(resolved.existing, true)
  assert.deepEqual(writes, [])
})

function permissionSet(name, writeAllow) {
  return {
    type: 'permission-set',
    name,
    operations: {
      read: { allow: writeAllow, deny: [] },
      write: { allow: writeAllow, deny: [] },
      spawn: { allow: ['**'], deny: [] },
    },
    rules: [],
    projectedPolicy: { policy: writeAllow.includes('**') ? 'unsandboxed' : 'cwd' },
  }
}

function writeDaemonConfig(configDir) {
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, 'daemon.yaml'), `
regions:
  all:
    - "**"
  recipe:
    - "/tmp/tlda-recipe-cwd/**"
profiles:
  ops:
    read:
      allow: [all]
    write:
      allow: [all]
  math:
    read:
      allow: [all]
    write:
      allow: [all]
  wd:
    read:
      allow: [recipe]
    write:
      allow: [recipe]
`)
}

function seedWakeRecipe(dbPath, { profile = 'ops' } = {}) {
  const localLedger = createLocalAgentLedger(dbPath)
  try {
    localLedger.create({
      localAgentId: 'local:recipe',
      serverAgentId: 'fleet:recipe',
      friendlyName: 'recipe',
      harness: 'codex',
      model: 'gpt-5.5',
      tmuxName: 'fleet-recipe',
      cwd: '/tmp/tlda-recipe-cwd',
      permissionProfile: profile,
    })
  } finally {
    localLedger.close()
  }
}

function seedPermissionLedger(dbPath, {
  localhostProfile = 'wd',
  localhostSet = permissionSet('wd', ['/tmp/tlda-recipe-cwd/**']),
  recipeProfile = 'ops',
  recipeSet = permissionSet('ops', ['**']),
} = {}) {
  const ledger = createPermissionLedger(dbPath)
  try {
    ledger.setSync('localhost', {
      spawnPolicy: { policy: 'cwd' },
      permissionProfile: localhostProfile,
      permissionSet: localhostSet,
      source: 'test',
    })
    ledger.setSync('fleet:recipe', {
      spawnPolicy: { policy: 'unsandboxed' },
      permissionProfile: recipeProfile,
      permissionSet: recipeSet,
      source: 'test',
    })
  } finally {
    ledger.close()
  }
}

function rawPermissionGrantRow(dbPath, id) {
  const db = new Database(dbPath)
  try {
    return db.prepare('SELECT * FROM permission_grants WHERE id = ?').get(id)
  } finally {
    db.close()
  }
}

function dbRows(dbPath) {
  const db = new Database(dbPath)
  try {
    return {
      localAgents: db.prepare('SELECT * FROM local_agents ORDER BY local_agent_id').all(),
      conversations: db.prepare('SELECT * FROM local_agent_conversations ORDER BY local_agent_id').all(),
      recipes: db.prepare('SELECT * FROM local_agent_process_recipes ORDER BY local_agent_id').all(),
      grants: db.prepare('SELECT * FROM permission_grants ORDER BY id').all(),
    }
  } finally {
    db.close()
  }
}

test('wake without explicit flags uses durable grant directly without caller clamp', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-wake-direct-grant-'))
  const dbPath = path.join(configDir, 'fleet-daemon.db')
  const spawnCalls = []
  try {
    writeDaemonConfig(configDir)
    seedWakeRecipe(dbPath, { profile: 'ops' })
    seedPermissionLedger(dbPath)
    const beforeGrantRow = rawPermissionGrantRow(dbPath, 'fleet:recipe')

    await runFleetSpawn(['recipe'], {
      configDir,
      localAgentLedgerPath: dbPath,
      loadConfigImpl: () => ({}),
      spawnImpl: async (params) => {
        spawnCalls.push(params)
        return {
          fleetId: 'fleet:recipe',
          tmuxSession: 'fleet-recipe',
          harness: 'codex',
          model: 'gpt-5.5',
          resumeId: '11111111-2222-4333-8444-555555555555',
        }
      },
    })

    assert.equal(spawnCalls.length, 1)
    assert.equal(spawnCalls[0].cwd, '/tmp/tlda-recipe-cwd')
    assert.equal(spawnCalls[0].permissionProfile, 'ops')
    assert.equal(spawnCalls[0].spawnPolicy.policy, 'unsandboxed')
    assert.equal(spawnCalls[0].permissionRequest, undefined)
    assert.equal(spawnCalls[0].explicitPolicy, false)

    const permissionLedger = createPermissionLedger(dbPath)
    const localLedger = createLocalAgentLedger(dbPath)
    try {
      assert.deepEqual(rawPermissionGrantRow(dbPath, 'fleet:recipe'), beforeGrantRow)
      assert.equal(permissionLedger.get('fleet:recipe').permissionProfile, 'ops')
      assert.equal(localLedger.get('fleet:recipe').process.permissionProfile, 'ops')
    } finally {
      permissionLedger.close()
      localLedger.close()
    }
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true })
  }
})

test('wake honors explicit permissions and persists the clamped resolved grant', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-wake-explicit-clamp-'))
  const dbPath = path.join(configDir, 'fleet-daemon.db')
  const spawnCalls = []
  try {
    writeDaemonConfig(configDir)
    seedWakeRecipe(dbPath, { profile: 'ops' })
    seedPermissionLedger(dbPath)

    await runFleetSpawn(['recipe', '--permissions', 'math'], {
      configDir,
      localAgentLedgerPath: dbPath,
      loadConfigImpl: () => ({}),
      spawnImpl: async (params) => {
        spawnCalls.push(params)
        return {
          fleetId: 'fleet:recipe',
          tmuxSession: 'fleet-recipe',
          harness: 'codex',
          model: 'gpt-5.5',
          resumeId: '22222222-2222-4333-8444-555555555555',
        }
      },
    })

    assert.equal(spawnCalls.length, 1)
    assert.equal(spawnCalls[0].permissionProfile, 'wd')
    assert.equal(spawnCalls[0].spawnPolicy.policy, 'cwd')
    assert.equal(spawnCalls[0].permissionRequest, 'math')
    assert.equal(spawnCalls[0].explicitPolicy, true)

    const permissionLedger = createPermissionLedger(dbPath)
    const localLedger = createLocalAgentLedger(dbPath)
    try {
      const grant = permissionLedger.get('fleet:recipe')
      assert.equal(grant.permissionProfile, 'wd')
      assert.equal(grant.spawnPolicy.policy, 'cwd')
      assert.equal(localLedger.get('fleet:recipe').process.permissionProfile, 'wd')
    } finally {
      permissionLedger.close()
      localLedger.close()
    }
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true })
  }
})

test('wake honors explicit permissions and persists the unclamped resolved profile', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-wake-explicit-unclamped-'))
  const dbPath = path.join(configDir, 'fleet-daemon.db')
  const spawnCalls = []
  try {
    writeDaemonConfig(configDir)
    seedWakeRecipe(dbPath, { profile: 'ops' })
    seedPermissionLedger(dbPath, {
      localhostProfile: 'ops',
      localhostSet: permissionSet('ops', ['**']),
    })

    await runFleetSpawn(['recipe', '--permissions', 'wd'], {
      configDir,
      localAgentLedgerPath: dbPath,
      loadConfigImpl: () => ({}),
      spawnImpl: async (params) => {
        spawnCalls.push(params)
        return {
          fleetId: 'fleet:recipe',
          tmuxSession: 'fleet-recipe',
          harness: 'codex',
          model: 'gpt-5.5',
          resumeId: '33333333-2222-4333-8444-555555555555',
        }
      },
    })

    assert.equal(spawnCalls.length, 1)
    assert.equal(spawnCalls[0].permissionProfile, 'wd')
    assert.equal(spawnCalls[0].spawnPolicy.policy, 'cwd')
    assert.equal(spawnCalls[0].permissionRequest, 'wd')
    assert.equal(spawnCalls[0].explicitPolicy, true)

    const permissionLedger = createPermissionLedger(dbPath)
    const localLedger = createLocalAgentLedger(dbPath)
    try {
      const grant = permissionLedger.get('fleet:recipe')
      assert.equal(grant.permissionProfile, 'wd')
      assert.equal(grant.spawnPolicy.policy, 'cwd')
      assert.equal(localLedger.get('fleet:recipe').process.permissionProfile, 'wd')
    } finally {
      permissionLedger.close()
      localLedger.close()
    }
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true })
  }
})

test('wake refuses explicit permissions clamped to anonymous grant with zero DB delta and no runtime', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-wake-explicit-anonymous-clamp-'))
  const dbPath = path.join(configDir, 'fleet-daemon.db')
  const spawnCalls = []
  const errors = []
  const priorExitCode = process.exitCode
  const priorError = console.error
  try {
    writeDaemonConfig(configDir)
    seedWakeRecipe(dbPath, { profile: 'ops' })
    seedPermissionLedger(dbPath, {
      localhostProfile: null,
      localhostSet: permissionSet('anonymous-cwd', ['/tmp/tlda-recipe-cwd/**']),
    })
    const before = dbRows(dbPath)
    console.error = (...args) => { errors.push(args.join(' ')) }
    process.exitCode = undefined

    await runFleetSpawn(['recipe', '--permissions', 'math'], {
      configDir,
      localAgentLedgerPath: dbPath,
      loadConfigImpl: () => ({}),
      spawnImpl: async () => {
        spawnCalls.push(true)
        throw new Error('runtime must not start for anonymous explicit clamp')
      },
    })

    assert.equal(process.exitCode, 1)
    assert.equal(spawnCalls.length, 0)
    assert.match(errors.join('\n'), /anonymous clamped grant|anonymous grant/)
    assert.deepEqual(dbRows(dbPath), before)
  } finally {
    console.error = priorError
    process.exitCode = priorExitCode
    fs.rmSync(configDir, { recursive: true, force: true })
  }
})

test('wake refuses explicit cwd because wake is not move', () => {
  const stored = {
    localAgentId: 'local:recipe',
    process: {
      cwd: '/tmp/tlda-recipe-cwd',
      permissionProfile: 'wd',
    },
  }
  assert.throws(
    () => resolveWakeRecipeFields({ name: 'recipe', stored, explicitCwd: true }),
    /--cwd is not valid for wake/,
  )
})
