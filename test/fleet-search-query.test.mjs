import assert from 'node:assert/strict'
import test from 'node:test'

import { evalExprDirectional, parseFilter, parseMessageFilter } from '../shared/fleet-labels.mjs'
import {
  buildFleetSearchFilters,
  parseAgentSelector,
  parseSearchQuery,
  rankSearchResults,
} from '../src/fleet/search-query.ts'

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
