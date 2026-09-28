import assert from 'node:assert/strict'
import test from 'node:test'

import { BINDING_STATE } from './agent-liveness.mjs'
import { createEvidenceAdmission, EVIDENCE_SOURCE, EVIDENCE_STALE_MS } from './agent-evidence.mjs'

function setup({ livenessResult = 'state' } = {}) {
  const warnings = []
  const processes = []
  const activities = []
  const closedTurns = []
  const admit = createEvidenceAdmission({
    liveness: { consumeProcess: (id, process, meta) => { processes.push([id, process, meta]); return livenessResult } },
    activity: {
      consumeActivity: (id, activity, meta) => { activities.push([id, activity, meta]); return true },
      closeTurn: id => { closedTurns.push(id) },
    },
    log: { warn: msg => warnings.push(msg) },
    now: () => 1_000_000,
  })
  return { admit, warnings, processes, activities, closedTurns }
}

test('a full envelope routes each half to its machine', () => {
  const { admit, processes, activities, warnings } = setup()
  const out = admit({
    agentId: 'fleet:a', source: EVIDENCE_SOURCE.HOOK, atMs: 999_999,
    process: 'alive', activity: 'thinking', tool: 'Read',
  })
  assert.deepEqual(processes, [['fleet:a', 'alive', { source: 'hook', atMs: 999_999, tool: 'Read' }]])
  assert.deepEqual(activities, [['fleet:a', 'thinking', { source: 'hook', atMs: 999_999, tool: 'Read' }]])
  assert.deepEqual(out, { process: 'state', activity: true })
  assert.equal(warnings.length, 0)
})

test('omission is silence: absent halves never reach a machine', () => {
  const { admit, processes, activities } = setup()
  const out = admit({ agentId: 'fleet:a', source: EVIDENCE_SOURCE.TRANSCRIPT, atMs: 999_999, activity: 'active' })
  assert.equal(processes.length, 0)
  assert.equal(activities.length, 1)
  assert.deepEqual(out, { process: undefined, activity: true })
})

test('pane scrape claiming process is dropped; its activity half is admitted', () => {
  const { admit, processes, activities, warnings } = setup()
  const out = admit({
    agentId: 'fleet:a', source: EVIDENCE_SOURCE.PANE_SCRAPE, atMs: 999_999,
    process: 'alive', activity: 'thinking',
  })
  assert.equal(processes.length, 0)
  assert.equal(activities.length, 1)
  assert.deepEqual(out, { process: undefined, activity: true })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /scrape claims process/)
})

test('malformed envelopes are dropped with a warning, never thrown', () => {
  const { admit, processes, activities, warnings } = setup()
  const bad = [
    { source: 'hook', atMs: 999_999, process: 'alive' },
    { agentId: 'fleet:a', source: 'telegraph', atMs: 999_999, process: 'alive' },
    { agentId: 'fleet:a', source: 'hook', process: 'alive' },
    { agentId: 'fleet:a', source: 'hook', atMs: 999_999, process: 'mostly' },
    { agentId: 'fleet:a', source: 'hook', atMs: 999_999, activity: 'vibing' },
    { agentId: 'fleet:a', source: 'hook', atMs: 999_999, activity: 'idle', tool: 42 },
  ]
  for (const envelope of bad) assert.equal(admit(envelope), undefined)
  assert.equal(processes.length, 0)
  assert.equal(activities.length, 0)
  assert.equal(warnings.length, bad.length)
})

test('confirmed death closes the open turn; suspicion does not', () => {
  const dead = { agentId: 'fleet:a', source: EVIDENCE_SOURCE.PROCESS_PROBE, atMs: 999_999, process: 'dead' }
  const confirmed = setup({ livenessResult: BINDING_STATE.HIBERNATING })
  confirmed.admit({ ...dead })
  assert.deepEqual(confirmed.closedTurns, ['fleet:a'])

  const suspicion = setup({ livenessResult: BINDING_STATE.DYING })
  suspicion.admit({ ...dead })
  assert.deepEqual(suspicion.closedTurns, [])

  const alive = setup({ livenessResult: BINDING_STATE.AWAKE })
  alive.admit({ ...dead, process: 'alive' })
  assert.deepEqual(alive.closedTurns, [])
})

test('stale evidence is dropped at the boundary', () => {
  const { admit, processes, warnings } = setup()
  assert.equal(
    admit({ agentId: 'fleet:a', source: 'hook', atMs: 1_000_000 - EVIDENCE_STALE_MS - 1, process: 'alive' }),
    undefined,
  )
  assert.equal(processes.length, 0)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /stale/)
})
