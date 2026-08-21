import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createAgentRuntimeStatusStore, RUNTIME_STATUS } from '../server/lib/agent-runtime-status.mjs'
import { FleetStore } from '../server/lib/fleet-store.mjs'
import { summarizeFleetRosterTruth } from '../server/lib/fleet-roster-truth.mjs'

const agent = {
  id: 'fleet:live-without-server-seat',
  friendly_name: 'live-without-server-seat',
  dead: false,
  human: false,
  metadata: {},
  seat_present: false,
}
let now = Date.parse('2026-07-28T18:00:00.000Z')
const runtime = createAgentRuntimeStatusStore({
  now: () => now,
  isDaemonConnected: () => false,
})

runtime.markAlive(agent.id, 'daemon-activity-event', { atMs: now, daemon_key: 'mini:testing' })
now += 60 * 60 * 1000
const projectedAlive = { ...agent, runtime_status: runtime.project(agent) }
assert.equal(projectedAlive.runtime_status.status, RUNTIME_STATUS.AWAKE)
assert.equal(projectedAlive.runtime_status.route_state, 'seat-missing')
assert.equal(projectedAlive.runtime_status.reason, 'daemon-activity-event')
assert.deepEqual(summarizeFleetRosterTruth({
  roster: [projectedAlive],
  matched: [projectedAlive],
  now,
}).totals, {
  awake: 1,
  hibernating: 0,
  dead: 0,
  total: 1,
})

runtime.markNotAlive(agent.id, 'daemon-running-process-snapshot', {
  atMs: now,
  reason: 'absent from daemon running-process snapshot',
})
assert.equal(runtime.project(agent).status, RUNTIME_STATUS.HIBERNATING)
runtime.markAlive(agent.id, 'historical-activity-replay', { atMs: now - 1 })
assert.equal(runtime.project(agent).status, RUNTIME_STATUS.HIBERNATING)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-status-liveness-authority-'))
const store = new FleetStore(path.join(dir, 'fleet.db'), { taskDoc: false })
try {
  await store.upsertAgent(agent)
  assert.deepEqual(await store.getAliveAgentCounts({ liveEvidenceIds: [agent.id], nowMs: now }), {
    awake: 1,
    hibernating: 0,
    total: 1,
  })
  assert.deepEqual(await store.getAliveAgentCounts({ liveEvidenceIds: [], nowMs: now }), {
    awake: 0,
    hibernating: 1,
    total: 1,
  })
} finally {
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
}

const serverSource = fs.readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')
const handlerStart = serverSource.indexOf('async function handleDaemonWsMessage')
const handlerEnd = serverSource.indexOf('\nasync function ', handlerStart + 1)
const handler = serverSource.slice(handlerStart, handlerEnd === -1 ? undefined : handlerEnd)

for (const type of ['agent-status', 'agent-liveness-snapshot', 'agent-liveness', 'agent-activity', 'activity-event']) {
  const start = handler.indexOf(`if (type === '${type}')`)
  assert.notEqual(start, -1, `${type} branch missing`)
  const end = handler.indexOf('\n  if (type === ', start + 1)
  const branch = handler.slice(start, end === -1 ? undefined : end)
  assert.equal(branch.includes('getCurrentAgentSeat'), false, `${type} still reads current seats`)
  assert.equal(branch.includes('daemonEventSeatDecision'), false, `${type} still reconciles through current seats`)
}

const snapshotStart = handler.indexOf("if (type === 'agent-liveness-snapshot')")
const snapshotEnd = handler.indexOf('\n  if (type === ', snapshotStart + 1)
const snapshot = handler.slice(snapshotStart, snapshotEnd)
assert(snapshot.includes('msg.daemon_key !== ws._daemonKey'))
assert(snapshot.includes('msg.daemon_boot_id !== ws._bootId'))
