import assert from 'node:assert/strict'
import test from 'node:test'

import { buildFleetSearchFilters, parseSearchQuery } from '../shared/fleet-search-query.mjs'

test('search parser keeps grouped agent-set expressions in event filters', () => {
  const parsed = parseSearchQuery('agent:(skip | guidance) teacher-bot')

  assert.equal(parsed.query, 'teacher-bot')
  assert.equal(parsed.filters.filterExpression, 'involving: ( skip | guidance )')

  const filters = buildFleetSearchFilters(parsed.filters)
  assert.equal(filters.filterExpression, 'involving: ( skip | guidance )')
  assert.equal(filters.agentQuery, undefined)
})

test('search parser preserves search_logs agent argument expressions when wrapped', () => {
  const parsed = parseSearchQuery('agent:(skip | guidance) fleet-daemon')

  assert.equal(parsed.query, 'fleet-daemon')
  assert.equal(parsed.filters.filterExpression, 'involving: ( skip | guidance )')
})

test('search parser supports me inside event filters', () => {
  const parsed = parseSearchQuery('from:me fleet-daemon')

  assert.equal(parsed.query, 'fleet-daemon')
  assert.equal(parsed.filters.filterExpression, 'from: me')
})

test('search parser keeps role and time filters out of literal text', () => {
  const parsed = parseSearchQuery('role:chat since:2h before:now query-language')
  const filters = buildFleetSearchFilters(parsed.filters)

  assert.equal(parsed.query, 'query-language')
  assert.equal(filters.role, 'chat')
  assert.ok(filters.since)
  assert.ok(filters.before)
})
