import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { FleetStore } from '../server/lib/fleet-store.mjs'
import { parseFilter, evalExpr, evalExprDirectional, labelsForAgent } from '../shared/fleet-labels.mjs'

function makeStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'fleet-registry-live-'))
  const store = new FleetStore(path.join(dir, 'fleet.db'))
  store.setLivenessOracle(id => id === 'fleet:a' || id === 'fleet:c' || id === 'fleet:human')
  return {
    store,
    async cleanup() {
      try { await store._worker?.terminate() } catch {}
      try { store.db.close() } catch {}
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
    },
  }
}

function seedAgents(store) {
  const base = Date.now()
  const rows = [
    { id: 'fleet:a', friendly_name: 'alpha', labels: ['math', 'reviewers'], last_seen: new Date(base + 4).toISOString() },
    { id: 'fleet:b', friendly_name: 'beta', labels: ['reviewers'], last_seen: new Date(base + 3).toISOString() },
    { id: 'fleet:c', friendly_name: 'gamma', labels: ['ops'], last_seen: new Date(base + 2).toISOString() },
    { id: 'fleet:dead', friendly_name: 'delta', labels: ['reviewers'], dead: true, last_seen: new Date(base + 1).toISOString() },
    { id: 'fleet:human', friendly_name: 'skip', labels: ['human-label'], human: true, last_seen: new Date(base + 5).toISOString() },
  ]
  for (const row of rows) store.upsertAgent(row)
}

function oldRecipientScan(store, expr, from = null) {
  const ast = parseFilter(expr)
  return store.getAllAgents()
    .filter(a => a.id !== from && !a.dead && evalExpr(ast, labelsForAgent(a)))
    .map(a => a.id)
}

function newRecipientScan(store, expr, from = null) {
  return store.resolveChatRecipients(parseFilter(expr), { from, filter: expr })
}

test('live registry recipient resolution matches old full-roster scan', async () => {
  const { store, cleanup } = makeStore()
  try {
    seedAgents(store)
    const expressions = [
      'fleet:a',
      'alpha',
      'reviewers',
      'awake',
      'hibernating',
      'human',
      'reviewers & !hibernating',
      '(reviewers | ops) & awake',
      'math | human-label',
      '!ops',
    ]
    for (const expr of expressions) {
      assert.deepEqual(newRecipientScan(store, expr), oldRecipientScan(store, expr), expr)
      assert.deepEqual(newRecipientScan(store, expr, 'fleet:a'), oldRecipientScan(store, expr, 'fleet:a'), `${expr} excluding sender`)
    }

    store.markDead('fleet:a')
    assert.deepEqual(newRecipientScan(store, 'fleet:a'), oldRecipientScan(store, 'fleet:a'), 'dead literal id is excluded')

    store.upsertAgent({ id: 'fleet:new', friendly_name: 'newbie', labels: ['reviewers'], last_seen: new Date(Date.now() + 10).toISOString() })
    assert.deepEqual(newRecipientScan(store, 'reviewers'), oldRecipientScan(store, 'reviewers'), 'label index updates on add')
  } finally {
    await cleanup()
  }
})

