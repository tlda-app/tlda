import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import Database from 'better-sqlite3'
import { FleetStore } from '../server/lib/fleet-store.mjs'
import { AgentSeatBindingObligations } from '../server/lib/agent-seat-binding-obligations.mjs'
import { summarizeFleetRosterTruth } from '../server/lib/fleet-roster-truth.mjs'
import { agentsForTerminalWatchResume } from '../server/lib/terminal-watch-resume.mjs'
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
  const legacyPath = path.join(dir, 'legacy-fleet.db')
  {
    const legacyDb = new Database(legacyPath)
    legacyDb.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        friendly_name TEXT,
        pretty_name TEXT,
        tmux_session TEXT,
        session_id TEXT,
        session_ids TEXT,
        cwd TEXT,
        labels TEXT,
        registered_at TEXT,
        last_seen TEXT,
        dead INTEGER DEFAULT 0,
        human INTEGER DEFAULT 0,
        is_manager INTEGER DEFAULT 0,
        metadata TEXT,
        machine_id TEXT,
        env_name TEXT,
        daemon_key TEXT,
        resume_id TEXT
      )
    `)
    legacyDb.close()
  }
  const legacyStore = new FleetStore(legacyPath, { taskDoc: false })
  assert(!legacyStore.db.prepare('PRAGMA table_info(agents)').all().map(col => col.name).includes('tmux_session'))
  legacyStore.close()

  store = new FleetStore(dbPath, { taskDoc: false })
  const agentCols = store.db.prepare('PRAGMA table_info(agents)').all().map(col => col.name)
  assert(!agentCols.includes('tmux_session'))

  const currentSeatCols = store.db.prepare('PRAGMA table_info(agent_current_seats)').all().map(col => col.name)
  assert(!currentSeatCols.includes('tmux_session'))
  assert(currentSeatCols.includes('terminal_capability'))

  const obligations = new AgentSeatBindingObligations(store.db)
  obligations.put({
    agent_id: 'fleet:status-authority-test',
    daemon_key: 'mini:prod',
    local_agent_id: 'local-status-authority-test',
    cwd: dir,
    kind: 'codex',
    model: 'gpt-test',
    friendly_name: 'status-authority-test',
    process_owned_only: true,
  })
  const obligationCols = store.db.prepare('PRAGMA table_info(agent_seat_binding_obligations)').all().map(col => col.name)
  assert(!obligationCols.includes('tmux_session'))
  assert(obligationCols.includes('local_agent_id'))

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

  assert.throws(() => store.activateAgentSeat({
    agentId: 'fleet:status-authority-test',
    machineId: 'mini',
    envName: 'prod',
    daemonKey: 'mini:prod',
    reason: 'daemon-agent-activity',
  }), /requires durable sessionId/)

  store.insertAgentSeat({
    agent_id: 'fleet:status-authority-test',
    session_id: 'rollout-status-authority-test',
    resume_id: 'rollout-status-authority-test',
    kind: 'codex',
    model: 'gpt-test',
    cwd: dir,
    created_source: 'status-authority-schema-test',
  })

  const route = store.activateAgentSeat({
    agentId: 'fleet:status-authority-test',
    sessionId: 'rollout-status-authority-test',
    machineId: 'mini',
    envName: 'prod',
    daemonKey: 'mini:prod',
    terminalCapability: 'termcap:status-authority-test',
    reason: 'daemon-agent-activity',
  })

  assert.equal(route.daemon_key, 'mini:prod')
  assert.equal(route.session_id, 'rollout-status-authority-test')
  assert.equal(route.terminal_capability, 'termcap:status-authority-test')
  assert(!Object.hasOwn(route, 'tmux_session'))

  const daemonRoster = store.getAgentsByDaemonKey('mini:prod')
  assert.equal(daemonRoster.length, 1)
  assert.equal(daemonRoster[0].id, 'fleet:status-authority-test')
  assert.equal(daemonRoster[0].daemon_key, 'mini:prod')

  const agent = store.getAgent('fleet:status-authority-test')
  assert(!Object.hasOwn(agent, 'tmux_session'))
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
  assert.deepEqual(awake.route, { daemon_key: 'mini:prod' })

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

  const missingCapability = projectAgentRuntimeStatus(agent, {
    liveness: LIVENESS.ALIVE,
    liveness_source: 'daemon-agent-liveness',
    liveness_at_ms: nowMs,
    liveness_at: new Date(nowMs).toISOString(),
    activity: 'tool_call:get_thread',
  }, {
    nowMs,
    seat: { ...route, terminal_capability: null },
    isDaemonConnected: key => key === 'mini:prod',
  })

  assert.equal(missingCapability.route_state, ROUTE_STATE.UNROUTABLE)
  assert.equal(missingCapability.route_reason, 'current-seat-missing-terminal-capability')

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

  const rosterSummary = summarizeFleetRosterTruth({
    roster: [{
      ...agent,
      runtime_status: activityDriven,
      metadata: { status: { state: 'tool_call', tool: 'inbox' } },
    }],
    matched: [{
      ...agent,
      runtime_status: activityDriven,
      metadata: { status: { state: 'tool_call', tool: 'inbox' } },
    }],
    machineSessions: { 'mini:prod': [] },
    now: nowMs,
  })
  assert.equal(rosterSummary.agents[0].daemon_key, 'mini:prod')

  store.upsertAgent({
    id: 'fleet:stale-legacy-route',
    friendly_name: 'stale-legacy-route',
    labels: [],
    registered_at: new Date(0).toISOString(),
    last_seen: new Date(0).toISOString(),
    dead: false,
    human: false,
    is_manager: false,
    metadata: { kind: 'codex', model: 'gpt-test' },
    machine_id: 'legacy',
    env_name: 'prod',
    daemon_key: 'legacy:prod',
    tmux_session: 'fleet-stale-legacy-route',
    session_id: 'rollout-stale-legacy-route',
  }, { allowProtectedAgentFields: true })

  const staleProjected = store.getAgent('fleet:stale-legacy-route')
  assert.equal(staleProjected.daemon_key, null)
  assert.equal(staleProjected.machine_id, null)
  assert.equal(staleProjected.env_name, null)
  assert(!Object.hasOwn(staleProjected, 'tmux_session'))
  assert.deepEqual(store.getAgentsByDaemonKey('legacy:prod'), [])

  const staleRosterSummary = summarizeFleetRosterTruth({
    roster: [{
      id: 'fleet:stale-legacy-route',
      friendly_name: 'stale-legacy-route',
      dead: false,
      human: false,
      machine_id: 'legacy',
      env_name: 'prod',
      daemon_key: 'legacy:prod',
      tmux_session: 'fleet-stale-legacy-route',
      metadata: {},
    }],
    matched: [{
      id: 'fleet:stale-legacy-route',
      friendly_name: 'stale-legacy-route',
      dead: false,
      human: false,
      machine_id: 'legacy',
      env_name: 'prod',
      daemon_key: 'legacy:prod',
      tmux_session: 'fleet-stale-legacy-route',
      metadata: {},
    }],
    machineSessions: { 'legacy:prod': ['fleet-stale-legacy-route'] },
    now: nowMs,
  })
  assert.equal(staleRosterSummary.agents[0].daemon_key, 'unassigned')
  assert(!Object.hasOwn(staleRosterSummary.agents[0], 'tmux_session'))
  assert.equal(staleRosterSummary.machines.find(m => m.machine_id === 'legacy:prod').registry.total, 0)

  const terminalResume = agentsForTerminalWatchResume({
    watchedAgentIds: ['fleet:stale-legacy-route', 'fleet:routed-watch'],
    daemonKey: 'mini:prod',
    getAgentsByIds: () => [
      {
        id: 'fleet:stale-legacy-route',
        daemon_key: 'mini:prod',
        tmux_session: 'fleet-stale-legacy-route',
      },
      {
        id: 'fleet:routed-watch',
        daemon_key: 'wrong:legacy',
        tmux_session: 'fleet-wrong-legacy-route',
      },
    ],
    getCurrentAgentSeat: id => id === 'fleet:routed-watch'
      ? {
          agent_id: id,
          daemon_key: 'mini:prod',
          session_id: 'rollout-routed-watch',
          terminal_capability: 'termcap:routed-watch',
        }
      : null,
  })
  assert.deepEqual(terminalResume.map(({ agent, seat }) => [agent.id, seat.terminal_capability]), [
    ['fleet:routed-watch', 'termcap:routed-watch'],
  ])

  console.log('ok: daemon-key route authority requires durable session identity')
} finally {
  store?.close?.()
  fs.rmSync(dir, { recursive: true, force: true })
}
