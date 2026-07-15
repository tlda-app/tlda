import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { spawn } from '../agent-launch/index.mjs'
import { createLocalAgentLedger } from '../agent-launch/local-agent-ledger.mjs'
import { FleetStore } from '../server/lib/fleet-store.mjs'

const config = {
  modelSpecs: {
    gpt: {
      alias: 'gpt',
      id: 'gpt-5.5',
      provider: 'codex',
      harness: 'codex',
      harnessOptions: { required: [], preferences: [], controls: false },
    },
  },
}

test('shared fresh mint launches locally without a server id and persists its recipe', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-offline-mint-'))
  const ledgerFile = path.join(dir, 'fleet-daemon.db')
  let command = null
  try {
    const result = await spawn({
      spawnMode: 'fresh',
      name: 'offline-test',
      model: 'gpt',
      config,
      cwd: dir,
      breakGlass: true,
      acknowledgeNoSecurity: true,
      explicitPolicy: true,
      localAgentLedgerPath: ledgerFile,
      _deps: {
        resolveApi: () => 'https://unavailable.example',
        ensureServer: async () => false,
        uniqueSessionName: async () => 'fleet-offline-test',
        resolveDnsAlias: async () => null,
        spawnTmux: async (_tmux, _cwd, cmd) => { command = cmd; return true },
      },
    })
    assert.match(result.localAgentId, /^local:/)
    assert.equal(result.fleetId, null)
    assert.equal(result.registrationDeferred, true)
    assert.match(command, new RegExp(`FLEET_LOCAL_ID='${result.localAgentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`))
    assert.doesNotMatch(command, /FLEET_ID=/)

    const ledger = createLocalAgentLedger(ledgerFile)
    try {
      const stored = ledger.get(result.localAgentId)
      assert.equal(stored.serverAgentId, null)
      assert.equal(stored.process.tmuxName, 'fleet-offline-test')
      assert.equal(stored.process.cwd, dir)
      assert.equal(stored.conversation.harness, 'codex')
    } finally { ledger.close() }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('server daemon binding is immutable and idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-server-binding-'))
  const store = new FleetStore(path.join(dir, 'fleet.db'), { taskDoc: false })
  try {
    const first = store.bindDaemonAgent({ daemonKey: 'air:live', localAgentId: 'local:one', agentId: 'fleet:one' })
    assert.equal(first.agent_id, 'fleet:one')
    assert.equal(store.bindDaemonAgent({ daemonKey: 'air:live', localAgentId: 'local:one', agentId: 'fleet:one' }).agent_id, 'fleet:one')
    assert.throws(() => store.bindDaemonAgent({ daemonKey: 'air:live', localAgentId: 'local:one', agentId: 'fleet:two' }), /already bound/)
    assert.throws(() => store.bindDaemonAgent({ daemonKey: 'mini:live', localAgentId: 'local:two', agentId: 'fleet:one' }), /already bound/)
  } finally {
    store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
