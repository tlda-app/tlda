import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'

import {
  bindLifecycleCodexResumeIdentity,
  cleanupFailedFreshBinding,
  collectSpawnModelOptionsFromRaw,
  permissionTransparencyLine,
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
  const apiCalls = []
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
    resolveIdentity: async ({ agent, tmuxSession, processOwnedOnly }) => {
      assert.equal(agent.id, 'fleet:test-cli-bind')
      assert.equal(agent.friendly_name, 'test-cli-bind')
      assert.equal(agent.cwd, '/tmp/tlda-cli-bind')
      assert.equal(agent.registered_at, undefined)
      assert.equal(tmuxSession, 'fleet-test-cli-bind')
      assert.equal(processOwnedOnly, true)
      return {
        sessionId: '11111111-2222-4333-8444-555555555555',
        jsonlPath: '/tmp/rollout-11111111-2222-4333-8444-555555555555.jsonl',
        model: 'gpt-5.5',
      }
    },
    api: async (method, url, body) => {
      apiCalls.push({ method, url, body })
      return { ok: true }
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
      machineId: 'mini',
      envName: 'default',
      daemonKey: 'mini:default',
      cwd: '/tmp/tlda-cli-bind',
      friendlyName: 'test-cli-bind',
    },
  }])
  assert.equal(apiCalls.length, 1)
  assert.equal(apiCalls[0].method, 'POST')
  assert.equal(apiCalls[0].url, '/api/agent-seat')
  assert.deepEqual({
    agent_id: apiCalls[0].body.agent_id,
    session_id: apiCalls[0].body.session_id,
    resume_id: apiCalls[0].body.resume_id,
    kind: apiCalls[0].body.kind,
    model: apiCalls[0].body.model,
    cwd: apiCalls[0].body.cwd,
    tmux_session: apiCalls[0].body.tmux_session,
    created_source: apiCalls[0].body.created_source,
    transition_reason: apiCalls[0].body.transition_reason,
  }, {
    agent_id: 'fleet:test-cli-bind',
    session_id: '11111111-2222-4333-8444-555555555555',
    resume_id: '11111111-2222-4333-8444-555555555555',
    kind: 'codex',
    model: 'gpt-5.5',
    cwd: '/tmp/tlda-cli-bind',
    tmux_session: 'fleet-test-cli-bind',
    created_source: 'agent-lifecycle-cli',
    transition_reason: 'agent-lifecycle-cli',
  })
})

test('CLI lifecycle codex wake treats existing resume id as bound', async () => {
  const result = {
    harness: 'codex',
    fleetId: 'fleet:test-cli-existing-bind',
    tmuxSession: 'fleet-test-cli-existing-bind',
    name: 'test-cli-existing-bind',
    model: 'gpt-5.5',
    resumeId: '22222222-2222-4333-8444-555555555555',
  }
  const writes = []
  const apiCalls = []
  const resolved = await bindLifecycleCodexResumeIdentity(result, {
    cwd: '/tmp/tlda-cli-existing-bind',
    name: 'test-cli-existing-bind',
    ledger: {
      setSessionSync(id, row) {
        writes.push({ id, row })
      },
    },
    api: async (method, url, body) => {
      apiCalls.push({ method, url, body })
      return { ok: true }
    },
  })

  assert.equal(resolved.bound, true)
  assert.equal(resolved.existing, true)
  assert.deepEqual(writes, [])
  assert.equal(apiCalls.length, 1)
  assert.equal(apiCalls[0].method, 'POST')
  assert.equal(apiCalls[0].url, '/api/agent-seat')
  assert.deepEqual({
    agent_id: apiCalls[0].body.agent_id,
    session_id: apiCalls[0].body.session_id,
    resume_id: apiCalls[0].body.resume_id,
    kind: apiCalls[0].body.kind,
    model: apiCalls[0].body.model,
    cwd: apiCalls[0].body.cwd,
    tmux_session: apiCalls[0].body.tmux_session,
    created_source: apiCalls[0].body.created_source,
    transition_reason: apiCalls[0].body.transition_reason,
  }, {
    agent_id: 'fleet:test-cli-existing-bind',
    session_id: '22222222-2222-4333-8444-555555555555',
    resume_id: '22222222-2222-4333-8444-555555555555',
    kind: 'codex',
    model: 'gpt-5.5',
    cwd: '/tmp/tlda-cli-existing-bind',
    tmux_session: 'fleet-test-cli-existing-bind',
    created_source: 'agent-lifecycle-cli',
    transition_reason: 'agent-lifecycle-cli',
  })
})

