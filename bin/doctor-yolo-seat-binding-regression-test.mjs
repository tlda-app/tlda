#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { bindDoctorYoloDurableSeat, cleanupFailedFreshBinding } from '../cli/tlda.mjs'
import { createLocalAgentLedger } from '../agent-launch/local-agent-ledger.mjs'

function createLedger() {
  const rows = new Map()
  return {
    rows,
    get(id) {
      const row = rows.get(id)
      return row && !row.dead ? row : null
    },
    grantFor(agent) {
      assert.equal(agent.id, 'localhost')
      return {
        permissionGrant: 'ops',
        permissionGrant: 'ops',
        permissionSet: {
          operations: {
            read: { allow: ['**'], deny: [] },
            write: { allow: ['**'], deny: [] },
          },
        },
      }
    },
    setSync(id, row) {
      rows.set(id, { id, ...row })
      return rows.get(id)
    },
    async markDead(id) {
      const row = rows.get(id)
      if (row) rows.set(id, { ...row, dead: 1 })
    },
    async close() {
    },
  }
}

async function testThrownBindingRunsFullFreshCleanupAndReleasesSeededGrant() {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-doctor-yolo-seat-binding-'))
  const localAgentLedgerPath = join(dir, 'local-agents.db')
  const localAgentLedger = createLocalAgentLedger(localAgentLedgerPath)
  const ledger = createLedger()
  const launched = {
    fleetId: 'fleet:doctor-yolo-test',
    localAgentId: 'local:doctor-yolo-test',
    tmuxSession: 'fleet-doctor-yolo-test',
    harness: 'codex',
  }
  localAgentLedger.create({
    localAgentId: launched.localAgentId,
    serverAgentId: launched.fleetId,
    friendlyName: 'doctor-yolo-test',
    sessionId: 'doctor-yolo-session',
    harness: 'codex',
    model: 'gpt-5',
    tmuxName: launched.tmuxSession,
    cwd: '/tmp/tlda-doctor-yolo-test',
    permissionGrant: 'ops',
  })
  localAgentLedger.close()
  const effects = {
    runtimeTerminated: false,
    serverMarkedDead: false,
  }
  const apiCalls = []

  await assert.rejects(
    bindDoctorYoloDurableSeat(launched, {
      cwd: '/tmp/tlda-doctor-yolo-test',
      name: 'doctor-yolo-test',
      api: async (method, pathname, body = null) => {
        apiCalls.push({ method, pathname, body })
        if (method === 'POST' && pathname === '/api/agents/fleet%3Adoctor-yolo-test/mark-dead') {
          effects.serverMarkedDead = true
        }
        return { ok: true }
      },
      daemonConfig: {},
      ledger,
      bindLifecycleImpl: async () => {
        throw new Error('injected readback failure')
      },
      cleanupFailedBindingImpl: async (result, { api }) => cleanupFailedFreshBinding(result, {
        api,
        localAgentLedgerPath,
        terminateImpl: async (tmuxSession) => {
          assert.equal(tmuxSession, launched.tmuxSession)
          effects.runtimeTerminated = true
          return true
        },
      }),
    }),
    /injected readback failure/,
  )

  assert.equal(effects.runtimeTerminated, true, 'thrown bind/readback failure must terminate the launched runtime')
  const readbackLedger = createLocalAgentLedger(localAgentLedgerPath)
  try {
    assert.equal(readbackLedger.get(launched.localAgentId), null, 'thrown bind/readback failure must release the active local ledger row')
    assert.equal(readbackLedger.db.prepare('SELECT dead FROM local_agents WHERE local_agent_id = ?').get(launched.localAgentId)?.dead, 1,
      'thrown bind/readback failure must retain the local ledger row marked dead')
    assert.deepEqual(readbackLedger.db.prepare('SELECT session_id, harness, model FROM local_agent_conversations WHERE local_agent_id = ?').get(launched.localAgentId), {
      session_id: 'doctor-yolo-session',
      harness: 'codex',
      model: 'gpt-5',
    }, 'thrown bind/readback failure must retain the conversation')
    assert.deepEqual(readbackLedger.db.prepare('SELECT tmux_name, cwd, permission_grant FROM local_agent_process_recipes WHERE local_agent_id = ?').get(launched.localAgentId), {
      tmux_name: launched.tmuxSession,
      cwd: '/tmp/tlda-doctor-yolo-test',
      permission_grant: '"ops"',
    }, 'thrown bind/readback failure must retain the process recipe')
  } finally {
    readbackLedger.close()
    rmSync(dir, { recursive: true, force: true })
  }
  assert.equal(effects.serverMarkedDead, true, 'thrown bind/readback failure must mark the server row dead')
  assert.equal(ledger.get(launched.fleetId), null, 'doctor-yolo seeded grant must be released after failed binding')
  assert.equal(ledger.rows.get(launched.fleetId)?.dead, 1, 'doctor-yolo seeded grant must be retained and marked dead')
  assert.deepEqual(apiCalls.map(call => `${call.method} ${call.pathname}`), ['POST /api/agents/fleet%3Adoctor-yolo-test/mark-dead'])
}

async function testExistingGrantIsPreservedOnFailedBinding() {
  const ledger = createLedger()
  const fleetId = 'fleet:doctor-yolo-existing-grant'
  ledger.setSync(fleetId, {
    permissionGrant: 'existing',
    source: 'pre-existing-test-grant',
  })

  await assert.rejects(
    bindDoctorYoloDurableSeat({
      fleetId,
      localAgentId: 'local:doctor-yolo-existing-grant',
      tmuxSession: 'fleet-doctor-yolo-existing-grant',
      harness: 'codex',
    }, {
      cwd: '/tmp/tlda-doctor-yolo-test',
      name: 'doctor-yolo-existing-grant',
      api: async () => ({ ok: true }),
      daemonConfig: {},
      ledger,
      bindLifecycleImpl: async () => {
        throw new Error('injected submit failure')
      },
      cleanupFailedBindingImpl: async () => ({ terminated: true }),
    }),
    /injected submit failure/,
  )

  assert.equal(ledger.get(fleetId)?.source, 'pre-existing-test-grant', 'pre-existing grants must not be deleted')
}

await testThrownBindingRunsFullFreshCleanupAndReleasesSeededGrant()
await testExistingGrantIsPreservedOnFailedBinding()

console.log('doctor yolo seat binding behavioral regression tests passed')
