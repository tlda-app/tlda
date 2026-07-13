import assert from 'node:assert/strict'
import test from 'node:test'

import { buildFleetActivityReport, parseFleetActivityCommand } from '../bots/todd/activity-report.mjs'

const now = Date.parse('2026-07-13T16:00:00.000Z')
const isoAgo = ms => new Date(now - ms).toISOString()

function agent(id, extra = {}) {
  return {
    id,
    friendly_name: extra.friendly_name || id.replace(/^fleet:/, ''),
    status: 'awake',
    dead: false,
    human: false,
    last_seen: isoAgo(60_000),
    ...extra,
  }
}

function task(id, agentId, ageMs, extra = {}) {
  return {
    id,
    agent: agentId,
    description: extra.description || `work ${id}`,
    status: 'pending',
    delegated_at: isoAgo(ageMs),
    ...extra,
  }
}

function activity(agentId, ageMs, extra = {}) {
  return {
    type: 'activity',
    from: agentId,
    to: agentId,
    timestamp: isoAgo(ageMs),
    metadata: { tool: 'Bash', ...extra.metadata },
    ...extra,
  }
}

test('recent activity reports fleet moving', () => {
  const report = buildFleetActivityReport({
    now,
    agents: [agent('fleet:active', { friendly_name: 'active-worker' })],
    tasks: [],
    events: [activity('fleet:active', 60_000)],
  })

  assert.equal(report.status, 'moving')
  assert.equal(report.counts.moving, 1)
  assert.match(report.markdown, /Fleet activity: moving/)
})

test('active quiet task satisfying Todd kick rules is toddWillKick', () => {
  const report = buildFleetActivityReport({
    now,
    agents: [agent('fleet:quiet', { friendly_name: 'quiet-worker' })],
    tasks: [task('task-quiet', 'fleet:quiet', 10 * 60_000, { description: 'finish report' })],
    events: [],
    toddConfig: {
      quietMs: 5 * 60_000,
      maxTaskAgeMs: 60 * 60_000,
      kickIntervalMs: 15 * 60_000,
    },
  })

  assert.equal(report.counts.toddWillKick, 1)
  assert.match(report.markdown, /Todd: 1 quiet task would be nudged or respawned on the next sweep\./)
})

test('hibernating active task with no route evidence needs human attention', () => {
  const report = buildFleetActivityReport({
    now,
    agents: [agent('fleet:lost', { friendly_name: 'lost-worker', status: 'hibernating' })],
    tasks: [task('task-lost', 'fleet:lost', 20 * 60_000, { description: 'recover lane' })],
    events: [],
    rosterTruth: { agents: [] },
  })

  assert.equal(report.status, 'needs-human')
  assert.equal(report.counts.needsHuman, 1)
  assert.equal(report.counts.toddWillKick, 0)
  assert.match(report.markdown, /needs you/)
})

test('telemetry attention is included but moving work still dominates status', () => {
  const report = buildFleetActivityReport({
    now,
    agents: [agent('fleet:mover', { friendly_name: 'mover' })],
    tasks: [],
    events: [activity('fleet:mover', 30_000)],
    telemetryStatus: {
      attention: [{ label: 'activity latency high' }],
    },
  })

  assert.equal(report.status, 'moving')
  assert.equal(report.counts.moving, 1)
  assert.equal(report.counts.needsHuman, 1)
  assert.match(report.markdown, /Telemetry: activity latency high/)
})

test('skip markdown avoids raw ids while operator detail can include them', () => {
  const base = {
    now,
    agents: [agent('fleet:rawid-worker', { friendly_name: 'worker one' })],
    tasks: [task('task-secret-123', 'fleet:rawid-worker', 10 * 60_000, { description: 'quiet delivery' })],
    events: [],
  }
  const skip = buildFleetActivityReport({ ...base, mode: 'skip' })
  const operator = buildFleetActivityReport({ ...base, mode: 'operator' })

  assert.doesNotMatch(skip.markdown, /fleet:rawid-worker|task-secret-123/)
  assert.match(skip.markdown, /worker one/)
  assert.match(operator.markdown, /fleet:rawid-worker/)
})

test('activity command parser recognizes skip and operator variants', () => {
  assert.deepEqual(parseFleetActivityCommand('Todd activity', { verb: 'todd' }), { mode: 'skip' })
  assert.deepEqual(parseFleetActivityCommand('todd graph --detail', { verb: 'todd' }), { mode: 'operator' })
  assert.deepEqual(parseFleetActivityCommand('is the fleet moving?', { verb: 'todd', direct: true }), { mode: 'skip' })
  assert.equal(parseFleetActivityCommand('use the todd system later', { verb: 'todd' }), null)
})
