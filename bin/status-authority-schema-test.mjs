import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import Database from 'better-sqlite3'
import { FleetStore } from '../server/lib/fleet-store.mjs'
import { AgentSeatBindingObligations } from '../server/lib/agent-seat-binding-obligations.mjs'
import { filteredFleetRosterPage } from '../server/routes/fleet.mjs'
import { summarizeFleetRosterTruth } from '../server/lib/fleet-roster-truth.mjs'
import { agentsForTerminalWatchResume } from '../server/lib/terminal-watch-resume.mjs'
import { evalExpr, labelsForAgent, parseFilter } from '../shared/fleet-labels.mjs'
import {
  LIVENESS,
  RUNTIME_STATUS,
  ROUTE_STATE,
  projectAgentRuntimeStatus,
} from '../server/lib/agent-runtime-status.mjs'
import {
  ACTIVITY_HEALTH_BOUNDARIES,
  ACTIVITY_HEALTH_UNAVAILABLE,
} from '../shared/activity-health.mjs'
import { fleetRosterCategory } from '../shared/fleet-runtime-status.mjs'

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
      metadata: {
        status: { state: 'tool_call', tool: 'inbox' },
        activityHealth: {
          state: ACTIVITY_HEALTH_UNAVAILABLE,
          boundary: ACTIVITY_HEALTH_BOUNDARIES.NO_TMUX,
          ts: new Date(nowMs - 60_000).toISOString(),
          lastKnownGoodAt: new Date(nowMs - 60_000).toISOString(),
        },
      },
    }],
    matched: [{
      ...agent,
      runtime_status: activityDriven,
      metadata: {
        status: { state: 'tool_call', tool: 'inbox' },
        activityHealth: {
          state: ACTIVITY_HEALTH_UNAVAILABLE,
          boundary: ACTIVITY_HEALTH_BOUNDARIES.NO_TMUX,
          ts: new Date(nowMs - 60_000).toISOString(),
          lastKnownGoodAt: new Date(nowMs - 60_000).toISOString(),
        },
      },
    }],
    machineSessions: { 'mini:prod': [] },
    now: nowMs,
  })
  assert.equal(rosterSummary.agents[0].daemon_key, 'mini:prod')
  assert.equal(rosterSummary.agents[0].activity_health, null)
  assert.deepEqual(rosterSummary.totals, {
    awake: 1,
    hibernating: 0,
    dead: 0,
    total: 1,
  })
  assert.deepEqual(rosterSummary.machines.find(m => m.machine_id === 'mini:prod').registry, {
    awake: 1,
    hibernating: 0,
    dead: 0,
    total: 1,
  })

  const disconnectedHealthSummary = summarizeFleetRosterTruth({
    roster: [{
      ...agent,
      runtime_status: daemonMissing,
      metadata: {
        activityHealth: {
          state: ACTIVITY_HEALTH_UNAVAILABLE,
          boundary: ACTIVITY_HEALTH_BOUNDARIES.NO_TMUX,
          ts: new Date(nowMs - 60_000).toISOString(),
          lastKnownGoodAt: new Date(nowMs - 60_000).toISOString(),
        },
      },
    }],
    matched: [{
      ...agent,
      runtime_status: daemonMissing,
      metadata: {
        activityHealth: {
          state: ACTIVITY_HEALTH_UNAVAILABLE,
          boundary: ACTIVITY_HEALTH_BOUNDARIES.NO_TMUX,
          ts: new Date(nowMs - 60_000).toISOString(),
          lastKnownGoodAt: new Date(nowMs - 60_000).toISOString(),
        },
      },
    }],
    now: nowMs,
  })
  assert.equal(disconnectedHealthSummary.agents[0].activity_health.boundary, ACTIVITY_HEALTH_BOUNDARIES.NO_TMUX)

  const otherHealthSummary = summarizeFleetRosterTruth({
    roster: [{
      ...agent,
      runtime_status: activityDriven,
      metadata: {
        activityHealth: {
          state: ACTIVITY_HEALTH_UNAVAILABLE,
          boundary: ACTIVITY_HEALTH_BOUNDARIES.WATCH_RUNTIME_ERROR,
          ts: new Date(nowMs - 60_000).toISOString(),
          lastKnownGoodAt: new Date(nowMs - 60_000).toISOString(),
        },
      },
    }],
    matched: [{
      ...agent,
      runtime_status: activityDriven,
      metadata: {
        activityHealth: {
          state: ACTIVITY_HEALTH_UNAVAILABLE,
          boundary: ACTIVITY_HEALTH_BOUNDARIES.WATCH_RUNTIME_ERROR,
          ts: new Date(nowMs - 60_000).toISOString(),
          lastKnownGoodAt: new Date(nowMs - 60_000).toISOString(),
        },
      },
    }],
    now: nowMs,
  })
  assert.equal(otherHealthSummary.agents[0].activity_health.boundary, ACTIVITY_HEALTH_BOUNDARIES.WATCH_RUNTIME_ERROR)

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

  store.upsertAgent({
    id: 'fleet:skip-test-human',
    friendly_name: 'skip-test-human',
    labels: [],
    registered_at: new Date(0).toISOString(),
    last_seen: new Date(nowMs).toISOString(),
    dead: false,
    human: true,
    is_manager: false,
    metadata: {
      activityHealth: {
        state: ACTIVITY_HEALTH_UNAVAILABLE,
        boundary: ACTIVITY_HEALTH_BOUNDARIES.NO_TMUX,
        reason: 'human rows must not display daemon health',
      },
    },
  })
  const humanPageRows = store.getAliveAgentsPage({ limit: 10 }).agents
  assert(humanPageRows.some(a => a.id === 'fleet:skip-test-human' && a.human))
  const apiAgentsPopulation = humanPageRows.map(a => a.id).sort()
  assert.deepEqual(store.getAliveAgentCounts(), {
    awake: 1,
    hibernating: 2,
    total: 3,
  })
  const fleetTableSummary = summarizeFleetRosterTruth({
    roster: humanPageRows,
    matched: humanPageRows,
    now: nowMs,
  })
  const humanRosterSummary = summarizeFleetRosterTruth({
    roster: humanPageRows,
    matched: humanPageRows,
    now: nowMs,
  })
  assert.deepEqual(fleetTableSummary.agents.map(a => a.id).sort(), apiAgentsPopulation)
  assert.deepEqual(humanRosterSummary.agents.map(a => a.id).sort(), apiAgentsPopulation)
  assert.deepEqual(fleetTableSummary.totals, { ...store.getAliveAgentCounts(), dead: 0 })
  assert.deepEqual(humanRosterSummary.totals, fleetTableSummary.totals)
  assert.deepEqual(
    humanPageRows.map(a => [a.id, fleetRosterCategory(a)]).sort(),
    humanRosterSummary.agents.map(a => [a.id, a.status === 'human' || a.status === 'awake' ? 'awake' : 'hibernating']).sort()
  )
  const awakeFilter = parseFilter('awake')
  const hibernatingFilter = parseFilter('hibernating')
  const awakeRows = humanPageRows.filter(a => evalExpr(awakeFilter, labelsForAgent(a)))
  const hibernatingRows = humanPageRows.filter(a => evalExpr(hibernatingFilter, labelsForAgent(a)))
  assert(awakeRows.some(a => a.id === 'fleet:skip-test-human'))
  assert(!hibernatingRows.some(a => a.id === 'fleet:skip-test-human'))
  assert.deepEqual(awakeRows.map(a => a.id).sort(), ['fleet:skip-test-human'])
  assert.deepEqual(hibernatingRows.map(a => a.id).sort(), [
    'fleet:stale-legacy-route',
    'fleet:status-authority-test',
  ])
  const awakeFleetTableSummary = summarizeFleetRosterTruth({
    roster: humanPageRows,
    matched: awakeRows,
    now: nowMs,
  })
  const hibernatingFleetTableSummary = summarizeFleetRosterTruth({
    roster: humanPageRows,
    matched: hibernatingRows,
    now: nowMs,
  })
  assert.deepEqual(awakeFleetTableSummary.totals, fleetTableSummary.totals)
  assert.deepEqual(hibernatingFleetTableSummary.totals, fleetTableSummary.totals)
  assert.equal(awakeFleetTableSummary.matched, awakeRows.length)
  assert.equal(hibernatingFleetTableSummary.matched, hibernatingRows.length)
  assert.deepEqual(awakeFleetTableSummary.agents.map(a => a.id), ['fleet:skip-test-human'])
  assert(!hibernatingFleetTableSummary.agents.some(a => a.id === 'fleet:skip-test-human'))
  function endpointRosterProjection({ filter = '', limit = 1 } = {}) {
    const roster = store.getAliveAgents()
    const filterAst = parseFilter(filter)
    const page = filteredFleetRosterPage(roster, {
      filterAst,
      labelsForRow: labelsForAgent,
      limit,
    })
    return {
      ...summarizeFleetRosterTruth({
        roster,
        matched: page.rows,
        limit,
        now: nowMs,
      }),
      matched: page.matched,
      nextCursor: page.nextCursor,
    }
  }
  const oneRowAll = endpointRosterProjection({ limit: 1 })
  assert.deepEqual(oneRowAll.totals, {
    awake: 1,
    hibernating: 2,
    dead: 0,
    total: 3,
  })
  assert.equal(oneRowAll.shown, 1)
  assert.equal(oneRowAll.matched, 3)
  const oneRowAwake = endpointRosterProjection({ filter: 'awake', limit: 1 })
  assert.deepEqual(oneRowAwake.totals, oneRowAll.totals)
  assert.equal(oneRowAwake.matched, 1)
  assert.deepEqual(oneRowAwake.agents.map(a => a.id), ['fleet:skip-test-human'])
  assert.equal(oneRowAwake.nextCursor, null)
  const oneRowHibernating = endpointRosterProjection({ filter: 'hibernating', limit: 1 })
  assert.deepEqual(oneRowHibernating.totals, oneRowAll.totals)
  assert.equal(oneRowHibernating.matched, 2)
  assert(!oneRowHibernating.agents.some(a => a.id === 'fleet:skip-test-human'))
  assert(oneRowHibernating.nextCursor)
  const hibernatingSecondPage = filteredFleetRosterPage(store.getAliveAgents(), {
    filterAst: hibernatingFilter,
    labelsForRow: labelsForAgent,
    limit: 1,
    cursor: oneRowHibernating.nextCursor,
  })
  assert.equal(hibernatingSecondPage.matched, 2)
  assert.equal(hibernatingSecondPage.rows.length, 1)
  assert.notEqual(hibernatingSecondPage.rows[0].id, oneRowHibernating.agents[0].id)
  assert(!hibernatingSecondPage.rows.some(a => a.id === 'fleet:skip-test-human'))
  const interleavedRows = [
    {
      id: 'fleet:older-runtime-awake',
      friendly_name: 'older-runtime-awake',
      human: false,
      dead: false,
      last_seen: '2026-07-21T00:00:10.000Z',
      runtime_status: { status: 'awake' },
      metadata: {},
    },
    {
      id: 'fleet:newer-hibernating',
      friendly_name: 'newer-hibernating',
      human: false,
      dead: false,
      last_seen: '2026-07-21T00:00:30.000Z',
      runtime_status: { status: 'hibernating' },
      metadata: {},
    },
    {
      id: 'fleet:middle-human',
      friendly_name: 'middle-human',
      human: true,
      dead: false,
      last_seen: '2026-07-21T00:00:20.000Z',
      metadata: {},
    },
  ]
  const interleavedAwakePage = filteredFleetRosterPage(interleavedRows, {
    filterAst: awakeFilter,
    labelsForRow: labelsForAgent,
    limit: 1,
  })
  assert.equal(interleavedAwakePage.matched, 2)
  assert.deepEqual(interleavedAwakePage.rows.map(a => a.id), ['fleet:middle-human'])
  assert(interleavedAwakePage.nextCursor)
  const interleavedAwakePage2 = filteredFleetRosterPage(interleavedRows, {
    filterAst: awakeFilter,
    labelsForRow: labelsForAgent,
    limit: 1,
    cursor: interleavedAwakePage.nextCursor,
  })
  assert.equal(interleavedAwakePage2.matched, 2)
  assert.deepEqual(interleavedAwakePage2.rows.map(a => a.id), ['fleet:older-runtime-awake'])
  assert.equal(interleavedAwakePage2.nextCursor, null)
  const interleavedHumanPage = filteredFleetRosterPage(interleavedRows, {
    filterAst: parseFilter('human'),
    labelsForRow: labelsForAgent,
    limit: 1,
  })
  assert.equal(interleavedHumanPage.matched, 1)
  assert.deepEqual(interleavedHumanPage.rows.map(a => a.id), ['fleet:middle-human'])
  const humanRosterRow = humanRosterSummary.agents.find(a => a.id === 'fleet:skip-test-human')
  assert(humanRosterRow)
  assert.equal(humanRosterRow.status, 'human')
  assert.equal(humanRosterRow.activity_health, null)
  assert.deepEqual(humanRosterSummary.totals, {
    awake: 1,
    hibernating: 2,
    dead: 0,
    total: 3,
  })
  const rosterMachineTotals = humanRosterSummary.machines.reduce((acc, machine) => {
    acc.awake += machine.registry.awake
    acc.hibernating += machine.registry.hibernating
    acc.dead += machine.registry.dead
    acc.total += machine.registry.total
    return acc
  }, { awake: 0, hibernating: 0, dead: 0, total: 0 })
  assert.deepEqual(rosterMachineTotals, humanRosterSummary.totals)
  assert.equal(humanRosterSummary.machines.find(m => m.machine_id === 'unassigned').registry.awake, 1)

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
