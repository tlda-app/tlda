#!/usr/bin/env node

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import YAML from 'yaml'
import {
  applyDaemonGrants,
  applyGrandfatherInfill,
  createPermissionLedger,
  defaultDaemonConfigPath,
  permissionLedgerPathFromDaemonConfig,
  readDaemonConfig,
  withDaemonModelAliases,
} from '../bin/lib/spawn/permission-ledger.mjs'
import { resolveSpawnGrant } from '../server/lib/spawn-policy.mjs'

function tempLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-permission-ledger-'))
  return path.join(dir, 'fleet-daemon.db')
}

function tempConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-daemon-config-'))
}

function writeFleetDb(file, agents) {
  const db = new Database(file)
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      friendly_name TEXT,
      tmux_session TEXT,
      session_id TEXT,
      session_ids TEXT,
      cwd TEXT,
      labels TEXT,
      registered_at TEXT,
      last_seen TEXT,
      dead INTEGER DEFAULT 0,
      human INTEGER DEFAULT 0,
      is_manager INTEGER DEFAULT 0,
      metadata TEXT,
      machine_id TEXT
    );
  `)
  const insert = db.prepare(`
    INSERT INTO agents (id, friendly_name, cwd, dead, human, metadata, machine_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  for (const agent of agents) {
    insert.run(
      agent.id,
      agent.friendly_name || null,
      agent.cwd || null,
      agent.dead || 0,
      agent.human || 0,
      agent.metadata ? JSON.stringify(agent.metadata) : null,
      agent.machine_id || 'mini',
    )
  }
  db.close()
}

