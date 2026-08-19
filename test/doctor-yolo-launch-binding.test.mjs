import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { launchDoctorYolo } from '../agent-launch/index.mjs'
import { createLocalAgentLedger } from '../agent-launch/local-agent-ledger.mjs'
import { MintStore, resolveLoginFleetId } from '../daemon/mint-store.mjs'
import { activeEnvName } from '../agent-launch/identity.mjs'
import { getMachineId } from '../shared/config.mjs'

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

// The route home, in the launched process's own environment. Every harness emits
// FLEET_DAEMON_KEY from TLDA_MACHINE_ID + TLDA_ENV, and the server writes an
// agent's daemon route from the key its login carries — so an agent launched
// without these logs in routeless and nothing can wake it or deliver to it.
// `launchDoctorYolo` resolved both and then handed `params` to the environment
// builder, which sets them only when the CALLER passed them; `tlda doctor yolo`
// never does. Assert on the command text, because that is what tmux runs.
test('doctor yolo puts the daemon key in the launched process environment', async () => {
  const paths = tempPaths()
  try {
    let cmd = null
    const params = baseParams(paths, {
      ensureServer: async () => true,
      wsMintShell: async () => ({ ok: true, server_agent_id: 'fleet:doctor-yolo-route', assigned_name: 'yolo' }),
      spawnTmux: async (_session, _cwd, command) => { cmd = command; return true },
    })
    // The caller states neither, exactly as the CLI does not — and neither is in
    // the inherited environment. That combination is the one that failed: what
    // made break-glass agents look routable anyway is that the environment
    // builder copies process.env, so one launched from another agent's shell
    // inherited that agent's daemon key by accident. Removing them here is what
    // makes this test discriminate rather than re-observe the accident.
    delete params.machineId
    delete params.activeEnvName
    const priorMachineId = process.env.TLDA_MACHINE_ID
    const priorEnvName = process.env.TLDA_ENV
    delete process.env.TLDA_MACHINE_ID
    delete process.env.TLDA_ENV
    let expected
    try {
      const machineId = getMachineId()
      if (!machineId) return // no daemon.yaml on this box; nothing to resolve against
      expected = `${machineId}:${activeEnvName()}`
      await launchDoctorYolo(params)
    } finally {
      if (priorMachineId === undefined) delete process.env.TLDA_MACHINE_ID
      else process.env.TLDA_MACHINE_ID = priorMachineId
      if (priorEnvName === undefined) delete process.env.TLDA_ENV
      else process.env.TLDA_ENV = priorEnvName
    }
    assert.ok(cmd.includes(`FLEET_DAEMON_KEY='${expected}'`),
      `launched command carries no daemon key: expected FLEET_DAEMON_KEY='${expected}'`)
  } finally {
    rmSync(paths.dir, { recursive: true, force: true })
  }
})

// The break-glass agent has to be findable afterwards or it is not an agent, it
// is a process. `getByFriendlyName` filters on the `env_name` COLUMN, which this
// path recorded in `metadata` and nowhere else — so `tlda agent wake <name>`
// answered "no local mint recorded" for beings that had joined and had a fleet
// id. Assert through `resolve`, which is the lookup wake actually performs.
test('doctor yolo records a mint that resolves by name afterwards', async () => {
  const paths = tempPaths()
  try {
    await launchDoctorYolo(baseParams(paths, {
      ensureServer: async () => true,
      wsMintShell: async () => ({ ok: true, server_agent_id: 'fleet:doctor-yolo-resolvable', assigned_name: 'yolo' }),
    }))
    const store = new MintStore(paths.mintStorePath, { defaultEnvName: 'testing' })
    try {
      const found = store.resolve('yolo', { envName: 'testing' })
      assert.equal(found?.mintId, 'local:doctor-yolo-launch-test')
      assert.equal(found?.fleetId, 'fleet:doctor-yolo-resolvable')
      assert.equal(store.get('local:doctor-yolo-launch-test').envName, 'testing')
    } finally {
      store.close()
    }
  } finally {
    rmSync(paths.dir, { recursive: true, force: true })
  }
})

// Skip, 2026-08-19: "Doctor YOLO should not be deleted. It should be made
// fucking like, item potent and fucking try to finish, like, the rest of the
// shit." Asked twice, it launches once — and the second call still re-records
// the facts, so a repeat of the command repairs the record rather than making a
// second process nobody can tell from the first.
test('doctor yolo asked twice for a running name launches once', async () => {
  const paths = tempPaths()
  try {
    let launches = 0
    const deps = {
      ensureServer: async () => true,
      wsMintShell: async () => ({ ok: true, server_agent_id: 'fleet:doctor-yolo-idempotent', assigned_name: 'yolo' }),
      spawnTmux: async () => { launches++; return true },
      // The session the first call created is live when the second call asks.
      sessionRuntimeState: async () => ({ runtime: true }),
    }
    const first = await launchDoctorYolo(baseParams(paths, deps))
    assert.equal(first.reused, undefined)
    assert.equal(launches, 1)

    const second = await launchDoctorYolo(baseParams(paths, deps))
    assert.equal(second.reused, true)
    assert.equal(launches, 1, 'the second call must not start a second process')
    assert.equal(second.fleetId, first.fleetId)
    assert.equal(second.tmuxSession, first.tmuxSession)
  } finally {
    rmSync(paths.dir, { recursive: true, force: true })
  }
})

// The counterfactual for the test above: idempotence is keyed on a LIVE session,
// not on the presence of a record. A recorded mint whose process is gone is an
// agent to start again, and reporting it as running would be the failure this
// command exists to repair.
test('doctor yolo relaunches when the recorded session is gone', async () => {
  const paths = tempPaths()
  try {
    let launches = 0
    const deps = {
      ensureServer: async () => true,
      wsMintShell: async () => ({ ok: true, server_agent_id: 'fleet:doctor-yolo-dead-session', assigned_name: 'yolo' }),
      spawnTmux: async () => { launches++; return true },
      sessionRuntimeState: async () => ({ runtime: false }),
    }
    await launchDoctorYolo(baseParams(paths, deps))
    const second = await launchDoctorYolo(baseParams(paths, deps))
    assert.equal(second.reused, undefined)
    assert.equal(launches, 2)
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
