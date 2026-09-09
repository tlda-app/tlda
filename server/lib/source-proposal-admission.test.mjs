import test from 'node:test'
import assert from 'node:assert/strict'
import { createSourceProposalAdmissionConnectionDispatcher, createSourceProposalAdmissionDispatcher, createSourceProposalAdmissionHandler } from './source-proposal-admission.mjs'

function fixture(overrides = {}) {
  const sent = [], events = [], calls = [], logs = []
  let clock = 0
  const deps = {
    parseDaemonProposalRef: () => ({ revision: 'r1' }),
    sourceLifecycleStore: async () => ({
      gitRepository: async () => ({ gitDir: '/git' }),
      listRevisionLifecycles: () => [{ sourceRevision: 'r1' }],
    }),
    listProposalRefs: async () => [{ project: 'paper', ref: 'proposal', revision: 'r1', daemonId: 'daemon', branch: 'main' }],
    admitProposal: async (_proposal, options) => (calls.push(options), { id: 'job', state: 'complete', started_once: 1, terminal_reason: null }),
    updateProject: async (...args) => calls.push(args),
    recordServerPerfEvent: (...args) => events.push(args),
    log: message => logs.push(message),
    performanceNow: () => ++clock,
    nowMs: () => 123,
    ...overrides,
  }
  return { handler: createSourceProposalAdmissionHandler(deps), ws: { _daemonKey: 'daemon', send: value => sent.push(JSON.parse(value)) }, sent, events, calls, logs }
}

test('preserves success response, retry flag, attribution, and five timings', async () => {
  const f = fixture()
  await f.handler(f.ws, { id: 1, project: 'paper', ref: 'proposal', revision: 'r1', retry_terminal: true, editedBy: 'agent' }, { receivedAt: 0 })
  assert.deepEqual(f.sent, [{ id: 1, result: { ok: true, project: 'paper', revision: 'r1', submissionId: 'job', state: 'complete', startedOnce: true, terminalReason: null, lifecyclePresent: true } }])
  assert.equal(f.calls[0].retryTerminal, true)
  assert.deepEqual(f.calls[1], ['paper', { lastEditedBy: 'agent', lastEditedByAt: 123 }])
  assert.equal(f.events.length, 1)
  const detail = f.events[0][1]
  assert.equal(typeof detail.queuedMs, 'number')
  assert.deepEqual(detail.stages.map(item => item.stage), ['lifecycle-store', 'git-repository', 'proposal-enumeration', 'queue-admission', 'attribution'])
  assert.equal(detail.proposalCount, 1)
  assert.equal(detail.proposalFound, true)
  assert.equal(detail.hasCurrentLifecycle, true)
  assert.deepEqual(f.logs, [])
})

test('omits attribution timing without editedBy and preserves error reply at every await', async () => {
  const names = ['lifecycle-store', 'git-repository', 'proposal-enumeration', 'queue-admission']
  for (const target of names) {
    const failure = new Error(`fail-${target}`)
    const overrides = target === 'lifecycle-store' ? { sourceLifecycleStore: async () => { throw failure } }
      : target === 'git-repository' ? { sourceLifecycleStore: async () => ({ gitRepository: async () => { throw failure }, listRevisionLifecycles: () => [] }) }
      : target === 'proposal-enumeration' ? { listProposalRefs: async () => { throw failure } }
      : { admitProposal: async () => { throw failure } }
    const f = fixture(overrides)
    await f.handler(f.ws, { id: 1, project: 'paper', ref: 'proposal', revision: 'r1' })
    assert.deepEqual(f.sent, [{ id: 1, error: failure.message }])
    assert.equal(f.events.length, 1)
    assert.equal(f.events[0][1].errorStage, target)
    assert.equal(f.events[0][1].stages.at(-1).stage, target)
    assert.equal(f.logs.length, 1)
  }
  const clean = fixture()
  await clean.handler(clean.ws, { id: 1, project: 'paper', ref: 'proposal', revision: 'r1' })
  assert.equal(clean.events[0][1].stages.some(item => item.stage === 'attribution'), false)
})

