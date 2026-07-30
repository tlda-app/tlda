import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FleetStore } from '../server/lib/fleet-store.mjs'
import { buildFleetSearchFilters, parseSearchQuery } from '../shared/fleet-search-query.mjs'
import { searchAutocompleteSuggestions } from '../src/fleet/search-autocomplete.ts'

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-search-grammar-'))
  const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
  try {
    return fn(store)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function insertEvent(store, event) {
  store.db.prepare(`
    INSERT INTO events (type, timestamp, from_id, to_id, text, metadata, task_id, agent_id)
    VALUES (@type, @timestamp, @from, @to, @text, @metadata, @taskId, @agentId)
  `).run({
    type: event.type,
    timestamp: event.timestamp,
    from: event.from || null,
    to: event.to || null,
    text: event.text || '',
    metadata: event.metadata ? JSON.stringify(event.metadata) : null,
    taskId: event.taskId || null,
    agentId: event.agentId || null,
  })
}

test('type category parses to an end-to-end event type filter', () => withStore(store => {
  insertEvent(store, {
    type: 'chat',
    timestamp: '2026-07-30T12:00:00.000Z',
    from: 'fleet:skip',
    to: 'fleet:pretty',
    text: 'category-only search should not return this chat',
  })
  insertEvent(store, {
    type: 'report',
    timestamp: '2026-07-30T12:01:00.000Z',
    from: 'fleet:pretty',
    text: 'category-only search should return this report',
  })

  const parsed = parseSearchQuery('type:report')
  const filters = buildFleetSearchFilters(parsed.filters)

  assert.equal(parsed.query, '')
  assert.equal(parsed.filters.type, 'report')
  assert.equal(filters.eventType, 'report')
  assert.equal(filters.filterExpression, 'type:report')

  const results = store.searchAll(parsed.query, {
    type: filters.eventType,
    historyOnly: !parsed.query,
    limit: 10,
  })
  assert.deepEqual(results.map(row => row.type), ['report'])
}))

test('explicit ampersand and implicit whitespace both require all search terms', () => withStore(store => {
  insertEvent(store, {
    type: 'chat',
    timestamp: '2026-07-30T12:00:00.000Z',
    from: 'fleet:skip',
    to: 'fleet:pretty',
    text: 'alpha only',
  })
  insertEvent(store, {
    type: 'chat',
    timestamp: '2026-07-30T12:01:00.000Z',
    from: 'fleet:skip',
    to: 'fleet:pretty',
    text: 'beta only',
  })
  insertEvent(store, {
    type: 'chat',
    timestamp: '2026-07-30T12:02:00.000Z',
    from: 'fleet:skip',
    to: 'fleet:pretty',
    text: 'alpha beta together',
  })

  const explicit = parseSearchQuery('alpha & beta')
  assert.equal(explicit.query, 'alpha beta')
  assert.deepEqual(store.searchAll(explicit.query, { limit: 10 }).map(row => row.text), ['alpha beta together'])
  assert.deepEqual(store.searchAll('alpha beta', { limit: 10 }).map(row => row.text), ['alpha beta together'])
}))

test('autocomplete exposes only executable text operators and me through ordinary agent values', () => {
  const initialSuggestions = searchAutocompleteSuggestions('', 0, {})
  assert.equal(initialSuggestions.some(item => item.kind === 'operator'), false)

  const operators = searchAutocompleteSuggestions('alpha ', 'alpha '.length, {})
  assert.ok(operators.some(item => item.id === 'operator:and' && item.insert === '& '))
  assert.equal(operators.some(item => item.id === 'operator:or' || item.id === 'operator:not' || item.label === '(' || item.label === ')'), false)

  const agentValues = searchAutocompleteSuggestions('from:', 'from:'.length, {
    agents: [{ id: 'fleet:pretty', friendly_name: 'pretty', labels: ['reviewer'] }],
  })
  assert.equal(agentValues[0].id, 'agent:from:me')
  assert.ok(agentValues.some(item => item.id === 'agent:from:me' && item.insert === 'from:me '))
  assert.ok(agentValues.some(item => item.id === 'agent:from:pretty' && item.insert === 'from:pretty '))
})