describe('daemon permission ledger', () => {
  it('refuses unknown agents without writing a row', async () => {
    const file = tempLedger()
    const ledger = createPermissionLedger(file)

    assert.throws(
      () => ledger.grantFor({ id: 'fleet:unknown' }),
      (err) => err.code === 'SPAWN_PERMISSION_NO_LEDGER_ENTRY',
    )
    const db = new Database(file, { readonly: true })
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM permission_grants').get().n, 0)
    db.close()
    await ledger.close()
  })

  it('writes and reloads grants from daemon-owned sqlite rows', async () => {
    const file = tempLedger()
    const ledger = createPermissionLedger(file)

    const root = await ledger.set('fleet:skip', {
      spawnPolicy: 'write',
      permissionSet: {
        type: 'permission-set',
        name: 'root-worktree',
        operations: {
          read: { allow: ['/private/tmp/worktree/**'], deny: [] },
          write: { allow: ['/private/tmp/worktree/**'], deny: [] },
          spawn: { allow: ['**'], deny: [] },
        },
      },
      source: 'operator',
    })
    assert.equal(root.spawnPolicy.permission, 'write')
    assert.equal(fs.existsSync(file), true)

    const child = await ledger.set('fleet:child', {
      spawnPolicy: root.spawnPolicy,
      permissionSet: root.permissionSet,
      source: 'spawn',
    })
    assert.equal(child.permissionSet.name, 'root-worktree')

    const db = new Database(file, { readonly: true })
    const rows = db.prepare('SELECT id, spawn_policy, permission_set, source FROM permission_grants ORDER BY id').all()
    assert.deepEqual(rows.map(row => row.id), ['fleet:child', 'fleet:skip'])
    assert.equal(JSON.parse(rows[0].spawn_policy).permission, 'write')
    assert.equal(JSON.parse(rows[0].permission_set).name, 'root-worktree')
    assert.equal(rows[0].source, 'spawn')
    assert.equal(rows[1].source, 'operator')
    db.close()

    const reloaded = createPermissionLedger(file)
    const grant = reloaded.grantFor({ id: 'fleet:child' })
    assert.equal(grant.spawnPolicy.permission, 'write')
    assert.deepEqual(grant.permissionSet.operations.write.allow, ['/private/tmp/worktree/**'])
    assert.deepEqual(grant.permissionSet.operations.spawn.allow, ['**'])
    await reloaded.close()
    await ledger.close()
  })

  it('loads daemon model aliases from yaml separately from server config', () => {
    const dir = tempConfigDir()
    fs.writeFileSync(defaultDaemonConfigPath(dir), YAML.stringify({
      models: {
        claude: {
          localopus: 'claude-opus-local',
        },
      },
    }))

    const daemonConfig = readDaemonConfig(defaultDaemonConfigPath(dir))
    const config = withDaemonModelAliases({ defaultConfig: 'live', models: { claude: { stale: 'old' } } }, daemonConfig)
    assert.deepEqual(config.models, { claude: { localopus: 'claude-opus-local' } })
  })

  it('rejects daemon yaml keys outside regions, profiles, grants, models, and servers', () => {
    const dir = tempConfigDir()
    fs.writeFileSync(defaultDaemonConfigPath(dir), YAML.stringify({
      profiles: {},
      grants: {},
      models: {},
      servers: {},
      classes: {},
    }))
    assert.throws(
      () => readDaemonConfig(defaultDaemonConfigPath(dir)),
      /unknown key\(s\): classes/,
    )
  })

  it('rejects redundant daemon profile fields outside read and write roots', () => {
    const dir = tempConfigDir()
    fs.writeFileSync(defaultDaemonConfigPath(dir), YAML.stringify({
      profiles: {
        redundant: {
          permission: 'read',
          read: { allow: ['cwd'], deny: [] },
          write: { allow: [], deny: [] },
        },
      },
      regions: { cwd: ['cwd'] },
      grants: {},
      models: {},
      servers: {},
    }))
    assert.throws(
      () => readDaemonConfig(defaultDaemonConfigPath(dir)),
      /profile "redundant" supports only read, write, and description; unknown key\(s\): permission/,
    )
  })

  it('rejects profile references to unknown regions', () => {
    const dir = tempConfigDir()
    fs.writeFileSync(defaultDaemonConfigPath(dir), YAML.stringify({
      regions: { cwd: ['cwd'] },
      profiles: {
        bad: {
          read: { allow: ['not-a-region'], deny: [] },
          write: { allow: [], deny: [] },
        },
      },
      grants: {},
      models: {},
      servers: {},
    }))
    assert.throws(
      () => readDaemonConfig(defaultDaemonConfigPath(dir)),
      /references unknown region "not-a-region"/,
    )
  })

  it('migrates old daemon-permissions.yaml rows into fleet-daemon.db once', async () => {
    const dir = tempConfigDir()
    const dbPath = path.join(dir, 'fleet-daemon.db')
    fs.writeFileSync(path.join(dir, 'daemon-permissions.yaml'), YAML.stringify({
      version: 1,
      permissions: {
        agents: {
          'fleet:existing': {
            spawnPolicy: 'write',
            permissionSet: {
              type: 'permission-set',
              name: 'existing-write',
              operations: {
                read: { allow: ['/old/project/**'], deny: [] },
                write: { allow: ['/old/project/**'], deny: [] },
                spawn: { allow: ['**'], deny: [] },
              },
            },
            updatedAt: '2026-07-03T00:00:00.000Z',
            source: 'old-ledger',
          },
        },
      },
    }))

    const ledger = createPermissionLedger(dbPath)
    const existing = ledger.grantFor({ id: 'fleet:existing' })
    assert.equal(existing.spawnPolicy.permission, 'write')
    assert.equal(existing.source, 'old-ledger')
    assert.deepEqual(existing.permissionSet.operations.write.allow, ['/old/project/**'])
    assert.throws(
      () => ledger.grantFor({ id: 'fleet:missing' }),
      (err) => err.code === 'SPAWN_PERMISSION_NO_LEDGER_ENTRY',
    )
    await ledger.close()

    const db = new Database(dbPath, { readonly: true })
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM permission_grants').get().n, 1)
    assert.equal(db.prepare('SELECT value FROM ledger_meta WHERE key = ?').get('migration.daemon-permissions-yaml.v1') != null, true)
    db.close()

    const reopened = createPermissionLedger(dbPath)
    assert.equal(reopened.grantFor({ id: 'fleet:existing' }).spawnPolicy.permission, 'write')
    await reopened.close()
  })

  it('grandfathers alive non-human fleet.db agents with project-default intersect model-cap grants', async () => {
    const dir = tempConfigDir()
    const ledgerPath = path.join(dir, 'fleet-daemon.db')
    const fleetDbPath = path.join(dir, 'fleet.db')
    writeFleetDb(fleetDbPath, [
      {
        id: 'fleet:9b21164e',
        friendly_name: 'browser-lock-infra',
        cwd: '/Users/skip/work/tlda',
        metadata: { model: 'claude-sonnet-4-6', kind: 'claude' },
      },
      {
        id: 'fleet:dead',
        cwd: '/Users/skip/work/tlda',
        dead: 1,
        metadata: { model: 'gpt-5.5', kind: 'codex' },
      },
      {
        id: 'fleet:human',
        cwd: '/Users/skip/work/tlda',
        human: 1,
        metadata: { model: 'gpt-5.5', kind: 'codex' },
      },
    ])

    const ledger = createPermissionLedger(ledgerPath)
    const result = applyGrandfatherInfill(ledger, {
      fleetDbPath,
      config: {},
      projects: [{ name: 'tlda', sourceDir: '/Users/skip/work/tlda' }],
    })
    assert.deepEqual(result, { considered: 1, written: 1, skippedExisting: 0 })
    const grant = ledger.grantFor({ id: 'fleet:9b21164e' })
    assert.equal(grant.spawnPolicy.permission, 'write')
    assert.equal(grant.spawnPolicy.policy, 'cwd')
    assert.equal(grant.source, 'grandfather:fleet-db-cutover')
    assert.deepEqual(grant.permissionSet.operations.write.allow, ['/Users/skip/work/tlda/**'])
    assert.throws(
      () => ledger.grantFor({ id: 'fleet:unknown' }),
      (err) => err.code === 'SPAWN_PERMISSION_NO_LEDGER_ENTRY',
    )

    const again = applyGrandfatherInfill(ledger, { fleetDbPath, config: {} })
    assert.deepEqual(again, { considered: 1, written: 0, skippedExisting: 1 })
    await ledger.close()
  })

  it('uses flat daemon yaml for real profiles, grants, model rows, and servers', async () => {
    const dir = tempConfigDir()
    fs.writeFileSync(defaultDaemonConfigPath(dir), YAML.stringify({
      regions: {
        cwd: ['cwd'],
        temp: ['/tmp', '/tmp/**', '/private/tmp', '/private/tmp/**'],
        'agent-state-read': ['~/.codex', '~/.claude', '~/.claude/**', '~/.config/tlda', '~/.config/tlda/**'],
        'agent-state-write': ['~/.cache/**', '~/.codex/**', '~/.claude*', '~/.claude/**'],
        work: ['~/work/**'],
        apps: ['~/work/tlda/**'],
        'daemon-files': ['~/.config/tlda/fleet-daemon.log', '~/.config/tlda/fleet-daemon.pid', '~/.config/tlda/fleet-daemon.lock'],
        'browser-runtime': ['/tmp/tlda-pw-runtime', '/tmp/tlda-pw-runtime/**', '~/Library/Caches/ms-playwright', '~/Library/Caches/ms-playwright/**'],
        'daemon-db': ['~/.config/tlda/fleet.db*'],
        secrets: ['~/.ssh/id_*', '~/.aws/credentials', '**/.env'],
        machine: ['**'],
      },
      profiles: {
        readonly: {
          read: { allow: ['cwd', 'temp', 'agent-state-read'], deny: ['secrets'] },
          write: { allow: [], deny: ['secrets'] },
        },
        wd: {
          read: { allow: ['cwd', 'temp', 'agent-state-read'], deny: ['secrets'] },
          write: { allow: ['cwd', 'temp', 'agent-state-write'], deny: ['daemon-db', 'secrets'] },
        },
        math: {
          read: { allow: ['work', 'temp', 'agent-state-read'], deny: ['apps', 'secrets'] },
          write: { allow: ['work', 'temp', 'agent-state-write'], deny: ['apps', 'daemon-db', 'secrets'] },
        },
        app: {
          read: { allow: ['cwd', 'temp', 'daemon-files', 'browser-runtime', 'agent-state-read'], deny: ['secrets'] },
          write: { allow: ['cwd', 'temp', 'daemon-files', 'browser-runtime', 'agent-state-write'], deny: ['daemon-db', 'secrets'] },
        },
        ops: {
          read: { allow: ['machine'], deny: ['secrets'] },
          write: { allow: ['machine'], deny: ['daemon-db', 'secrets'] },
        },
      },
      grants: {
        'fleet:skip': 'ops',
      },
      models: {
        localgpt: {
          provider: 'codex',
          provider_model: 'gpt-local',
          cap: 'read',
          harness: {
            required: ['--codex-required-control'],
            preferences: ['--codex-preference'],
            controls: true,
          },
        },
      },
      servers: {
        local: {
          rpc: { spawn: true, hibernate: true },
        },
      },
    }))
    const daemonConfig = readDaemonConfig(defaultDaemonConfigPath(dir))
    const file = permissionLedgerPathFromDaemonConfig(daemonConfig, dir)
    assert.equal(file, path.join(dir, 'fleet-daemon.db'))
    assert.deepEqual(Object.keys(daemonConfig).sort(), ['grants', 'models', 'profiles', 'regions', 'servers'])
    assert.deepEqual(Object.keys(daemonConfig.profiles).sort(), ['app', 'math', 'ops', 'readonly', 'wd'])
    assert.deepEqual(daemonConfig.regions.apps, ['~/work/tlda/**'])
    assert.equal(daemonConfig.profiles.app.operations.write.deny[0], '~/.config/tlda/fleet.db*')
    assert.equal(daemonConfig.profiles.math.operations.read.deny.includes('~/work/tlda/**'), true)
    assert.equal(daemonConfig.profiles.math.operations.write.deny.includes('~/work/tlda/**'), true)
    assert.deepEqual(daemonConfig.profiles.ops.operations.spawn, { allow: [], deny: [] })
    assert.equal(daemonConfig.profiles.ops.projectedPolicy.permission, 'full')

    const ledger = createPermissionLedger(file)
    applyDaemonGrants(ledger, daemonConfig)
    const db = new Database(file, { readonly: true })
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM permission_grants').get().n, 1)
    assert.equal(db.prepare('SELECT source FROM permission_grants WHERE id = ?').get('fleet:skip').source, 'daemon.yaml:grants')
    db.close()

    assert.equal(fs.readFileSync(defaultDaemonConfigPath(dir), 'utf8').includes('classes:'), false)
    assert.equal(fs.readFileSync(defaultDaemonConfigPath(dir), 'utf8').includes('assignments:'), false)
    assert.equal(fs.existsSync(path.join(dir, 'daemon-permissions.yaml')), false)

    const config = withDaemonModelAliases({}, daemonConfig)
    assert.deepEqual(config.models.codex.localgpt, { id: 'gpt-local' })
    assert.deepEqual(config.harnessOptions.codex.localgpt, {
      required: ['--codex-required-control'],
      preferences: ['--codex-preference'],
      controls: true,
    })
    assert.deepEqual(config.harnessOptions.codex['gpt-local'], config.harnessOptions.codex.localgpt)
    assert.equal(config.spawnPolicy.permissionProfiles.app.operations.write.deny[0], '~/.config/tlda/fleet.db*')
    assert.equal(config.spawnPolicy.modelCeilings.localgpt, 'read')
    assert.equal(config.spawnPolicy.modelCeilings['gpt-local'], 'read')

    const grant = resolveSpawnGrant({
      requestedPermission: 'full',
      spawnerPolicy: ledger.grantFor({ id: 'fleet:skip' }).spawnPolicy,
      spawnerPermissionSet: ledger.grantFor({ id: 'fleet:skip' }).permissionSet,
      model: 'localgpt',
      kind: 'codex',
      config,
      cwd: '/tmp/project',
    })
    assert.equal(grant.spawnerPermission, 'full')
    assert.equal(grant.requestedPermission, 'full')
    assert.equal(grant.modelPermission, 'read')
    assert.equal(grant.grantedPermission, 'read')

    const mathGrant = resolveSpawnGrant({
      spawnerPolicy: 'full',
      spawnerPermissionSet: {
        type: 'permission-set',
        name: 'root',
        operations: {
          read: { allow: ['**'], deny: [] },
          write: { allow: ['**'], deny: [] },
          spawn: { allow: [], deny: [] },
        },
      },
      model: 'claude-opus-4-8',
      kind: 'claude',
      config: { ...config, spawnPolicy: { ...config.spawnPolicy, projectProfiles: { mathdoc: 'math' } } },
      doc: 'mathdoc',
      cwd: '/Users/skip/work/math-paper',
      project: { name: 'mathdoc', sourceDir: '/Users/skip/work/math-paper' },
    })
    assert.equal(mathGrant.requestedPermissionSet.operations.read.deny.includes('~/work/tlda/**'), true)
    assert.equal(mathGrant.grantedPermissionSet.operations.read.deny.includes('/Users/skip/work/tlda/**'), true)
    assert.equal(mathGrant.grantedPermissionSet.operations.write.allow.includes('/Users/skip/work/**'), true)

    await ledger.set('fleet:child', {
      spawnPolicy: grant.grantedPolicy,
      permissionSet: grant.grantedPermissionSet,
      source: 'spawn',
    })
    const check = new Database(file, { readonly: true })
    assert.equal(JSON.parse(check.prepare('SELECT spawn_policy FROM permission_grants WHERE id = ?').get('fleet:child').spawn_policy).permission, 'read')
    check.close()
    await ledger.close()
  })

  it('normalizes model rows without harness flags to neutral launch options', () => {
    const dir = tempConfigDir()
    fs.writeFileSync(defaultDaemonConfigPath(dir), YAML.stringify({
      models: {
        quietgpt: {
          provider: 'codex',
          provider_model: 'gpt-quiet',
          cap: 'read',
        },
      },
    }))
    const daemonConfig = readDaemonConfig(defaultDaemonConfigPath(dir))
    const config = withDaemonModelAliases({}, daemonConfig)
    assert.deepEqual(config.harnessOptions.codex.quietgpt, {
      required: [],
      preferences: [],
      controls: false,
    })
    assert.deepEqual(config.harnessOptions.codex['gpt-quiet'], config.harnessOptions.codex.quietgpt)
  })

  it('ships two static daemon config files: harness default and fenced alternative', () => {
    const harnessDefault = readDaemonConfig(new URL('../config/daemon.yaml', import.meta.url))
    const fenced = readDaemonConfig(new URL('../config/daemon-fenced.yaml', import.meta.url))

    const defaultConfig = withDaemonModelAliases({}, harnessDefault)
    assert.deepEqual(defaultConfig.harnessOptions.claude['*'].required, [])
    assert.deepEqual(defaultConfig.harnessOptions.claude['*'].preferences, ['--dangerously-load-development-channels server:tlda'])
    assert.equal(defaultConfig.harnessOptions.claude['*'].controls, true)
    assert.equal(Object.keys(defaultConfig.spawnPolicy.permissionProfiles || {}).length, 0)
    assert.equal(Object.keys(harnessDefault.grants).length, 0)

    const fencedConfig = withDaemonModelAliases({}, fenced)
    assert.deepEqual(fencedConfig.harnessOptions.claude['*'].required, [])
    assert.deepEqual(fencedConfig.harnessOptions.claude['*'].preferences, ['--dangerously-load-development-channels server:tlda', '--dangerously-skip-permissions'])
    assert.equal(fencedConfig.harnessOptions.claude['*'].controls, true)
    assert.deepEqual(Object.keys(fencedConfig.spawnPolicy.permissionProfiles).sort(), ['app', 'math', 'ops', 'readonly', 'wd'])
    assert.equal(fenced.grants['fleet:skip'], 'ops')
  })

  it('does not fail a write timeout after the worker commit has landed', async () => {
    const file = tempLedger()
    const ledger = createPermissionLedger(file)
    const row = ledger.rowFor('fleet:ack-late', {
      spawnPolicy: 'write',
      permissionSet: {
        type: 'permission-set',
        name: 'ack-late',
        operations: {
          read: { allow: ['/tmp/proof/**'], deny: [] },
          write: { allow: ['/tmp/proof/**'], deny: [] },
          spawn: { allow: [], deny: [] },
        },
      },
      source: 'test',
    })
    ledger.ensureWriter = () => ({
      postMessage(message) {
        const written = message.row
        ledger._upsert.run(
          written.id,
          written.spawnPolicy,
          written.permissionSet,
          written.updatedAt,
          written.source,
        )
      },
    })

    await ledger.writeAsync({
      op: 'upsert',
      row: {
        id: row.id,
        spawnPolicy: JSON.stringify(row.spawnPolicy),
        permissionSet: JSON.stringify(row.permissionSet),
        updatedAt: row.updatedAt,
        source: row.source,
      },
    }, 5)

    assert.equal(ledger.grantFor({ id: 'fleet:ack-late' }).spawnPolicy.permission, 'write')
    await ledger.close()
  })
})
