import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  resolveSpawnCollision,
  SpawnLibrarian,
  specMismatch,
  type AgentRecord,
} from './spawn-librarian.ts'

const projectForCwd = (cwd?: string | null) => {
  if (!cwd) return null
  if (cwd.includes('/bregman')) return 'bregman'
  if (cwd.includes('/tlda')) return 'tlda'
  return null
}

const liveCleanup: AgentRecord = {
  id: 'fleet:cleanup1',
  friendly_name: 'cleanup',
  dead: false,
  cwd: '/Users/skip/work/bregman',
  metadata: { model: 'claude-opus-4-8[1m]', kind: 'claude' },
}

describe('spawn librarian collision handling', () => {
  it('keeps fresh name collisions as new-agent intent for register-time allocation', () => {
    const resolved = resolveSpawnCollision({
      name: 'cleanup',
      respawn: false,
      fresh: true,
      requested: { model: 'gpt-5.5', kind: 'codex', project: 'tlda' },
      liveMatches: [liveCleanup],
      projectForCwd,
    })
    assert.deepEqual(resolved, { name: 'cleanup', respawn: false })
  })

  it('does not convert exact-spec fresh re-issues into wakes', () => {
    assert.equal(specMismatch(
      { model: 'opus48', kind: 'claude', project: 'bregman' },
      liveCleanup,
      { projectForCwd }
    ), false)
    assert.equal(specMismatch(
      { model: 'opus', kind: 'claude', project: 'bregman' },
      liveCleanup,
      { projectForCwd }
    ), false)
    const resolved = resolveSpawnCollision({
      name: 'cleanup',
      respawn: false,
      fresh: true,
      requested: { model: 'opus48', kind: 'claude', project: 'bregman' },
      liveMatches: [liveCleanup],
      projectForCwd,
    })
    assert.deepEqual(resolved, { name: 'cleanup', respawn: false })
  })

  it('leaves the explicit respawn path intact', () => {
    const resolved = resolveSpawnCollision({
      name: 'cleanup',
      respawn: true,
      fresh: false,
      requested: { model: 'gpt-5.5', kind: 'codex', project: 'tlda' },
      liveMatches: [liveCleanup],
      projectForCwd,
    })
    assert.deepEqual(resolved, { name: 'cleanup', respawn: true })
  })

  it('spawns a brand-new unique fresh name with the requested spec', () => {
    const resolved = resolveSpawnCollision({
      name: 'new-codex',
      respawn: false,
      fresh: true,
      requested: { model: 'gpt-5.5', kind: 'codex', project: 'tlda' },
      liveMatches: [],
      projectForCwd,
    })
    assert.deepEqual(resolved, { name: 'new-codex', respawn: false })
  })

  it('allows dead-name reuse as a fresh spawn', () => {
    const resolved = resolveSpawnCollision({
      name: 'cleanup',
      respawn: false,
      fresh: true,
      requested: { model: 'gpt-5.5', kind: 'codex', project: 'tlda' },
      liveMatches: [{ ...liveCleanup, dead: true }],
      projectForCwd,
    })
    assert.deepEqual(resolved, { name: 'cleanup', respawn: false })
  })
})

