import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDaemonMintCore } from '../daemon/mint-core.mjs'
import { MintFactConflictError, MintStore } from '../daemon/mint-store.mjs'
import { createDaemonWakeCore } from '../daemon/wake-core.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-mint-core-'))
const store = new MintStore(path.join(dir, 'mint.sqlite'))
const events = []
let releaseProcess
let releaseSeat

const core = createDaemonMintCore({
  store,
  mintId: () => 'mint:test',
  launchProcess: async () => {
    events.push('process-start')
    await new Promise(resolve => { releaseProcess = resolve })
    return { session_id: 'session:test', tmux_session: 'fleet-test' }
  },
  requestSeat: async () => {
    events.push('seat-start')
    await new Promise(resolve => { releaseSeat = resolve })
    return { fleet_id: 'fleet:test', friendly_name: 'test' }
  },
  bindSeat: async facts => {
    events.push(`bind:${facts.fleetId}:${facts.sessionId}`)
  },
})

const pending = core.mint({ name: 'test', launch: { cwd: '/tmp' } })
await new Promise(resolve => setImmediate(resolve))
assert.deepEqual(events, ['process-start', 'seat-start'])
releaseSeat()
await new Promise(resolve => setImmediate(resolve))
assert.deepEqual(events, ['process-start', 'seat-start'])
assert.equal(store.get('mint:test').fleetId, 'fleet:test')
assert.equal(store.get('mint:test').sessionId, null)
releaseProcess()
const facts = await pending
assert.equal(facts.fleetId, 'fleet:test')
assert.equal(facts.sessionId, 'session:test')
assert.equal(events.filter(value => value.startsWith('bind:')).length, 1)

store.setFact('mint:test', 'fleet_id', 'fleet:test')
assert.throws(
  () => store.setFact('mint:test', 'fleet_id', 'fleet:other'),
  error => error instanceof MintFactConflictError && error.code === 'mint-fact-conflict',
)

const serverEvents = []
const serverCore = createDaemonMintCore({
  store,
  mintId: () => 'mint:server',
  launchProcess: async input => {
    serverEvents.push(`launch:${input.fleet_id}`)
    return { session_id: 'session:server', tmux_session: 'fleet-server' }
  },
  requestSeat: async () => {
    throw new Error('server mint must not request a second seat')
  },
  bindSeat: async facts => serverEvents.push(`bind:${facts.fleetId}:${facts.sessionId}`),
})
await serverCore.mint({ mint_id: 'mint:server', fleet_id: 'fleet:server', name: 'server' })
assert.deepEqual(serverEvents, ['launch:fleet:server', 'bind:fleet:server:session:server'])

const markerRaceEvents = []
const markerRaceCore = createDaemonMintCore({
  store,
  mintId: () => 'mint:marker-race',
  launchProcess: async () => ({ session_id: 'session:unused' }),
  requestSeat: async () => ({ fleet_id: 'fleet:unused' }),
  bindSeat: async facts => markerRaceEvents.push(`bind:${facts.fleetId}:${facts.sessionId}`),
})
store.ensure('mint:marker-race')
store.setFact('mint:marker-race', 'fleet_id', 'fleet:marker-race')
await markerRaceCore.recordSession('mint:marker-race', { session_id: 'session:marker-race' })
assert.deepEqual(markerRaceEvents, [])
await markerRaceCore.recordProcess('mint:marker-race', {
  session_id: 'session:marker-race',
  tmux_session: 'fleet-marker-race',
})
assert.deepEqual(markerRaceEvents, ['bind:fleet:marker-race:session:marker-race'])

let alive = true
const wake = createDaemonWakeCore({
  store,
  processAlive: async () => alive,
  resumeSession: async facts => ({ tmux_session: `resumed-${facts.sessionId}` }),
})
assert.equal((await wake('fleet:server')).alreadyAlive, true)
alive = false
const resumed = await wake('fleet:server')
assert.equal(resumed.resumed, true)
assert.equal(resumed.tmux_session, 'resumed-session:server')
assert.rejects(() => wake('fleet:missing'), /no daemon mint facts/)

store.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log('daemon mint core tests passed')
