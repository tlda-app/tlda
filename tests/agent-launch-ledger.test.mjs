import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createAgentLauncher } from '../agent-launch/agent-launch.mjs'
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

test('daemon launcher writes fresh-spawn ledger row before starting seat', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-agent-launch-ledger-'))
  const ledger = createPermissionLedger(path.join(tmp, 'fleet-daemon.db'))
  try {
    ledger.setSync('fleet:requester', {
      spawnPolicy: { name: 'ops', policy: 'unsandboxed' },
      permissionSet: permissionSet(),
      source: 'test-requester',
    })

    let observedPrelaunchGrant = null
    const launcher = createAgentLauncher({
      activeConfigName: 'test',
      configDir: tmp,
      loadConfig: () => ({
        spawnPolicy: {
          permissionProfiles: {
            ops: permissionSet(),
          },
          defaultProfile: 'ops',
        },
      }),
      log: { info() {}, warn() {}, error() {} },
      machineId: 'test-machine',
      permissionLedger: ledger,
      sendMsg: () => true,
      getProjects: () => [],
      tmux: async () => true,
      startupFailureProbeMs: 1,
      spawnImpl: async (params) => {
        observedPrelaunchGrant = ledger.get(params.agentId)
        return {
          ok: true,
          fleetId: params.agentId,
          tmuxSession: 'fleet-fresh-ledger',
          harness: 'codex',
          model: params.model,
          pending: true,
        }
      },
    })

    const result = await launcher.handlers.spawn({
      name: 'fresh-ledger',
      model: 'gpt-5.5',
      kind: 'codex',
      cwd: tmp,
      requester: { id: 'fleet:requester', name: 'requester' },
    })

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.ok(result.agent_id?.startsWith('fleet:'), 'fresh spawn should preallocate a fleet id')
    assert.equal(observedPrelaunchGrant?.id, result.agent_id)
    assert.equal(observedPrelaunchGrant?.source, 'spawn')
    assert.deepEqual(observedPrelaunchGrant?.spawnPolicy, { name: 'unsandboxed', policy: 'unsandboxed' })
    assert.deepEqual(ledger.get(result.agent_id)?.spawnPolicy, { name: 'unsandboxed', policy: 'unsandboxed' })
  } finally {
    await ledger.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('session identity recording does not fabricate an empty permission grant', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-agent-launch-session-ledger-'))
  const ledger = createPermissionLedger(path.join(tmp, 'fleet-daemon.db'))
  try {
    const result = ledger.setSessionSync('fleet:no-grant-yet', {
      sessionId: 'session-without-grant',
      sessionKind: 'codex',
      cwd: tmp,
      friendlyName: 'no-grant-yet',
    })

    assert.equal(result, null)
    assert.equal(ledger.get('fleet:no-grant-yet'), null)
  } finally {
    await ledger.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