describe('spawn librarian login readiness', () => {
  it('resolves readiness on login rather than a timer', async () => {
    const librarian = new SpawnLibrarian({ loginDeadlineMs: 100 })
    const wait = librarian.awaitLogin({ id: 'fleet:new1', name: 'new1', spec: { model: 'gpt-5.5' } })
    assert.equal(librarian.pendingSpawns.size, 1)
    librarian.observeLogin({ id: 'fleet:new1', friendly_name: 'new1' })
    assert.deepEqual(await wait, { ok: true, agent: { id: 'fleet:new1', friendly_name: 'new1' } })
    assert.equal(librarian.pendingSpawns.size, 0)
  })

  it('allows a slow spawn when the failure deadline has not elapsed', async () => {
    const librarian = new SpawnLibrarian({ loginDeadlineMs: 80 })
    const wait = librarian.awaitLogin({ id: 'fleet:slow', name: 'slow' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    librarian.observeLogin({ id: 'fleet:slow', friendly_name: 'slow' })
    assert.equal((await wait).ok, true)
  })

  it('returns login-timeout for a launch that never logs in and does not duplicate', async () => {
    const librarian = new SpawnLibrarian({ loginDeadlineMs: 5 })
    const wait = librarian.awaitLogin({ id: 'fleet:never', name: 'never' })
    assert.deepEqual(await wait, { ok: false, reason: 'login-timeout' })
    assert.equal(librarian.pendingSpawns.has('fleet:never'), false)
    librarian.observeLogin({ id: 'fleet:other', friendly_name: 'never' })
    assert.equal(librarian.pendingSpawns.size, 0)
  })
})

describe('spawn librarian liveness routing', () => {
  it('does not respawn an agent in spawning or unknown state', () => {
    const librarian = new SpawnLibrarian()
    const agent = { id: 'fleet:a', friendly_name: 'a' }
    librarian.observeLiveness({ agent_id: agent.id, tmux_session: 'fleet-a', state: 'spawning' })
    assert.deepEqual(librarian.decideWake(agent), { action: 'queue', reason: 'spawning' })
    librarian.observeLiveness({ agent_id: agent.id, tmux_session: 'fleet-a', state: 'unknown', reason: 'daemon missed' })
    assert.deepEqual(librarian.decideWake(agent), { action: 'hold', reason: 'unknown' })
  })

  it('respawns a server-hibernating agent even when daemon liveness is unknown', () => {
    const librarian = new SpawnLibrarian()
    const agent = { id: 'fleet:a', friendly_name: 'a' }
    assert.deepEqual(
      librarian.decideWake(
        agent,
        { agent_id: agent.id, tmux_session: 'fleet-a', state: 'unknown', reason: 'daemon missed' },
        { serverAlive: false }
      ),
      { action: 'respawn' }
    )
  })

  it('respawns when daemon check-alive reports the tmux session absent', () => {
    const librarian = new SpawnLibrarian()
    const agent = { id: 'fleet:a', friendly_name: 'a' }
    assert.deepEqual(
      librarian.decideWake(
        agent,
        { agent_id: agent.id, tmux_session: 'fleet-a', state: 'dead', reason: 'tmux gone' },
        { serverAlive: true }
      ),
      { action: 'respawn' }
    )
  })

  it('respawns only after daemon-confirmed dead state', () => {
    const librarian = new SpawnLibrarian()
    const agent = { id: 'fleet:a', friendly_name: 'a' }
    librarian.observeLiveness({ agent_id: agent.id, tmux_session: 'fleet-a', state: 'dead', reason: 'tmux gone' })
    assert.deepEqual(librarian.decideWake(agent), { action: 'respawn' })
  })
})

describe('spawn librarian wedged join', () => {
  it('surfaces wedged when a delivered chat has no later agent-activity advance', async () => {
    const wedged: string[] = []
    const librarian = new SpawnLibrarian({
      wedgedWindowMs: 5,
      onWedged: (event) => wedged.push(event.agent_id),
    })
    librarian.observeLiveness({ agent_id: 'fleet:w', tmux_session: 'fleet-w', state: 'alive' })
    librarian.observeDelivery('fleet:w', Date.now())
    await new Promise((resolve) => setTimeout(resolve, 15))
    assert.deepEqual(wedged, ['fleet:w'])
    assert.equal(librarian.livenessState('fleet:w'), 'wedged')
  })

  it('clears the pending delivery when agent-activity advances', async () => {
    const wedged: string[] = []
    const librarian = new SpawnLibrarian({
      wedgedWindowMs: 15,
      onWedged: (event) => wedged.push(event.agent_id),
    })
    const deliveredAt = Date.now()
    librarian.observeLiveness({ agent_id: 'fleet:w', tmux_session: 'fleet-w', state: 'alive' })
    librarian.observeDelivery('fleet:w', deliveredAt)
    librarian.observeActivity({ agent_id: 'fleet:w', jsonl_offset: 2, ts: new Date(deliveredAt + 1).toISOString() })
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.deepEqual(wedged, [])
    assert.equal(librarian.livenessState('fleet:w'), 'alive')
  })
})