test('CLI lifecycle Claude spawn binds exact process-owned identity through canonical seam', async () => {
  const result = {
    harness: 'claude',
    fleetId: 'fleet:test-cli-claude-bind',
    tmuxSession: 'fleet-test-cli-claude-bind',
    name: 'test-cli-claude-bind',
    model: 'claude-sonnet',
  }
  const writes = []
  const apiCalls = []
  const resolved = await bindLifecycleCodexResumeIdentity(result, {
    cwd: '/tmp/tlda-cli-claude-bind',
    name: result.name,
    timeoutMs: 0,
    intervalMs: 0,
    ledger: { setSessionSync(id, row) { writes.push({ id, row }) } },
    resolveIdentity: async ({ agent, tmuxSession, processOwnedOnly }) => {
      assert.equal(agent.id, result.fleetId)
      assert.equal(tmuxSession, result.tmuxSession)
      assert.equal(processOwnedOnly, true)
      return {
        sessionId: '33333333-3333-4333-8333-333333333333',
        jsonlPath: '/tmp/claude-33333333-3333-4333-8333-333333333333.jsonl',
        model: result.model,
      }
    },
    api: async (method, url, body) => { apiCalls.push({ method, url, body }); return { ok: true } },
  })
  assert.equal(resolved.bound, true)
  assert.equal(result.resumeId, '33333333-3333-4333-8333-333333333333')
  assert.equal(writes[0].row.sessionKind, 'claude')
  assert.equal(writes[0].row.sessionPath, '/tmp/claude-33333333-3333-4333-8333-333333333333.jsonl')
  assert.equal(apiCalls[0].body.kind, 'claude')
  assert.equal(apiCalls[0].body.session_id, result.resumeId)
})

test('CLI lifecycle Claude spawn stays pending without Created when exact identity is absent', async () => {
  const result = { harness: 'claude', fleetId: 'fleet:test-cli-claude-pending', tmuxSession: 'fleet-test-cli-claude-pending' }
  const resolved = await bindLifecycleCodexResumeIdentity(result, {
    cwd: '/tmp/tlda-cli-claude-pending', name: result.fleetId,
    timeoutMs: 0, intervalMs: 0,
    resolveIdentity: async ({ processOwnedOnly }) => { assert.equal(processOwnedOnly, true); return null },
    api: async () => { throw new Error('must not create seat while identity is pending') },
  })
  assert.equal(resolved.bound, false)
  assert.equal(resolved.pending, true)
  assert.equal(result.resumeId, undefined)
})