test('preserves ref validation and best-effort attribution', async () => {
  const invalid = fixture({ parseDaemonProposalRef: () => null })
  await invalid.handler(invalid.ws, { id: 1, project: 'paper', ref: 'bad', revision: 'r1' })
  assert.match(invalid.sent[0].error, /invalid proposal ref/)
  const attributed = fixture({ updateProject: async () => { throw new Error('stamp') } })
  await attributed.handler(attributed.ws, { id: 1, project: 'paper', ref: 'proposal', revision: 'r1', editedBy: 'agent' })
  assert.equal(attributed.sent[0].result.ok, true)
  assert.equal(attributed.events.length, 1)
  assert.equal(attributed.events[0][1].ok, true)
  assert.equal(attributed.events[0][1].stages.at(-1).stage, 'attribution')
})

test('serializes one project without blocking another', async () => {
  let release
  const entered = []
  const gate = new Promise(resolve => { release = resolve })
  const enqueue = createSourceProposalAdmissionDispatcher(async msg => {
    entered.push(msg.id)
    if (msg.id === 'a1') await gate
  })
  const a1 = enqueue({ project: 'a', id: 'a1' })
  const a2 = enqueue({ project: 'a', id: 'a2' })
  const b1 = enqueue({ project: 'b', id: 'b1' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(entered, ['a1', 'b1'])
  release()
  await Promise.all([a1, a2, b1])
  assert.deepEqual(entered, ['a1', 'b1', 'a2'])
})

test('records positive queue delay for a deferred same-project request', async () => {
  let clock = 0
  let release
  let calls = 0
  const gate = new Promise(resolve => { release = resolve })
  const f = fixture({
    performanceNow: () => clock,
    sourceLifecycleStore: async () => {
      calls += 1
      if (calls === 1) await gate
      return { gitRepository: async () => ({ gitDir: '/git' }), listRevisionLifecycles: () => [] }
    },
  })
  const enqueue = createSourceProposalAdmissionDispatcher((msg, context) => f.handler(f.ws, msg, context), undefined, () => clock)
  const first = enqueue({ id: 1, project: 'paper', ref: 'proposal', revision: 'r1' })
  const second = enqueue({ id: 2, project: 'paper', ref: 'proposal', revision: 'r1' })
  await new Promise(resolve => setImmediate(resolve))
  clock = 10
  release()
  await Promise.all([first, second])
  assert.equal(f.events[1][1].queuedMs, 10)
})

test('per-connection enqueue reaches the handler through the production envelope shape', async () => {
  const f = fixture()
  const envelopeCalls = []
  const enqueue = createSourceProposalAdmissionConnectionDispatcher({
    ws: f.ws,
    handleEnvelope: async (ws, msg, handler, options) => {
      envelopeCalls.push({ ws, msg, options })
      await handler(ws, msg)
    },
    handler: f.handler,
  })
  await enqueue({ id: 1, project: 'paper', ref: 'proposal', revision: 'r1' })
  assert.equal(envelopeCalls.length, 1)
  assert.equal(f.sent[0].result.ok, true)
})

test('identifies a deliberately slow stage as dominant', async () => {
  let clock = 0
  const f = fixture({
    performanceNow: () => clock,
    sourceLifecycleStore: async () => { clock += 50; return { gitRepository: async () => { clock += 1; return { gitDir: '/git' } }, listRevisionLifecycles: () => [] } },
    listProposalRefs: async () => { clock += 1; return [{ project: 'paper', ref: 'proposal', revision: 'r1', daemonId: 'daemon', branch: 'main' }] },
    admitProposal: async () => { clock += 1; return { id: 'job', state: 'pending', started_once: 0 } },
  })
  await f.handler(f.ws, { id: 1, project: 'paper', ref: 'proposal', revision: 'r1' }, { receivedAt: 0 })
  const stages = f.events[0][1].stages
  assert.equal(stages.reduce((a, b) => a.durationMs > b.durationMs ? a : b).stage, 'lifecycle-store')
  assert.equal(f.logs.length, 1)
})
