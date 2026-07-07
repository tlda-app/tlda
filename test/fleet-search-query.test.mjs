import assert from 'node:assert/strict'
import test from 'node:test'

import { evalExprDirectional, parseFilter, parseMessageFilter } from '../shared/fleet-labels.mjs'
import {
  buildFleetSearchFilters,
  parseAgentSelector,
  parseSearchQuery,
  rankSearchResults,
} from '../src/fleet/search-query.ts'
import { FleetStore } from '../server/lib/fleet-store.mjs'

test('parses single reflog position selector', () => {
  assert.deepEqual(parseAgentSelector('chief~2'), {
    fragment: 'chief',
    scope: 'any',
    expansion: 'stack',
    match: 'substring',
    position: 2,
  })
})

test('parses open-ended, bounded, and top-N reflog ranges', () => {
  assert.deepEqual(parseAgentSelector('chief~2..'), {
    fragment: 'chief',
    scope: 'any',
    expansion: 'stack',
    match: 'substring',
    range: { from: 2, to: null },
  })
  assert.deepEqual(parseAgentSelector('chief~2..5'), {
    fragment: 'chief',
    scope: 'any',
    expansion: 'stack',
    match: 'substring',
    range: { from: 2, to: 5 },
  })
  assert.deepEqual(parseAgentSelector('chief..3'), {
    fragment: 'chief',
    scope: 'any',
    expansion: 'stack',
    match: 'substring',
    range: { from: null, to: 3 },
  })
  assert.deepEqual(parseAgentSelector('chief~..3'), {
    fragment: 'chief',
    scope: 'any',
    expansion: 'stack',
    match: 'substring',
    range: { from: null, to: 3 },
  })
})

test('parses colon all-but-current range and phase together', () => {
  assert.deepEqual(parseAgentSelector('chief:day:1..', 'from'), {
    fragment: 'chief',
    scope: 'from',
    expansion: 'stack',
    match: 'substring',
    phase: 'day',
    range: { from: 1, to: null },
  })
})

test('search query lowers legacy agent syntax to unified message expression', () => {
  const parsed = parseSearchQuery('agent:chief~1..3 role:assistant before:2026-07-03 consensus')
  assert.equal(parsed.query, 'consensus')
  assert.deepEqual(buildFleetSearchFilters(parsed.filters), {
    agentResolve: {
      fragment: 'chief',
      scope: 'any',
      expansion: 'stack',
      match: 'substring',
      range: { from: 1, to: 3 },
    },
    role: 'assistant',
    before: '2026-07-03T00:00:00.000Z',
    filterExpression: 'involving:chief~1..3',
  })
})

test('bare single-token search also asks the server to resolve an involved agent', () => {
  const parsed = parseSearchQuery('msg-threading')
  assert.equal(parsed.query, 'msg-threading')
  assert.deepEqual(buildFleetSearchFilters(parsed.filters), {
    naturalAgentQuery: 'msg-threading',
    naturalAgentQueries: ['msg-threading'],
  })
})

test('multi-token content search keeps the full text query', () => {
  const parsed = parseSearchQuery('message threading')
  assert.equal(parsed.query, 'message threading')
  assert.deepEqual(parsed.filters.naturalTextQuery, 'message threading')
})

test('search query preserves tilde top-N ranges in message filters', () => {
  const parsed = parseSearchQuery('from:chief~..3')
  assert.equal(parsed.query, '')
  assert.deepEqual(buildFleetSearchFilters(parsed.filters), {
    agentResolve: {
      fragment: 'chief',
      scope: 'from',
      expansion: 'stack',
      match: 'substring',
      range: { from: null, to: 3 },
    },
    filterExpression: 'from:chief~..3',
  })
})

test('bare lineage selector becomes a natural involved-agent candidate', () => {
  const parsed = parseSearchQuery('chief~..3')
  assert.equal(parsed.query, 'chief~..3')
  assert.deepEqual(buildFleetSearchFilters(parsed.filters), {
    naturalAgentQuery: 'chief~..3',
    naturalAgentQueries: ['chief~..3'],
  })
})

test('bare lineage selector composes with remaining text as a narrowing query', () => {
  const parsed = parseSearchQuery('chief~..3 consensus')
  assert.equal(parsed.query, 'chief~..3 consensus')
  assert.deepEqual(buildFleetSearchFilters(parsed.filters), {
    naturalAgentQuery: 'chief~..3',
    naturalAgentQueries: ['chief~..3', 'consensus'],
    naturalTextQuery: 'consensus',
  })
})

test('parses directional wrappers and between sugar through the shared grammar', () => {
  assert.deepEqual(parseMessageFilter('from:(chief | tabby) & !to:me'), {
    t: 'and',
    l: { t: 'from', x: { t: 'or', l: { t: 'lit', v: 'chief' }, r: { t: 'lit', v: 'tabby' } } },
    r: { t: 'not', x: { t: 'to', x: { t: 'me' } } },
  })
  assert.deepEqual(parseMessageFilter('chief <> tabby'), {
    t: 'or',
    l: { t: 'and', l: { t: 'from', x: { t: 'lit', v: 'chief' } }, r: { t: 'to', x: { t: 'lit', v: 'tabby' } } },
    r: { t: 'and', l: { t: 'from', x: { t: 'lit', v: 'tabby' } }, r: { t: 'to', x: { t: 'lit', v: 'chief' } } },
  })
})

test('existing directional filter evaluation still works for wiretap filters', () => {
  const ast = parseFilter('to:fleet:rec & from:fleet:snd')
  assert.equal(evalExprDirectional(ast, { fromLabels: ['fleet:snd'], toLabels: ['fleet:rec'] }), true)
  assert.equal(evalExprDirectional(ast, { fromLabels: ['fleet:rec'], toLabels: ['fleet:snd'] }), false)
})

test('ranking prefers exact query matches without roster access', () => {
  const ranked = rankSearchResults([
    { id: 1, text: 'partial consensus only', timestamp: '2026-07-03T00:00:03.000Z' },
    { id: 2, text: 'alpha beta appears exactly', timestamp: '2026-07-03T00:00:01.000Z' },
    { id: 3, text: 'alpha appears later', timestamp: '2026-07-03T00:00:04.000Z' },
  ], 'alpha beta')
  assert.deepEqual(ranked.map(r => r.id), [2, 3, 1])
})

test('server consumes unified selector phase and range metadata', () => {
  const store = new FleetStore(':memory:')
  try {
    store.upsertAgent({ id: 'fleet:dawn', friendly_name: 'chief', labels: [], status: 'awake' })
    store.upsertAgent({ id: 'fleet:day', friendly_name: 'chief:day', labels: [], status: 'awake' })
    store.upsertAgent({ id: 'fleet:dusk', friendly_name: 'chief:dusk', labels: [], status: 'awake' })

    assert.deepEqual(store.resolveAgentSelector({ fragment: 'chief', phase: 'day' }), ['fleet:day'])
    assert.deepEqual(store.resolveAgentSelector({ fragment: 'chief', range: { from: null, to: 2 } }).length, 2)
    assert.deepEqual(store.resolveAgentSelector(parseAgentSelector('chief~..2')).length, 2)
    assert.deepEqual(store.resolveAgentSelector(parseAgentSelector('chief~2..3')).length, 2)
    assert.deepEqual(store.resolveAgentSelector({ fragment: 'chief', position: 2 }).length, 1)
  } finally {
    store.close()
  }
})
