import assert from 'node:assert/strict'
import test from 'node:test'

import { BINDING_STATE, createAgentLiveness, PROCESS } from './agent-liveness.mjs'
import { createEvidenceAdmission } from './agent-evidence.mjs'

async function setup(bindings, results) {
  const sent = []
  let booting = true
  const liveness = createAgentLiveness({
    getBindings: () => booting ? [] : bindings,
    checkProcesses: async rows => new Map(rows.map(row => [row.id, results[row.id] ?? PROCESS.UNKNOWN])),
    sendMsg: msg => sent.push(msg),
    getAdmit: () => admit,
  })
  const admit = createEvidenceAdmission({ liveness, log: { warn() {} } })
  await liveness.checkAll()
  booting = false
  return { liveness, sent }
}

test('boot observes and declares: first sweep states what it sees', async () => {
  const sent = []
  const liveness = createAgentLiveness({
    getBindings: () => [{ id: 'fleet:a' }],
    checkProcesses: async rows => new Map(rows.map(row => [row.id, PROCESS.ALIVE])),
    sendMsg: msg => sent.push(msg),
    getAdmit: () => admit,
  })
  const admit = createEvidenceAdmission({ liveness, log: { warn() {} } })
  await liveness.checkAll()
  assert.equal(sent.length, 1)
  assert.deepEqual([sent[0].agent_id, sent[0].alive], ['fleet:a', true])
  assert.equal(liveness.stateFor('fleet:a'), BINDING_STATE.AWAKE)
})

test('bindings appearing after boot still walk through waking', async () => {
  const { liveness, sent } = await setup([{ id: 'fleet:a' }], { 'fleet:a': PROCESS.ALIVE })
  await liveness.checkAll()
  assert.equal(sent.length, 0)
  assert.equal(liveness.stateFor('fleet:a'), BINDING_STATE.WAKING)
  assert.equal(liveness.verdictFor('fleet:a'), false)
})

test('second consecutive sighting wakes the binding and emits alive', async () => {
  const { liveness, sent } = await setup([{ id: 'fleet:a' }], { 'fleet:a': PROCESS.ALIVE })
  await liveness.checkAll()
  await liveness.checkAll()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, 'process-liveness')
  assert.equal(sent[0].agent_id, 'fleet:a')
  assert.equal(sent[0].alive, true)
  assert.equal(liveness.stateFor('fleet:a'), BINDING_STATE.AWAKE)
})

test('death needs two consecutive dead sweeps; one is suspicion without emit', async () => {
  const bindings = [{ id: 'fleet:a' }]
  const results = { 'fleet:a': PROCESS.ALIVE }
  const { liveness, sent } = await setup(bindings, results)
  await liveness.checkAll()
  await liveness.checkAll()
  assert.equal(sent.length, 1)
  results['fleet:a'] = PROCESS.DEAD
  await liveness.checkAll()
  assert.equal(sent.length, 1)
  assert.equal(liveness.stateFor('fleet:a'), BINDING_STATE.DYING)
  assert.equal(liveness.verdictFor('fleet:a'), true)
  await liveness.checkAll()
  assert.equal(sent.length, 2)
  assert.equal(sent[1].alive, false)
  assert.equal(liveness.stateFor('fleet:a'), BINDING_STATE.HIBERNATING)
})

test('a lone dead sweep heals silently on the next alive sighting', async () => {
  const bindings = [{ id: 'fleet:a' }]
  const results = { 'fleet:a': PROCESS.ALIVE }
  const { liveness, sent } = await setup(bindings, results)
  await liveness.checkAll()
  await liveness.checkAll()
  assert.equal(sent.length, 1)
  results['fleet:a'] = PROCESS.DEAD
  await liveness.checkAll()
  assert.equal(sent.length, 1)
  results['fleet:a'] = PROCESS.ALIVE
  await liveness.checkAll()
  assert.equal(sent.length, 1)
  assert.equal(liveness.stateFor('fleet:a'), BINDING_STATE.AWAKE)
})

