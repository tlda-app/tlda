import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { launchDoctorYolo } from '../agent-launch/index.mjs'
import { createLocalAgentLedger } from '../agent-launch/local-agent-ledger.mjs'
import { resolveLoginFleetId } from '../daemon/mint-store.mjs'

function tempPaths() {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-doctor-yolo-launch-'))
  return {
    dir,
    localAgentLedgerPath: join(dir, 'fleet-daemon.db'),
    mintStorePath: join(dir, 'daemon-mints.sqlite'),
  }
}

function baseParams(paths, deps = {}) {
  return {
    name: 'yolo',
    cwd: paths.dir,
    kind: 'claude',
    model: 'test-model',
    localAgentId: 'local:doctor-yolo-launch-test',
    localAgentLedgerPath: paths.localAgentLedgerPath,
    mintStorePath: paths.mintStorePath,
    machineId: 'mini',
    activeEnvName: 'testing',
    _deps: {
      resolveApi: () => 'http://localhost:3000',
      uniqueSessionName: async () => 'fleet-yolo-test',
      spawnTmux: async () => true,
      ...deps,
    },
  }
}

test('doctor yolo binds the local mint to a fleet id when the server is reachable', async () => {
  const paths = tempPaths()
  try {
    const result = await launchDoctorYolo(baseParams(paths, {
      ensureServer: async () => true,
      wsMintShell: async options => {
        assert.equal(options.localAgentId, 'local:doctor-yolo-launch-test')
        assert.equal(options.name, 'yolo')
        assert.equal(options.tmuxSession, 'fleet-yolo-test')
        assert.equal(options.metadata.permissionGrant, 'doctor-yolo')
        return { ok: true, server_agent_id: 'fleet:doctor-yolo-launch-test', assigned_name: 'yolo' }
      },
    }))

    assert.equal(result.registrationDeferred, false)
    assert.equal(result.fleetId, 'fleet:doctor-yolo-launch-test')

    const ledger = createLocalAgentLedger(paths.localAgentLedgerPath)
    try {
      const row = ledger.get('local:doctor-yolo-launch-test')
      assert.equal(row.serverAgentId, 'fleet:doctor-yolo-launch-test')
      assert.equal(row.process.tmuxName, 'fleet-yolo-test')
    } finally {
      ledger.close()
    }
    assert.equal(
      resolveLoginFleetId({ mintId: 'local:doctor-yolo-launch-test', storeFile: paths.mintStorePath }),
      'fleet:doctor-yolo-launch-test',
    )
  } finally {
    rmSync(paths.dir, { recursive: true, force: true })
  }
})

test('doctor yolo leaves the local repair session usable when server binding fails', async () => {
  const paths = tempPaths()
  try {
    let wsMintCalled = false
    const result = await launchDoctorYolo(baseParams(paths, {
      ensureServer: async () => {
        throw new Error('server unreachable')
      },
      wsMintShell: async () => {
        wsMintCalled = true
        throw new Error('must not mint without a reachable server')
      },
    }))

    assert.equal(wsMintCalled, false)
    assert.equal(result.registrationDeferred, true)
    assert.equal(result.fleetId, null)
    assert.match(result.registrationError, /server unreachable/)

    const ledger = createLocalAgentLedger(paths.localAgentLedgerPath)
    try {
      const row = ledger.get('local:doctor-yolo-launch-test')
      assert.equal(row.serverAgentId, null)
      assert.equal(row.process.tmuxName, 'fleet-yolo-test')
    } finally {
      ledger.close()
    }
    assert.equal(
      resolveLoginFleetId({ mintId: 'local:doctor-yolo-launch-test', storeFile: paths.mintStorePath }),
      null,
    )
  } finally {
    rmSync(paths.dir, { recursive: true, force: true })
  }
})
