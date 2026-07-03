#!/usr/bin/env node

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import YAML from 'yaml'
import { createPrivilegeLedger } from '../bin/lib/spawn/privilege-ledger.mjs'

function tempLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-privilege-ledger-'))
  return path.join(dir, 'daemon-privileges.yaml')
}

describe('daemon privilege ledger', () => {
  it('defaults unknown agents to none without writing a row', () => {
    const file = tempLedger()
    const ledger = createPrivilegeLedger(file)
    const grant = ledger.grantFor({ id: 'fleet:unknown' }, {})

    assert.equal(grant.spawnPolicy.capability, 'none')
    assert.deepEqual(grant.privilegeSet.operations.write.allow, [])
    assert.deepEqual(grant.privilegeSet.operations.spawn.allow, [])
    assert.equal(fs.existsSync(file), false)
  })

  it('seeds configured roots and reloads spawned child grants from yaml', () => {
    const file = tempLedger()
    const ledger = createPrivilegeLedger(file)

    const root = ledger.grantFor({ id: 'fleet:skip', human: true }, {
      spawnPolicy: {
        rootCeilings: {
          'fleet:skip': {
            spawnPolicy: 'write',
            privilegeSet: {
              type: 'privilege-set',
              name: 'root-worktree',
              operations: {
                read: { allow: ['/private/tmp/worktree/**'], deny: [] },
                write: { allow: ['/private/tmp/worktree/**'], deny: [] },
                command: { allow: [], deny: [] },
                network: { allow: [], deny: [] },
              },
            },
          },
        },
      },
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
    assert.equal(parsed.agents['fleet:skip'].source, 'root-config')
    assert.equal(parsed.agents['fleet:child'].source, 'spawn')

    const reloaded = createPrivilegeLedger(file)
    const grant = reloaded.grantFor({ id: 'fleet:child' }, {})
    assert.equal(grant.spawnPolicy.capability, 'write')
    assert.deepEqual(grant.privilegeSet.operations.write.allow, ['/private/tmp/worktree/**'])
    assert.deepEqual(grant.privilegeSet.operations.spawn.allow, ['**'])
  })
})
