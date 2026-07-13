import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { findAgent, findLocalAgent } from '../agent-launch/register.mjs'
import { createPermissionLedger } from '../agent-launch/permission-ledger.mjs'

function permissionSet() {
  return {
    type: 'permission-set',
    name: 'ops',
    operations: {
      read: { allow: ['**'], deny: [] },
      write: { allow: ['**'], deny: [] },
      spawn: { allow: [], deny: [] },
    },
    rules: [],
    projectedPolicy: { name: 'ops', policy: 'unsandboxed' },
  }
}

test('findLocalAgent resolves same-box seats from the daemon ledger', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-find-local-agent-'))
  const ledger = createPermissionLedger(path.join(tmp, 'fleet-daemon.db'))
  try {
    ledger.setSync('fleet:mend', {
      spawnPolicy: { name: 'ops', policy: 'unsandboxed' },
      permissionSet: permissionSet(),
      source: 'test',
    })
    ledger.setSessionSync('fleet:mend', {
      sessionId: '11111111-2222-4333-8444-555555555555',
      sessionKind: 'codex',
      cwd: tmp,
      friendlyName: 'mend',
      lastSeen: '2026-07-13T05:00:00.000Z',
    })

    const byName = findLocalAgent('mend', { ledger })
    assert.equal(byName.id, 'fleet:mend')
    assert.equal(byName.tmux_session, 'fleet-mend')
    assert.equal(byName.metadata.kind, 'codex')
    assert.deepEqual(byName.metadata.spawnPolicy, { name: 'ops', policy: 'unsandboxed' })
    assert.deepEqual(byName.metadata.permissionSet, permissionSet())

    const byId = findLocalAgent('fleet:mend', { ledger })
    assert.equal(byId.id, 'fleet:mend')
  } finally {
    await ledger.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('findAgent treats missing local wake ledger state as an integrity failure', async () => {
  await assert.rejects(
    () => findAgent('missing-agent'),
    /local wake ledger has no record/,
  )
})
