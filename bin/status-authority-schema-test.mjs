import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { FleetStore } from '../server/lib/fleet-store.mjs'
import {
  LIVENESS,
  RUNTIME_STATUS,
  ROUTE_STATE,
  projectAgentRuntimeStatus,
} from '../server/lib/agent-runtime-status.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-status-authority-'))
const dbPath = path.join(dir, 'fleet.db')
let store = null

try {
  store = new FleetStore(dbPath, { taskDoc: false })
  store.upsertAgent({
    id: 'fleet:status-authority-test',
    friendly_name: 'status-authority-test',
    labels: [],
    registered_at: new Date(0).toISOString(),
    last_seen: new Date(0).toISOString(),
    dead: false,
    human: false,
    is_manager: false,
    metadata: { kind: 'codex', model: 'gpt-test' },
  })

  const route = store.activateAgentSeat({
    agentId: 'fleet:status-authority-test',
    machineId: 'mini',
    envName: 'prod',
    daemonKey: 'mini:prod',
    reason: 'daemon-agent-activity',
  })

  assert.equal(route.daemon_key, 'mini:prod')
  assert.equal(route.session_id, null)
  assert.equal(route.tmux_session, null)

  const agent = store.getAgent('fleet:status-authority-test')
  const nowMs = Date.now()
  const awake = projectAgentRuntimeStatus(agent, {
    liveness: LIVENESS.ALIVE,
    liveness_source: 'daemon-agent-liveness',
    liveness_at_ms: nowMs,
    liveness_at: new Date(nowMs).toISOString(),
    activity: 'tool_call:get_thread',
  }, {
    nowMs,
    seat: route,
    isDaemonConnected: key => key === 'mini:prod',
  })

  assert.equal(awake.route_state, ROUTE_STATE.ROUTABLE)
  assert.equal(awake.status, RUNTIME_STATUS.AWAKE)

  const unresolved = projectAgentRuntimeStatus(agent, null, {
    nowMs,
    seat: route,
    isDaemonConnected: key => key === 'mini:prod',
  })

  assert.equal(unresolved.route_state, ROUTE_STATE.ROUTABLE)
  assert.equal(unresolved.status, RUNTIME_STATUS.UNAVAILABLE)
  assert.notEqual(unresolved.status, RUNTIME_STATUS.HIBERNATING)

  const daemonMissing = projectAgentRuntimeStatus(agent, null, {
    nowMs,
    seat: route,
    isDaemonConnected: () => false,
  })

  assert.equal(daemonMissing.route_state, ROUTE_STATE.DAEMON_DISCONNECTED)
  assert.equal(daemonMissing.status, RUNTIME_STATUS.UNAVAILABLE)
  assert.notEqual(daemonMissing.status, RUNTIME_STATUS.HIBERNATING)

  const activityDriven = projectAgentRuntimeStatus(agent, {
    liveness: LIVENESS.ALIVE,
    liveness_source: 'daemon-activity-event',
    liveness_at_ms: nowMs,
    liveness_at: new Date(nowMs).toISOString(),
    activity: 'tool_call:inbox',
    activity_tool: 'inbox',
  }, {
    nowMs,
    seat: route,
    isDaemonConnected: key => key === 'mini:prod',
  })

  assert.equal(activityDriven.status, RUNTIME_STATUS.AWAKE)
  assert.equal(activityDriven.activity, 'tool_call:inbox')

  console.log('ok: daemon-key route authority does not require session/tmux fields')
} finally {
  store?.close?.()
  fs.rmSync(dir, { recursive: true, force: true })
}