test('CLI lifecycle claude wake posts the current durable seat from its resume id', async () => {
  const result = {
    harness: 'claude',
    fleetId: 'fleet:test-cli-claude-bind',
    tmuxSession: 'fleet-test-cli-claude-bind',
    name: 'test-cli-claude-bind',
    model: 'claude-sonnet-4',
    resumeId: '33333333-2222-4333-8444-555555555555',
  }
  const writes = []
  const apiCalls = []
  const resolved = await bindLifecycleCodexResumeIdentity(result, {
    cwd: '/tmp/tlda-cli-claude-bind',
    name: 'test-cli-claude-bind',
    ledger: {
      setSessionSync(id, row) {
        writes.push({ id, row })
      },
    },
    api: async (method, url, body) => {
      apiCalls.push({ method, url, body })
      return { ok: true }
    },
  })

  assert.equal(resolved.bound, true)
  assert.equal(resolved.existing, true)
  assert.deepEqual(writes, [])
  assert.equal(apiCalls.length, 1)
  assert.equal(apiCalls[0].method, 'POST')
  assert.equal(apiCalls[0].url, '/api/agent-seat')
  assert.deepEqual({
    agent_id: apiCalls[0].body.agent_id,
    session_id: apiCalls[0].body.session_id,
    resume_id: apiCalls[0].body.resume_id,
    kind: apiCalls[0].body.kind,
    model: apiCalls[0].body.model,
    cwd: apiCalls[0].body.cwd,
    tmux_session: apiCalls[0].body.tmux_session,
    created_source: apiCalls[0].body.created_source,
    transition_reason: apiCalls[0].body.transition_reason,
  }, {
    agent_id: 'fleet:test-cli-claude-bind',
    session_id: '33333333-2222-4333-8444-555555555555',
    resume_id: '33333333-2222-4333-8444-555555555555',
    kind: 'claude',
    model: 'claude-sonnet-4',
    cwd: '/tmp/tlda-cli-claude-bind',
    tmux_session: 'fleet-test-cli-claude-bind',
    created_source: 'agent-lifecycle-cli',
    transition_reason: 'agent-lifecycle-cli',
  })
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
  alpha_only:
    - "/tmp/tlda-recipe-cwd/alpha/**"
  beta_only:
    - "/tmp/tlda-recipe-cwd/beta/**"
  shared:
    - "/tmp/tlda-recipe-cwd/shared/**"
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
  alpha:
    read:
      allow: [alpha_only, shared]
    write:
      allow: [alpha_only, shared]
  beta:
    read:
      allow: [beta_only, shared]
    write:
      allow: [beta_only, shared]
default: alpha
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
  const apiCalls = []
  const logs = []
  const priorLog = console.log
  try {
    writeDaemonConfig(configDir)
    seedWakeRecipe(dbPath, { profile: 'ops' })
    seedPermissionLedger(dbPath)
    const beforeGrantRow = rawPermissionGrantRow(dbPath, 'fleet:recipe')
    console.log = (...args) => { logs.push(args.join(' ')) }

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
      apiImpl: async (method, url, body) => {
        apiCalls.push({ method, url, body })
        return { ok: true }
      },
    })

    assert.equal(spawnCalls.length, 1)
    assert.equal(apiCalls.length, 1)
    assert.equal(apiCalls[0].url, '/api/agent-seat')
    assert.equal(apiCalls[0].body.kind, 'codex')
    assert.equal(apiCalls[0].body.session_id, '11111111-2222-4333-8444-555555555555')
    assert.equal(spawnCalls[0].cwd, '/tmp/tlda-recipe-cwd')
    assert.equal(spawnCalls[0].permissionProfile, 'ops')
    assert.equal(spawnCalls[0].spawnPolicy.policy, 'unsandboxed')
    assert.equal(spawnCalls[0].permissionRequest, undefined)
    assert.equal(spawnCalls[0].explicitPolicy, false)
    assert.equal(logs.find((line) => line.startsWith('  permissions:')), '  permissions: ops')

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
    console.log = priorLog
    fs.rmSync(configDir, { recursive: true, force: true })
  }
})

test('permission transparency prints only contract-legal forms', () => {
  assert.equal(
    permissionTransparencyLine({ permissionProfile: 'wd' }),
    '  permissions: wd',
  )
  assert.equal(
    permissionTransparencyLine({
      permissionSet: {
        operations: {
          read: { allow: ['/project/src/**'], deny: ['/project/src/.env'] },
          write: { allow: ['/project/src/output/**'], deny: [] },
        },
      },
    }),
    '  permissions: read regions: allow [/project/src/**], deny [/project/src/.env]; write regions: allow [/project/src/output/**], deny []',
  )
  assert.equal(permissionTransparencyLine({}), null)
  assert.equal(permissionTransparencyLine({ permissionIntersection: { profiles: ['alpha'] } }), null)
})

test('permission transparency narration never emits forbidden vocabulary', () => {
  const samples = [
    permissionTransparencyLine({ permissionProfile: 'wd' }),
    permissionTransparencyLine({ permissionIntersection: { profiles: ['alpha', 'beta'] } }),
    permissionTransparencyLine({
      permissionSet: {
        operations: {
          read: { allow: ['/project/src/**'], deny: [] },
          write: { allow: ['/project/src/output/**'], deny: [] },
        },
      },
    }),
  ].filter(Boolean)
  const forbidden = [
    /\bscope\b/i,
    /\bfenced\b/i,
    /\bunfenced\b/i,
    /full access/i,
    /\bunmatched\b/i,
    /anonymous CWD/i,
  ]
  for (const sample of samples) {
    for (const pattern of forbidden) assert.doesNotMatch(sample, pattern)
  }
})

