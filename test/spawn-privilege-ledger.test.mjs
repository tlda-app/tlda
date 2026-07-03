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
  createPrivilegeLedger,
  defaultDaemonConfigPath,
  privilegeLedgerPathFromDaemonConfig,
  readDaemonConfig,
  withDaemonModelAliases,
} from '../bin/lib/spawn/privilege-ledger.mjs'
import { resolveSpawnGrant } from '../server/lib/spawn-policy.mjs'

function tempLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-privilege-ledger-'))
  return path.join(dir, 'fleet-daemon.db')
}

function tempConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-daemon-config-'))
}

describe('daemon privilege ledger', () => {
  it('refuses unknown agents without writing a row', async () => {
    const file = tempLedger()
    const ledger = createPrivilegeLedger(file)

    assert.throws(
      () => ledger.grantFor({ id: 'fleet:unknown' }),
      (err) => err.code === 'SPAWN_PRIVILEGE_NO_LEDGER_ENTRY',
    )
    const db = new Database(file, { readonly: true })
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM privilege_grants').get().n, 0)
    db.close()
    await ledger.close()
  })

  it('writes and reloads grants from daemon-owned sqlite rows', async () => {
    const file = tempLedger()
    const ledger = createPrivilegeLedger(file)

    const root = await ledger.set('fleet:skip', {
      spawnPolicy: 'write',
      privilegeSet: {
        type: 'privilege-set',
        name: 'root-worktree',
        operations: {
          read: { allow: ['/private/tmp/worktree/**'], deny: [] },
          write: { allow: ['/private/tmp/worktree/**'], deny: [] },
          spawn: { allow: ['**'], deny: [] },
        },
      },
      source: 'operator',
    })
    assert.equal(root.spawnPolicy.capability, 'write')
    assert.equal(fs.existsSync(file), true)

    const child = await ledger.set('fleet:child', {
      spawnPolicy: root.spawnPolicy,
      privilegeSet: root.privilegeSet,
      source: 'spawn',
    })
    assert.equal(child.privilegeSet.name, 'root-worktree')

    const db = new Database(file, { readonly: true })
    const rows = db.prepare('SELECT id, spawn_policy, privilege_set, source FROM privilege_grants ORDER BY id').all()
    assert.deepEqual(rows.map(row => row.id), ['fleet:child', 'fleet:skip'])
    assert.equal(JSON.parse(rows[0].spawn_policy).capability, 'write')
    assert.equal(JSON.parse(rows[0].privilege_set).name, 'root-worktree')
    assert.equal(rows[0].source, 'spawn')
    assert.equal(rows[1].source, 'operator')
    db.close()

    const reloaded = createPrivilegeLedger(file)
    const grant = reloaded.grantFor({ id: 'fleet:child' })
    assert.equal(grant.spawnPolicy.capability, 'write')
    assert.deepEqual(grant.privilegeSet.operations.write.allow, ['/private/tmp/worktree/**'])
    assert.deepEqual(grant.privilegeSet.operations.spawn.allow, ['**'])
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

  it('rejects daemon yaml keys outside profiles, grants, models, and servers', () => {
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

  it('migrates old daemon-privileges.yaml rows into fleet-daemon.db once', async () => {
    const dir = tempConfigDir()
    const dbPath = path.join(dir, 'fleet-daemon.db')
    fs.writeFileSync(path.join(dir, 'daemon-privileges.yaml'), YAML.stringify({
      version: 1,
      privileges: {
        agents: {
          'fleet:existing': {
            spawnPolicy: 'write',
            privilegeSet: {
              type: 'privilege-set',
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

    const ledger = createPrivilegeLedger(dbPath)
    const existing = ledger.grantFor({ id: 'fleet:existing' })
    assert.equal(existing.spawnPolicy.capability, 'write')
    assert.equal(existing.source, 'old-ledger')
    assert.deepEqual(existing.privilegeSet.operations.write.allow, ['/old/project/**'])
    assert.throws(
      () => ledger.grantFor({ id: 'fleet:missing' }),
      (err) => err.code === 'SPAWN_PRIVILEGE_NO_LEDGER_ENTRY',
    )
    await ledger.close()

    const db = new Database(dbPath, { readonly: true })
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM privilege_grants').get().n, 1)
    assert.equal(db.prepare('SELECT value FROM ledger_meta WHERE key = ?').get('migration.daemon-privileges-yaml.v1') != null, true)
    db.close()

    const reopened = createPrivilegeLedger(dbPath)
    assert.equal(reopened.grantFor({ id: 'fleet:existing' }).spawnPolicy.capability, 'write')
    await reopened.close()
  })

  it('uses flat daemon yaml for real profiles, grants, model rows, and servers', async () => {
    const dir = tempConfigDir()
    fs.writeFileSync(defaultDaemonConfigPath(dir), YAML.stringify({
      profiles: {
        ops: {
          capability: 'full',
          operations: {
            read: { allow: ['**'], deny: [] },
            write: { allow: ['**'], deny: ['~/.config/tlda/fleet.db*'] },
            spawn: { allow: ['**'], deny: [] },
          },
        },
      },
      grants: {
        'fleet:spawner': 'ops',
      },
      models: {
        localgpt: {
          provider: 'codex',
          provider_model: 'gpt-local',
          cap: 'read',
        },
      },
      servers: {
        local: {
          rpc: { spawn: true, hibernate: true },
        },
      },
    }))
    const daemonConfig = readDaemonConfig(defaultDaemonConfigPath(dir))
    const file = privilegeLedgerPathFromDaemonConfig(daemonConfig, dir)
    assert.equal(file, path.join(dir, 'fleet-daemon.db'))
    assert.deepEqual(Object.keys(daemonConfig).sort(), ['grants', 'models', 'profiles', 'servers'])
    assert.equal(daemonConfig.profiles.ops.operations.write.deny[0], '~/.config/tlda/fleet.db*')

    const ledger = createPrivilegeLedger(file)
    applyDaemonGrants(ledger, daemonConfig)
    const db = new Database(file, { readonly: true })
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM privilege_grants').get().n, 1)
    assert.equal(db.prepare('SELECT source FROM privilege_grants WHERE id = ?').get('fleet:spawner').source, 'daemon.yaml:grants')
    db.close()

    assert.equal(fs.readFileSync(defaultDaemonConfigPath(dir), 'utf8').includes('classes:'), false)
    assert.equal(fs.readFileSync(defaultDaemonConfigPath(dir), 'utf8').includes('assignments:'), false)
    assert.equal(fs.existsSync(path.join(dir, 'daemon-privileges.yaml')), false)

    const config = withDaemonModelAliases({}, daemonConfig)
    assert.deepEqual(config.models.codex.localgpt, { id: 'gpt-local' })
    assert.equal(config.spawnPolicy.privilegeProfiles.ops.operations.write.deny[0], '~/.config/tlda/fleet.db*')
    assert.equal(config.spawnPolicy.modelCeilings.localgpt, 'read')
    assert.equal(config.spawnPolicy.modelCeilings['gpt-local'], 'read')

    const grant = resolveSpawnGrant({
      requestedCapability: 'full',
      spawnerPolicy: ledger.grantFor({ id: 'fleet:spawner' }).spawnPolicy,
      spawnerPrivilegeSet: ledger.grantFor({ id: 'fleet:spawner' }).privilegeSet,
      model: 'localgpt',
      kind: 'codex',
      config,
      cwd: '/tmp/project',
    })
    assert.equal(grant.spawnerCapability, 'full')
    assert.equal(grant.requestedCapability, 'full')
    assert.equal(grant.modelCapability, 'read')
    assert.equal(grant.grantedCapability, 'read')

    await ledger.set('fleet:child', {
      spawnPolicy: grant.grantedPolicy,
      privilegeSet: grant.grantedPrivilegeSet,
      source: 'spawn',
    })
    const check = new Database(file, { readonly: true })
    assert.equal(JSON.parse(check.prepare('SELECT spawn_policy FROM privilege_grants WHERE id = ?').get('fleet:child').spawn_policy).capability, 'read')
    check.close()
    await ledger.close()
  })
})
