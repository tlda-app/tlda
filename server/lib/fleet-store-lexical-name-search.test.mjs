// A name binds at the point of use.
//
// `chief` names one agent up to the handoff and a different one after it, so a
// search for `chief` must return each agent's messages from ITS OWN period and
// neither one's from the other's. Resolving the name once, up front, into a
// flat id set cannot express that: with one answer for the whole query the only
// way not to lose the former holder's history is to include both, and the
// result is three agents' traffic blended together with nothing to tell them
// apart.
//
// Every assertion below distinguishes the two. If the resolution is hoisted
// above the row — anywhere between the resolver and the predicate — the
// out-of-period events come back and these fail.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { parseMessageFilter } from '../../shared/fleet-labels.mjs'
import { FleetStore } from './fleet-store.mjs'
import { agentNodesInMessageFilter } from './message-filter-sql.mjs'

function withStore(run) {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-lexical-name-'))
  const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
  try {
    return run(store)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function insertEvent(store, { timestamp, from, to, text }) {
  const info = store.db.prepare(`
    INSERT INTO events (type, timestamp, from_id, text)
    VALUES ('chat', ?, ?, ?)
  `).run(timestamp, from, text)
  for (const agentId of (Array.isArray(to) ? to : [to]).filter(Boolean)) {
    store.db.prepare(`
      INSERT OR IGNORE INTO recipients (event_id, agent_id, timestamp, read) VALUES (?, ?, ?, 0)
    `).run(info.lastInsertRowid, agentId, timestamp)
  }
  return info.lastInsertRowid
}

function shift(iso, ms) {
  return new Date(Date.parse(iso) + ms).toISOString().replace(/\.(\d{3})Z$/, '.$1Z')
}

const HOUR = 60 * 60 * 1000

// Two agents, one name, one handoff. The rename triggers stamp the boundary
// with their own clock, so the events are placed relative to the spans the
// store actually recorded rather than to a time this test made up.
function seedHandoff(store) {
  store.upsertAgent({ id: 'fleet:first', friendly_name: 'chief', registered_at: '2026-08-18T00:00:00.000Z' })
  store.upsertAgent({ id: 'fleet:first', friendly_name: 'retired-chief' })
  store.upsertAgent({ id: 'fleet:second', friendly_name: 'chief' })
  store.upsertAgent({ id: 'fleet:onlooker', friendly_name: 'onlooker', registered_at: '2026-08-18T00:00:00.000Z' })

  const spanOf = (id) => store.db.prepare(
    "SELECT from_ts, to_ts FROM name_history WHERE fleet_id = ? AND friendly_name = 'chief'",
  ).get(id)
  const first = spanOf('fleet:first')
  const second = spanOf('fleet:second')
  assert.ok(first?.to_ts, 'the first holder\'s chief span must be closed')
  assert.equal(second?.to_ts, null, 'the second holder still holds the name')

  const events = {
    // Each holder says something while it IS chief, and something while it is not.
    firstInPeriod: insertEvent(store, {
      timestamp: shift(first.to_ts, -HOUR), from: 'fleet:first', to: 'fleet:onlooker', text: 'first while chief',
    }),
    firstOutOfPeriod: insertEvent(store, {
      timestamp: shift(first.to_ts, HOUR), from: 'fleet:first', to: 'fleet:onlooker', text: 'first after handing the name on',
    }),
    secondInPeriod: insertEvent(store, {
      timestamp: shift(second.from_ts, HOUR), from: 'fleet:second', to: 'fleet:onlooker', text: 'second while chief',
    }),
    secondOutOfPeriod: insertEvent(store, {
      timestamp: shift(second.from_ts, -2 * HOUR), from: 'fleet:second', to: 'fleet:onlooker', text: 'second before it held the name',
    }),
    // Addressed TO each holder, on the same two sides of the boundary.
    toFirstInPeriod: insertEvent(store, {
      timestamp: shift(first.to_ts, -HOUR), from: 'fleet:onlooker', to: 'fleet:first', text: 'to first while chief',
    }),
    toFirstOutOfPeriod: insertEvent(store, {
      timestamp: shift(first.to_ts, HOUR), from: 'fleet:onlooker', to: 'fleet:first', text: 'to first after the handoff',
    }),
  }
  return events
}

function idsOf(rows) {
  return rows.map(row => Number(row.id)).sort((a, b) => a - b)
}

function expected(events, ...keys) {
  return keys.map(key => Number(events[key])).sort((a, b) => a - b)
}

test('a handed-on name reaches both holders — that is the candidate set, not the answer', () => withStore(store => {
  seedHandoff(store)
  const ids = store.resolveAgentSelector({ fragment: 'chief' })
  assert.deepEqual([...ids].sort(), ['fleet:first', 'fleet:second'])

  // The same query, as spans: who, and when.
  const spans = store.resolveAgentSpans({ fragment: 'chief' })
  assert.equal(spans.length, 2, 'one span per holder')
  const first = spans.find(span => span.id === 'fleet:first')
  const second = spans.find(span => span.id === 'fleet:second')
  assert.ok(first.to_ts, 'the former holder\'s span is closed at the handoff')
  assert.equal(second.to_ts, null, 'the current holder\'s span is open')
  assert.ok(first.to_ts <= second.from_ts, 'the spans do not overlap')
}))

test('searching a handed-on name returns each holder\'s own period only', () => withStore(store => {
  const events = seedHandoff(store)
  const spans = store.resolveAgentSpans({ fragment: 'chief' })
  const rows = store.searchAll('', {
    agent: [...new Set(spans.map(span => span.id))],
    agentSpans: spans,
    types: ['chat'],
    agentOnly: true,
    eventOnly: true,
    limit: 50,
  })
  assert.deepEqual(
    idsOf(rows),
    expected(events, 'firstInPeriod', 'secondInPeriod', 'toFirstInPeriod'),
    'each holder answers for its own period, and for no part of the other\'s',
  )
}))

test('`from:chief` compiles to the holder at each message\'s own timestamp', () => withStore(store => {
  const events = seedHandoff(store)
  const ast = parseMessageFilter('from:chief')
  for (const node of agentNodesInMessageFilter(ast)) {
    node.spans = store.resolveAgentSpans({ fragment: node.v })
  }
  const rows = store.searchAll('', {
    agent: [...new Set(agentNodesInMessageFilter(ast).flatMap(node => node.spans.map(span => span.id)))],
    fromOnly: true,
    agentOnly: true,
    eventOnly: true,
    types: ['chat'],
    messageFilterAst: ast,
    limit: 50,
  })
  assert.deepEqual(
    idsOf(rows),
    expected(events, 'firstInPeriod', 'secondInPeriod'),
    '`from:` is the sender at the instant it sent, not everyone who ever held the name',
  )
}))

test('an id names the same agent at every instant', () => withStore(store => {
  const events = seedHandoff(store)
  const spans = store.resolveAgentSpans({ fragment: 'fleet:first' })
  assert.deepEqual(spans, [{ id: 'fleet:first', from_ts: null, to_ts: null }])
  const rows = store.searchAll('', {
    agent: ['fleet:first'],
    agentSpans: spans,
    types: ['chat'],
    agentOnly: true,
    eventOnly: true,
    limit: 50,
  })
  assert.deepEqual(
    idsOf(rows),
    expected(events, 'firstInPeriod', 'firstOutOfPeriod', 'toFirstInPeriod', 'toFirstOutOfPeriod'),
    'reaching an agent by id is unconditional — that is the difference between an id and a name',
  )
}))

test('a name the fleet has never used resolves to nothing, not to everything', () => withStore(store => {
  seedHandoff(store)
  assert.deepEqual(store.resolveAgentSpans({ fragment: 'nobody-at-all' }), [])
  assert.deepEqual(store.resolveAgentSelector({ fragment: 'nobody-at-all' }), [])
}))

// Completing a fragment to a whole name is the picker's job, and it does it
// before the query is submitted. In the query language a name is a reference.
test('a name fragment is not a name', () => withStore(store => {
  seedHandoff(store)
  assert.deepEqual(store.resolveAgentSelector({ fragment: 'chie' }), [], 'a prefix is not the name')
  assert.deepEqual(store.resolveAgentSelector({ fragment: 'hief' }), [], 'nor is a suffix')
  // Case is not part of the reference.
  assert.deepEqual(
    [...store.resolveAgentSelector({ fragment: 'CHIEF' })].sort(),
    ['fleet:first', 'fleet:second'],
  )
}))