test('wake narration prints real resolver-produced structured intersections', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-wake-intersection-grant-'))
  const dbPath = path.join(configDir, 'fleet-daemon.db')
  const spawnCalls = []
  const logs = []
  const priorLog = console.log
  try {
    writeDaemonConfig(configDir)
    seedWakeRecipe(dbPath, { profile: 'ops' })
    seedPermissionLedger(dbPath, {
      localhostProfile: 'beta',
      localhostSet: permissionSet('beta', ['/tmp/tlda-recipe-cwd/beta/**', '/tmp/tlda-recipe-cwd/shared/**']),
    })
    console.log = (...args) => { logs.push(args.join(' ')) }

    await runFleetSpawn(['recipe', '--permissions', 'alpha'], {
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
          resumeId: '44444444-2222-4333-8444-555555555555',
        }
      },
      apiImpl: async () => ({ ok: true }),
    })

    assert.equal(spawnCalls.length, 1)
    assert.deepEqual(spawnCalls[0].permissionIntersection.profiles, ['alpha', 'beta'])
    assert.equal(logs.find((line) => line.startsWith('  permissions:')), '  permissions: alpha intersection beta')

    const permissionLedger = createPermissionLedger(dbPath)
    try {
      const grant = permissionLedger.get('fleet:recipe')
      assert.deepEqual(grant.permissionIntersection.profiles, ['alpha', 'beta'])
      assert.equal(grant.permissionProfile, null)
    } finally {
      permissionLedger.close()
    }

    logs.length = 0
    spawnCalls.length = 0
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
          resumeId: '44444444-3333-4333-8444-555555555555',
        }
      },
      apiImpl: async () => ({ ok: true }),
    })
    assert.equal(spawnCalls.length, 1)
    assert.deepEqual(spawnCalls[0].permissionIntersection.profiles, ['alpha', 'beta'])
    assert.equal(spawnCalls[0].permissionRequest, undefined)
    assert.equal(logs.find((line) => line.startsWith('  permissions:')), '  permissions: alpha intersection beta')
  } finally {
    console.log = priorLog
    fs.rmSync(configDir, { recursive: true, force: true })
  }
})

test('fresh spawn narration prints complete read and write regions when grant has no profile identity', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-fresh-region-grant-'))
  const dbPath = path.join(configDir, 'fleet-daemon.db')
  const spawnCalls = []
  const logs = []
  const priorLog = console.log
  try {
    writeDaemonConfig(configDir)
    seedPermissionLedger(dbPath, {
      localhostProfile: null,
      localhostSet: permissionSet('shared-only', ['/tmp/tlda-recipe-cwd/shared/**']),
    })
    console.log = (...args) => { logs.push(args.join(' ')) }

    await runFleetSpawn(['--fresh', 'region-grant'], {
      configDir,
      localAgentLedgerPath: dbPath,
      loadConfigImpl: () => ({
        spawnPolicy: {
          defaultProfile: 'alpha',
        },
      }),
      spawnImpl: async (params) => {
        spawnCalls.push(params)
        return {
          fleetId: 'fleet:region-grant',
          tmuxSession: 'fleet-region-grant',
          harness: 'codex',
          model: 'gpt-5.5',
          resumeId: '55555555-2222-4333-8444-555555555555',
        }
      },
      apiImpl: async (method) => method === 'POST'
        ? { ok: true }
        : {
            ok: true,
            seat: {
              agent_id: 'fleet:region-grant',
              session_id: '55555555-2222-4333-8444-555555555555',
              tmux_session: 'fleet-region-grant',
            },
          },
    })

    assert.equal(spawnCalls.length, 1)
    assert.equal(spawnCalls[0].permissionProfile, null)
    assert.equal(logs.find((line) => line.startsWith('  permissions:')), '  permissions: read regions: allow [/tmp/tlda-recipe-cwd/shared/**], deny []; write regions: allow [/tmp/tlda-recipe-cwd/shared/**], deny []')
  } finally {
    console.log = priorLog
    fs.rmSync(configDir, { recursive: true, force: true })
  }
})