test('unknown during suspicion neither confirms nor clears it', async () => {
  const bindings = [{ id: 'fleet:a' }]
  const results = { 'fleet:a': PROCESS.ALIVE }
  const { liveness, sent } = await setup(bindings, results)
  await liveness.checkAll()
  await liveness.checkAll()
  results['fleet:a'] = PROCESS.DEAD
  await liveness.checkAll()
  assert.equal(liveness.stateFor('fleet:a'), BINDING_STATE.DYING)
  results['fleet:a'] = PROCESS.UNKNOWN
  await liveness.checkAll()
  assert.equal(sent.length, 1)
  assert.equal(liveness.stateFor('fleet:a'), BINDING_STATE.DYING)
  results['fleet:a'] = PROCESS.DEAD
  await liveness.checkAll()
  assert.equal(sent.length, 2)
  assert.equal(sent[1].alive, false)
  assert.equal(liveness.stateFor('fleet:a'), BINDING_STATE.HIBERNATING)
})

test('declareAll re-emits dying bindings as awake', async () => {
  const bindings = [{ id: 'fleet:a' }]
  const results = { 'fleet:a': PROCESS.ALIVE }
  const { liveness, sent } = await setup(bindings, results)
  await liveness.checkAll()
  await liveness.checkAll()
  results['fleet:a'] = PROCESS.DEAD
  await liveness.checkAll()
  assert.equal(sent.length, 1)
  const declared = liveness.declareAll()
  assert.equal(declared, 1)
  assert.deepEqual([sent[1].agent_id, sent[1].alive], ['fleet:a', true])
})

test('unbound dying agents emit false; the binding is gone either way', async () => {
  let bindings = [{ id: 'fleet:a' }]
  const results = { 'fleet:a': PROCESS.ALIVE }
  const sent = []
  const liveness = createAgentLiveness({
    getBindings: () => bindings,
    checkProcesses: async rows => new Map(rows.map(row => [row.id, results[row.id] ?? PROCESS.UNKNOWN])),
    sendMsg: msg => sent.push(msg),
    getAdmit: () => admit,
  })
  const admit = createEvidenceAdmission({ liveness, log: { warn() {} } })
  await liveness.checkAll()
  await liveness.checkAll()
  results['fleet:a'] = PROCESS.DEAD
  await liveness.checkAll()
  assert.equal(liveness.stateFor('fleet:a'), BINDING_STATE.DYING)
  bindings = []
  await liveness.checkAll()
  assert.equal(sent.length, 2)
  assert.deepEqual([sent[1].agent_id, sent[1].alive], ['fleet:a', false])
  assert.equal(liveness.stateFor('fleet:a'), null)
})

test('death while waking is silent; the server already shows hibernating', async () => {
  const bindings = [{ id: 'fleet:a' }]
  const results = { 'fleet:a': PROCESS.ALIVE }
  const { liveness, sent } = await setup(bindings, results)
  await liveness.checkAll()
  assert.equal(liveness.stateFor('fleet:a'), BINDING_STATE.WAKING)
  results['fleet:a'] = PROCESS.DEAD
  await liveness.checkAll()
  assert.equal(sent.length, 0)
  assert.equal(liveness.stateFor('fleet:a'), BINDING_STATE.HIBERNATING)
})

test('steady state emits nothing', async () => {
  const { liveness, sent } = await setup([{ id: 'fleet:a' }], { 'fleet:a': PROCESS.ALIVE })
  await liveness.checkAll()
  await liveness.checkAll()
  await liveness.checkAll()
  assert.equal(sent.length, 1)
})

test('unknown observations keep state and emit nothing', async () => {
  const bindings = [{ id: 'fleet:a' }]
  const results = { 'fleet:a': PROCESS.ALIVE }
  const { liveness, sent } = await setup(bindings, results)
  await liveness.checkAll()
  results['fleet:a'] = PROCESS.UNKNOWN
  await liveness.checkAll()
  await liveness.checkAll()
  assert.equal(sent.length, 0)
  assert.equal(liveness.stateFor('fleet:a'), BINDING_STATE.WAKING)
})

test('unknown with no prior state emits nothing', async () => {
  const { liveness, sent } = await setup([{ id: 'fleet:a' }], { 'fleet:a': PROCESS.UNKNOWN })
  await liveness.checkAll()
  assert.equal(sent.length, 0)
  assert.equal(liveness.stateFor('fleet:a'), null)
})