test('agent roster APIs are maintained views, not SQL snapshots', async () => {
  const { store, cleanup } = makeStore()
  try {
    seedAgents(store)

    let allSqlReads = 0
    let aliveSqlReads = 0
    const origAll = store._getAllAgents.all.bind(store._getAllAgents)
    const origAlive = store._getAliveAgents.all.bind(store._getAliveAgents)
    store._getAllAgents.all = (...args) => { allSqlReads++; return origAll(...args) }
    store._getAliveAgents.all = (...args) => { aliveSqlReads++; return origAlive(...args) }

    assert.deepEqual(
      store.getAllAgents().map(a => a.id),
      ['fleet:human', 'fleet:a', 'fleet:b', 'fleet:c', 'fleet:dead']
    )
    assert.deepEqual(
      store.getAliveAgents().map(a => a.id),
      ['fleet:human', 'fleet:a', 'fleet:b', 'fleet:c']
    )
    assert.equal(allSqlReads, 0, 'getAllAgents should not query SQL after registry init')
    assert.equal(aliveSqlReads, 0, 'getAliveAgents should not query SQL after registry init')

    await new Promise(r => setTimeout(r, 10))
    store.updateHeartbeat('fleet:b')
    assert.equal(store.getAllAgents()[0].id, 'fleet:b', 'heartbeat reorders maintained all-agents view')
    assert.equal(store.getAliveAgents()[0].id, 'fleet:b', 'heartbeat reorders maintained alive-agents view')

    store.markDead('fleet:b')
    assert.ok(store.getAllAgents().find(a => a.id === 'fleet:b')?.dead, 'dead agent stays in all roster')
    assert.ok(!store.getAliveAgents().some(a => a.id === 'fleet:b'), 'dead agent drops out of alive roster')
    assert.equal(allSqlReads, 0, 'registry updates should not force all-agent SQL reload')
    assert.equal(aliveSqlReads, 0, 'registry updates should not force alive-agent SQL reload')
  } finally {
    await cleanup()
  }
})

test('refreshAgentLiveness rehydrates maintained roster status', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fleet-registry-liveness-'))
  const liveIds = new Set()
  const store = new FleetStore(path.join(dir, 'fleet.db'))
  store.setLivenessOracle(id => liveIds.has(id))
  try {
    store.upsertAgent({ id: 'fleet:liveness', friendly_name: 'liveness' })
    assert.equal(store.getAgent('fleet:liveness').status, 'hibernating')
    assert.equal(store.getAllAgents().find(a => a.id === 'fleet:liveness')?.status, 'hibernating')

    liveIds.add('fleet:liveness')
    store.refreshAgentLiveness('fleet:liveness')
    assert.equal(store.getAgent('fleet:liveness').status, 'awake')
    assert.equal(store.getAllAgents().find(a => a.id === 'fleet:liveness')?.status, 'awake')

    liveIds.delete('fleet:liveness')
    store.refreshAgentLiveness('fleet:liveness')
    assert.equal(store.getAgent('fleet:liveness').status, 'hibernating')
    assert.equal(store.getAllAgents().find(a => a.id === 'fleet:liveness')?.status, 'hibernating')
  } finally {
    await store._worker?.terminate()
    store.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

function oldWiretapScan(store, senderId, recipientId, eventType) {
  const matched = new Set()
  const fromLabels = labelsForAgent(store.getAgent(senderId) || { id: senderId })
  const toLabels = labelsForAgent(store.getAgent(recipientId) || { id: recipientId })
  for (const tap of store.getWiretaps()) {
    if (tap.agent_id === senderId || tap.agent_id === recipientId) continue
    if (tap.types && tap.types.length > 0 && eventType && !tap.types.includes(eventType)) continue
    if (!tap._ast) continue
    if (evalExprDirectional(tap._ast, { fromLabels, toLabels })) matched.add(tap.agent_id)
  }
  return [...matched]
}

test('compiled wiretap cache preserves matcher behavior and invalidates', async () => {
  const { store, cleanup } = makeStore()
  try {
    seedAgents(store)
    const tap1 = store.addWiretap('fleet:tap1', 'from:alpha & to:ops', ['chat'])
    const tap2 = store.addWiretap('fleet:tap2', 'reviewers', ['chat'])

    assert.deepEqual(
      store.resolveWiretaps('fleet:a', 'fleet:c', 'chat').sort(),
      oldWiretapScan(store, 'fleet:a', 'fleet:c', 'chat').sort()
    )
    assert.deepEqual(store.resolveWiretaps('fleet:a', 'fleet:c', 'activity'), [])

    store.removeWiretap(tap1.id)
    assert.deepEqual(
      store.resolveWiretaps('fleet:a', 'fleet:c', 'chat').sort(),
      oldWiretapScan(store, 'fleet:a', 'fleet:c', 'chat').sort(),
      'cache invalidates after remove'
    )

    store.removeWiretap(tap2.id)
    assert.deepEqual(store.resolveWiretaps('fleet:a', 'fleet:c', 'chat'), [])
  } finally {
    await cleanup()
  }
})