test('fresh mint cleans only its exact spawn after terminal durable-seat collision', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-fresh-seat-collision-'))
  const dbPath = path.join(configDir, 'fleet-daemon.db')
  const cleaned = []
  const logs = []
  const errors = []
  const priorLog = console.log
  const priorError = console.error
  const priorExitCode = process.exitCode
  try {
    writeDaemonConfig(configDir)
    seedPermissionLedger(dbPath)
    console.log = (...args) => logs.push(args.join(' '))
    console.error = (...args) => errors.push(args.join(' '))
    process.exitCode = undefined
    await runFleetSpawn(['--fresh', 'collision'], {
      configDir,
      localAgentLedgerPath: dbPath,
      loadConfigImpl: () => ({}),
      spawnImpl: async () => ({
        localAgentId: 'local:collision',
        fleetId: 'fleet:collision',
        tmuxSession: 'fleet-collision',
        harness: 'codex',
        model: 'gpt-5.5',
        resumeId: 'aaaaaaaa-2222-4333-8444-555555555555',
      }),
      apiImpl: async (method) => {
        const error = new Error(method === 'POST' ? 'UNIQUE constraint failed: agent_seats.session_id' : 'agent has no current durable seat')
        error.status = method === 'POST' ? 409 : 404
        throw error
      },
      cleanupFailedBindingImpl: async (result) => cleaned.push(result),
    })
    assert.equal(process.exitCode, 1)
    assert.equal(cleaned.length, 1)
    assert.equal(cleaned[0].tmuxSession, 'fleet-collision')
    assert.doesNotMatch(logs.join('\n'), /^Created /m)
    assert.match(errors.join('\n'), /UNIQUE constraint failed/)
  } finally {
    console.log = priorLog
    console.error = priorError
    process.exitCode = priorExitCode
    fs.rmSync(configDir, { recursive: true, force: true })
  }
})

test('fresh mint keeps exact runtime pending only after submitted binding has uncertain transport', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-fresh-seat-pending-'))
  const dbPath = path.join(configDir, 'fleet-daemon.db')
  const cleaned = []
  const logs = []
  const priorLog = console.log
  const priorExitCode = process.exitCode
  try {
    writeDaemonConfig(configDir)
    seedPermissionLedger(dbPath)
    console.log = (...args) => logs.push(args.join(' '))
    process.exitCode = undefined
    await runFleetSpawn(['--fresh', 'pending'], {
      configDir,
      localAgentLedgerPath: dbPath,
      loadConfigImpl: () => ({}),
      spawnImpl: async () => ({
        localAgentId: 'local:pending',
        fleetId: 'fleet:pending',
        tmuxSession: 'fleet-pending',
        harness: 'codex',
        model: 'gpt-5.5',
        resumeId: 'bbbbbbbb-2222-4333-8444-555555555555',
      }),
      apiImpl: async () => { throw new Error('Request timed out') },
      cleanupFailedBindingImpl: async (result) => cleaned.push(result),
    })
    assert.equal(process.exitCode, undefined)
    assert.equal(cleaned.length, 0)
    assert.match(logs.join('\n'), /pending durable seat binding/)
    assert.doesNotMatch(logs.join('\n'), /^Created /m)
  } finally {
    console.log = priorLog
    process.exitCode = priorExitCode
    fs.rmSync(configDir, { recursive: true, force: true })
  }
})

test('fresh non-Codex uncertain binding stays pending and never prints Created', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-fresh-claude-seat-pending-'))
  const dbPath = path.join(configDir, 'fleet-daemon.db')
  const cleaned = []
  const logs = []
  const priorLog = console.log
  const priorExitCode = process.exitCode
  try {
    writeDaemonConfig(configDir)
    seedPermissionLedger(dbPath)
    console.log = (...args) => logs.push(args.join(' '))
    process.exitCode = undefined
    await runFleetSpawn(['--fresh', 'claude-pending'], {
      configDir,
      localAgentLedgerPath: dbPath,
      loadConfigImpl: () => ({}),
      spawnImpl: async () => ({
        localAgentId: 'local:claude-pending',
        fleetId: 'fleet:claude-pending',
        tmuxSession: 'fleet-claude-pending',
        harness: 'claude',
        model: 'claude-sonnet-4',
        resumeId: 'cccccccc-2222-4333-8444-555555555555',
      }),
      apiImpl: async () => { throw new Error('Request timed out') },
      cleanupFailedBindingImpl: async (result) => cleaned.push(result),
    })
    assert.equal(process.exitCode, undefined)
    assert.equal(cleaned.length, 0)
    assert.match(logs.join('\n'), /pending durable seat binding/)
    assert.doesNotMatch(logs.join('\n'), /^Created /m)
  } finally {
    console.log = priorLog
    process.exitCode = priorExitCode
    fs.rmSync(configDir, { recursive: true, force: true })
  }
})