test('declareAll re-emits awake verdicts only', async () => {
  const { liveness, sent } = await setup(
    [{ id: 'fleet:a' }, { id: 'fleet:b' }],
    { 'fleet:a': PROCESS.ALIVE, 'fleet:b': PROCESS.ALIVE },
  )
  await liveness.checkAll()
  await liveness.checkAll()
  assert.equal(sent.length, 2)
  const declared = liveness.declareAll()
  assert.equal(declared, 2)
  assert.deepEqual(sent.slice(2).map(m => [m.agent_id, m.alive]), [['fleet:a', true], ['fleet:b', true]])
})

test('declareAll skips waking and hibernating bindings', async () => {
  const { liveness, sent } = await setup(
    [{ id: 'fleet:a' }, { id: 'fleet:b' }],
    { 'fleet:a': PROCESS.ALIVE, 'fleet:b': PROCESS.DEAD },
  )
  await liveness.checkAll()
  assert.equal(sent.length, 0)
  const declared = liveness.declareAll()
  assert.equal(declared, 0)
  assert.equal(sent.length, 0)
})

test('unbound awake agents transition to hibernating', async () => {
  let bindings = [{ id: 'fleet:a' }]
  const sent = []
  const liveness = createAgentLiveness({
    getBindings: () => bindings,
    checkProcesses: async rows => new Map(rows.map(row => [row.id, PROCESS.ALIVE])),
    sendMsg: msg => sent.push(msg),
    getAdmit: () => admit,
  })
  const admit = createEvidenceAdmission({ liveness, log: { warn() {} } })
  await liveness.checkAll()
  await liveness.checkAll()
  assert.equal(sent.length, 1)
  bindings = []
  await liveness.checkAll()
  assert.equal(sent.length, 2)
  assert.deepEqual([sent[1].agent_id, sent[1].alive], ['fleet:a', false])
  assert.equal(liveness.stateFor('fleet:a'), null)
})

test('unbound never-awake bindings retire silently', async () => {
  let bindings = []
  const sent = []
  const liveness = createAgentLiveness({
    getBindings: () => bindings,
    checkProcesses: async rows => new Map(rows.map(row => [row.id, PROCESS.ALIVE])),
    sendMsg: msg => sent.push(msg),
    getAdmit: () => admit,
  })
  const admit = createEvidenceAdmission({ liveness, log: { warn() {} } })
  await liveness.checkAll()
  bindings = [{ id: 'fleet:a' }]
  await liveness.checkAll()
  assert.equal(liveness.stateFor('fleet:a'), BINDING_STATE.WAKING)
  bindings = []
  await liveness.checkAll()
  assert.equal(sent.length, 0)
  assert.equal(liveness.stateFor('fleet:a'), null)
})

test('unreadable bindings keep every state and emit nothing', async () => {
  let fail = false
  const sent = []
  const liveness = createAgentLiveness({
    getBindings: () => {
      if (fail) throw new Error('database is locked')
      return [{ id: 'fleet:a' }]
    },
    checkProcesses: async rows => new Map(rows.map(row => [row.id, PROCESS.ALIVE])),
    sendMsg: msg => sent.push(msg),
    log: { warn: () => {}, info: () => {} },
    getAdmit: () => admit,
  })
  const admit = createEvidenceAdmission({ liveness, log: { warn() {} } })
  await liveness.checkAll()
  await liveness.checkAll()
  assert.equal(sent.length, 1)
  fail = true
  await liveness.checkAll()
  assert.equal(sent.length, 1)
  assert.equal(liveness.stateFor('fleet:a'), BINDING_STATE.AWAKE)
})

test('check failures keep state and emit nothing', async () => {
  const sent = []
  const liveness = createAgentLiveness({
    getBindings: () => [{ id: 'fleet:a' }],
    checkProcesses: async () => { throw new Error('tmux socket missing') },
    sendMsg: msg => sent.push(msg),
    log: { warn: () => {}, info: () => {} },
    getAdmit: () => admit,
  })
  const admit = createEvidenceAdmission({ liveness, log: { warn() {} } })
  await liveness.checkAll()
  assert.equal(sent.length, 0)
  assert.equal(liveness.stateFor('fleet:a'), null)
})
