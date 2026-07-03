#!/usr/bin/env node

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import YAML from 'yaml'
import { createPrivilegeLedger, withDaemonModelAliases } from '../bin/lib/spawn/privilege-ledger.mjs'
import { resolveSpawnGrant } from '../server/lib/spawn-policy.mjs'

function tempLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-privilege-ledger-'))
  return path.join(dir, 'daemon-privileges.yaml')
}

describe('daemon privilege ledger', () => {
  it('refuses unknown agents without writing a row', () => {
    const file = tempLedger()
    const ledger = createPrivilegeLedger(file)

    assert.throws(
      () => ledger.grantFor({ id: 'fleet:unknown' }),
      (err) => err.code === 'SPAWN_PRIVILEGE_NO_LEDGER_ENTRY',
    )
    assert.equal(fs.existsSync(file), false)
  })

  it('writes and reloads grants from the daemon yaml privileges section', () => {
    const file = tempLedger()
    const ledger = createPrivilegeLedger(file)

    const root = ledger.set('fleet:skip', {
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

    const child = ledger.set('fleet:child', {
      spawnPolicy: root.spawnPolicy,
      privilegeSet: root.privilegeSet,
      source: 'spawn',
    })
    assert.equal(child.privilegeSet.name, 'root-worktree')

    const parsed = YAML.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(parsed.version, 1)
    assert.equal(parsed.privileges.agents['fleet:skip'].source, 'operator')
    assert.equal(parsed.privileges.agents['fleet:child'].source, 'spawn')

    const reloaded = createPrivilegeLedger(file)
    const grant = reloaded.grantFor({ id: 'fleet:child' })
    assert.equal(grant.spawnPolicy.capability, 'write')
    assert.deepEqual(grant.privilegeSet.operations.write.allow, ['/private/tmp/worktree/**'])
    assert.deepEqual(grant.privilegeSet.operations.spawn.allow, ['**'])
  })

  it('loads daemon model aliases from yaml separately from server config', () => {
    const file = tempLedger()
    fs.writeFileSync(file, YAML.stringify({
      version: 1,
      models: {
        claude: {
          localopus: 'claude-opus-local',
        },
      },
      privileges: {
        agents: {},
      },
    }))

    const ledger = createPrivilegeLedger(file)
    const config = withDaemonModelAliases({ defaultConfig: 'live', models: { claude: { stale: 'old' } } }, ledger.config)
    assert.deepEqual(config.models, { claude: { localopus: 'claude-opus-local' } })
  })

  it('maps flat daemon model rows to launch aliases and model caps', () => {
    const file = tempLedger()
    fs.writeFileSync(file, YAML.stringify({
      version: 1,
      models: {
        localgpt: {
          provider: 'codex',
          provider_model: 'gpt-local',
          cap: 'read',
        },
      },
      privileges: {
        agents: {
          'fleet:spawner': {
            spawnPolicy: 'full',
            privilegeSet: {
              type: 'privilege-set',
              name: 'spawner-full',
              operations: {
                read: { allow: ['**'], deny: [] },
                write: { allow: ['**'], deny: [] },
                spawn: { allow: ['**'], deny: [] },
              },
            },
          },
        },
      },
    }))

    const ledger = createPrivilegeLedger(file)
    const config = withDaemonModelAliases({}, ledger.config)
    assert.deepEqual(config.models.codex.localgpt, { id: 'gpt-local' })
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
  })
})