test('ordinary wake transport failure neither prints Woke nor becomes fresh-style pending', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-wake-seat-transport-failure-'))
  const dbPath = path.join(configDir, 'fleet-daemon.db')
  const logs = []
  const errors = []
  const priorLog = console.log
  const priorError = console.error
  const priorExitCode = process.exitCode
  try {
    writeDaemonConfig(configDir)
    seedWakeRecipe(dbPath, { profile: 'ops' })
    seedPermissionLedger(dbPath)
    console.log = (...args) => logs.push(args.join(' '))
    console.error = (...args) => errors.push(args.join(' '))
    process.exitCode = undefined
    await runFleetSpawn(['recipe'], {
      configDir,
      localAgentLedgerPath: dbPath,
      loadConfigImpl: () => ({}),
      spawnImpl: async () => ({
        fleetId: 'fleet:recipe',
        tmuxSession: 'fleet-recipe',
        harness: 'codex',
        model: 'gpt-5.5',
        resumeId: 'dddddddd-2222-4333-8444-555555555555',
      }),
      apiImpl: async () => { throw new Error('wake seat transport unavailable') },
    })
    assert.equal(process.exitCode, 1)
    assert.doesNotMatch(logs.join('\n'), /^Woke /m)
    assert.doesNotMatch(logs.join('\n'), /pending durable seat binding/)
    assert.match(errors.join('\n'), /wake seat transport unavailable/)
  } finally {
    console.log = priorLog
    console.error = priorError
    process.exitCode = priorExitCode
    fs.rmSync(configDir, { recursive: true, force: true })
  }
})

test('ordinary non-Codex wake preserves skipped binding and prints Woke', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-wake-noncodex-skipped-binding-'))
  const dbPath = path.join(configDir, 'fleet-daemon.db')
  const logs = []
  const priorLog = console.log
  try {
    writeDaemonConfig(configDir)
    seedWakeRecipe(dbPath, { profile: 'ops' })
    seedPermissionLedger(dbPath)
    console.log = (...args) => logs.push(args.join(' '))
    await runFleetSpawn(['recipe'], {
      configDir,
      localAgentLedgerPath: dbPath,
      loadConfigImpl: () => ({}),
      spawnImpl: async () => ({
        fleetId: 'fleet:recipe',
        tmuxSession: 'fleet-recipe',
        harness: 'claude',
        model: 'claude-sonnet-4',
        resumeId: null,
      }),
    })
    assert.match(logs.join('\n'), /^Woke fleet-recipe \(fleet:recipe\)/m)
    assert.doesNotMatch(logs.join('\n'), /pending durable seat binding/)
  } finally {
    console.log = priorLog
    fs.rmSync(configDir, { recursive: true, force: true })
  }
})

test('ordinary Codex wake preserves exact-identity absence warning and Woke', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-wake-codex-identity-pending-'))
  const dbPath = path.join(configDir, 'fleet-daemon.db')
  const logs = []
  const errors = []
  const priorLog = console.log
  const priorError = console.error
  const priorTimeout = process.env.TLDA_SPAWN_RESUME_ID_TIMEOUT_MS
  try {
    writeDaemonConfig(configDir)
    seedWakeRecipe(dbPath, { profile: 'ops' })
    seedPermissionLedger(dbPath)
    console.log = (...args) => logs.push(args.join(' '))
    console.error = (...args) => errors.push(args.join(' '))
    process.env.TLDA_SPAWN_RESUME_ID_TIMEOUT_MS = '0'
    await runFleetSpawn(['recipe'], {
      configDir,
      localAgentLedgerPath: dbPath,
      loadConfigImpl: () => ({}),
      spawnImpl: async () => ({
        fleetId: 'fleet:recipe',
        tmuxSession: 'fleet-does-not-exist',
        harness: 'codex',
        model: 'gpt-5.5',
        resumeId: null,
      }),
    })
    assert.match(logs.join('\n'), /^Woke fleet-does-not-exist \(fleet:recipe\)/m)
    assert.match(errors.join('\n'), /could not bind a Codex resume identity yet/)
    assert.doesNotMatch(logs.join('\n'), /pending durable seat binding/)
  } finally {
    console.log = priorLog
    console.error = priorError
    if (priorTimeout == null) delete process.env.TLDA_SPAWN_RESUME_ID_TIMEOUT_MS
    else process.env.TLDA_SPAWN_RESUME_ID_TIMEOUT_MS = priorTimeout
    fs.rmSync(configDir, { recursive: true, force: true })
  }
})

