import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  DAEMON_EVENT_ROUTE_FAMILIES,
  currentSeatForDaemonEvent,
} from '../server/lib/daemon-event-route-authority.mjs'

const matchingSeat = Object.freeze({
  agent_id: 'fleet:daemon-route-test',
  daemon_key: 'mini:prod',
  session_id: 'rollout-daemon-route-test',
  tmux_session: 'fleet-daemon-route-test',
})

for (const family of DAEMON_EVENT_ROUTE_FAMILIES) {
  let activated = false
  const noSeatStore = {
    getCurrentAgentSeat(agentId) {
      assert.equal(agentId, 'fleet:daemon-route-test')
      return null
    },
    activateAgentSeat() {
      activated = true
      throw new Error('daemon event must not activate a current seat')
    },
  }
  assert.equal(currentSeatForDaemonEvent(noSeatStore, {
    agentId: 'fleet:daemon-route-test',
    daemonKey: 'mini:prod',
    family,
    log: null,
  }), null)
  assert.equal(activated, false, `${family} activated a missing current seat`)

  const wrongDaemonStore = {
    getCurrentAgentSeat(agentId) {
      assert.equal(agentId, 'fleet:daemon-route-test')
      return { ...matchingSeat, daemon_key: 'air:prod' }
    },
    activateAgentSeat() {
      activated = true
      throw new Error('daemon event must not switch a current seat')
    },
  }
  assert.equal(currentSeatForDaemonEvent(wrongDaemonStore, {
    agentId: 'fleet:daemon-route-test',
    daemonKey: 'mini:prod',
    family,
    log: null,
  }), null)
  assert.equal(activated, false, `${family} switched a current seat`)

  const matchingStore = {
    getCurrentAgentSeat(agentId) {
      assert.equal(agentId, 'fleet:daemon-route-test')
      return matchingSeat
    },
    activateAgentSeat() {
      activated = true
      throw new Error('daemon event must not activate when a seat already matches')
    },
  }
  assert.equal(currentSeatForDaemonEvent(matchingStore, {
    agentId: 'fleet:daemon-route-test',
    daemonKey: 'mini:prod',
    family,
    log: null,
  }), matchingSeat)
  assert.equal(activated, false, `${family} activated despite a matching current seat`)
}

const serverSource = fs.readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')
const fleetStoreSource = fs.readFileSync(new URL('../server/lib/fleet-store.mjs', import.meta.url), 'utf8')
const handlerStart = serverSource.indexOf('async function handleDaemonWsMessage')
assert.notEqual(handlerStart, -1, 'handleDaemonWsMessage source not found')
const nextHandlerStart = serverSource.indexOf('\nasync function ', handlerStart + 1)
const handlerSource = serverSource.slice(handlerStart, nextHandlerStart === -1 ? undefined : nextHandlerStart)

assert.equal(handlerSource.includes('ensureDaemonEventRoute'), false, 'daemon handler still references ensureDaemonEventRoute')
assert.equal(handlerSource.includes('activateAgentSeat'), false, 'daemon handler must not activate seats from daemon events')

function assertOrdered(haystack, needles, label) {
  let cursor = -1
  for (const needle of needles) {
    const index = haystack.indexOf(needle, cursor + 1)
    assert.notEqual(index, -1, `${label}: missing ${needle}`)
    assert.ok(index > cursor, `${label}: ${needle} is out of order`)
    cursor = index
  }
}

function branchSource(typeLiteral) {
  const startNeedle = `if (type === '${typeLiteral}')`
  const start = handlerSource.indexOf(startNeedle)
  assert.notEqual(start, -1, `branch ${typeLiteral} not found`)
  const next = handlerSource.indexOf('\n  if (type === ', start + startNeedle.length)
  return handlerSource.slice(start, next === -1 ? undefined : next)
}

const statusBranch = branchSource('agent-status')
assertOrdered(statusBranch, [
  'daemonEventSeatDecision(fleetStore',
  "family: 'daemon-agent-status'",
  'if (isForeignDaemonRejection(statusSeat)) return',
  'fleetStore.updateAgentStatus',
  'runtimeStatusStore.updateActivity',
], 'agent-status branch')

// The 378-agent batch branch is gone; the daemon now sends a complete
// running-process snapshot and the server replaces its list. The ownership rule
// survives the change: a daemon may only report agents seated on it, enforced
// here by matching the seat's daemon_key before anything is marked alive.
const snapshotBranch = branchSource('agent-liveness-snapshot')
assertOrdered(snapshotBranch, [
  'fleetStore.getCurrentAgentSeats(reported)',
  'seats.get(id)?.daemon_key === ws._daemonKey',
  'markAgentAlive',
  'markAgentNotAlive',
  'daemonRunningAgents.set(ws._daemonKey, running)',
], 'agent-liveness-snapshot branch')
assert.equal(
  snapshotBranch.includes('retireCurrentAgentSeat'),
  false,
  'agent-liveness-snapshot must not retire the durable current seat',
)

const livenessBranch = branchSource('agent-liveness')
assertOrdered(livenessBranch, [
  'daemonEventSeatDecision(fleetStore',
  "family: 'daemon-agent-liveness'",
  'if (isForeignDaemonRejection(livenessSeat)) return',
  'spawnLibrarian.observeLiveness',
  'markAgentAlive',
  'markAgentNotAlive',
], 'agent-liveness single branch')
assert.equal(
  livenessBranch.includes('retireCurrentAgentSeat'),
  false,
  'agent-liveness must not retire the durable current seat',
)

const allLivenessRouteCode = `${snapshotBranch}\n${livenessBranch}`
assert.equal(
  allLivenessRouteCode.includes('retireCurrentAgentSeat'),
  false,
  'no liveness path may retire the durable current seat',
)

const markDeadMethod = (() => {
  const start = fleetStoreSource.indexOf('\n  markDead(id) {')
  assert.notEqual(start, -1, 'markDead method not found')
  const end = fleetStoreSource.indexOf('\n  markAlive(id) {', start)
  assert.notEqual(end, -1, 'markAlive method not found after markDead')
  return fleetStoreSource.slice(start, end)
})()
assert(
  markDeadMethod.includes('_deleteCurrentAgentSeat'),
  'explicit markDead must still retire the durable current seat',
)

const activityBranch = branchSource('agent-activity')
assertOrdered(activityBranch, [
  'currentSeatForDaemonEvent(fleetStore',
  "family: 'daemon-agent-activity'",
  'if (!currentSeat) return',
  'spawnLibrarian.observeActivity',
  'markAgentAlive',
  'fleetStore.updateHeartbeat',
], 'agent-activity branch')

const activityEventBranch = branchSource('activity-event')
assertOrdered(activityEventBranch, [
  'daemonEventSeatDecision(fleetStore',
  "family: 'daemon-activity-event'",
  'if (isForeignDaemonRejection(seatDecision))',
  'markAgentAlive',
  'runtimeStatusStore.updateActivity',
  'serverActivityDeliveryCounters.record',
  'fleetStore.share',
], 'activity-event branch')