test('fresh Codex identity absence remains pending without success, submission, or cleanup', async () => {
  const result = {
    harness: 'codex',
    fleetId: 'fleet:no-exact-identity',
    tmuxSession: 'fleet-no-exact-identity',
  }
  let submissions = 0
  const binding = await bindLifecycleCodexResumeIdentity(result, {
      cwd: '/same/cwd',
      name: 'no-exact-identity',
      timeoutMs: 0,
      intervalMs: 0,
      ledger: { setSessionSync() { throw new Error('must not write a guessed identity') } },
      resolveIdentity: async ({ processOwnedOnly }) => {
        assert.equal(processOwnedOnly, true)
        return null
      },
      api: async () => { submissions += 1; throw new Error('must not submit without an exact identity') },
    })
  assert.deepEqual({ bound: binding.bound, pending: binding.pending, reason: binding.reason }, {
    bound: false,
    pending: true,
    reason: 'exact-identity-pending',
  })
  assert.equal(submissions, 0)
})

test('terminal binding cleanup deletes the exact local recipe and retires its reservation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-terminal-binding-cleanup-'))
  const dbPath = path.join(dir, 'fleet-daemon.db')
  const localLedger = createLocalAgentLedger(dbPath)
  localLedger.create({
    localAgentId: 'local:cleanup',
    serverAgentId: 'fleet:cleanup',
    friendlyName: 'cleanup',
    harness: 'codex',
    model: 'gpt-5.5',
    tmuxName: 'fleet-cleanup',
    cwd: '/tmp',
  })
  localLedger.close()
  const terminated = []
  const apiCalls = []
  try {
    await cleanupFailedFreshBinding({
      localAgentId: 'local:cleanup',
      fleetId: 'fleet:cleanup',
      tmuxSession: 'fleet-cleanup',
    }, {
      localAgentLedgerPath: dbPath,
      terminateImpl: async (tmuxSession) => { terminated.push(tmuxSession); return true },
      api: async (method, url) => { apiCalls.push({ method, url }); return { ok: true } },
    })
    const verify = createLocalAgentLedger(dbPath)
    try { assert.equal(verify.get('local:cleanup'), null) } finally { verify.close() }
    assert.deepEqual(terminated, ['fleet-cleanup'])
    assert.deepEqual(apiCalls, [{ method: 'POST', url: '/api/agents/fleet%3Acleanup/mark-dead' }])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('wake honors explicit permissions and persists the clamped resolved grant', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-wake-explicit-clamp-'))
  const dbPath = path.join(configDir, 'fleet-daemon.db')
  const spawnCalls = []
  const apiCalls = []
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
      apiImpl: async (method, url, body) => {
        apiCalls.push({ method, url, body })
        return { ok: true }
      },
    })

    assert.equal(spawnCalls.length, 1)
    assert.equal(apiCalls.length, 1)
    assert.equal(apiCalls[0].url, '/api/agent-seat')
    assert.equal(apiCalls[0].body.kind, 'codex')
    assert.equal(apiCalls[0].body.session_id, '22222222-2222-4333-8444-555555555555')
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
  const apiCalls = []
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
      apiImpl: async (method, url, body) => {
        apiCalls.push({ method, url, body })
        return { ok: true }
      },
    })

    assert.equal(spawnCalls.length, 1)
    assert.equal(apiCalls.length, 1)
    assert.equal(apiCalls[0].url, '/api/agent-seat')
    assert.equal(apiCalls[0].body.kind, 'codex')
    assert.equal(apiCalls[0].body.session_id, '33333333-2222-4333-8444-555555555555')
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
