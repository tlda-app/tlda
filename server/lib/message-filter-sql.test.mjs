import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'

import { parseMessageFilter } from '../../shared/fleet-labels.mjs'
import { agentNodesInMessageFilter, compileMessageFilterSql } from './message-filter-sql.mjs'

// The ids each name in these filters stands for. Resolution is the server's
// job; the compiler only ever sees the answer.
const IDS = {
  me: ['fleet:me'],
  skip: ['fleet:skip'],
  chief: ['fleet:chief'],
  pm: ['fleet:pm'],
}

function annotate(expression) {
  const ast = parseMessageFilter(expression)
  for (const node of agentNodesInMessageFilter(ast)) {
    node.ids = IDS[node.t === 'me' ? 'me' : node.v] || []
  }
  return ast
}

// A direct transcription of `matchesMessageNode` in unified-server, which is
// the authority for what a filter means. The compiler's whole job is to agree
// with this before the LIMIT instead of after it, so the test is the two
// answering the same question about the same rows.
function evaluate(node, row) {
  if (!node) return true
  const agent = (n, id) => {
    switch (n.t) {
      case 'lit':
      case 'me': return (n.ids || []).includes(id)
      case 'and': return agent(n.l, id) && agent(n.r, id)
      case 'or': return agent(n.l, id) || agent(n.r, id)
      case 'not': return !agent(n.x, id)
      default: return false
    }
  }
  const anyRecipient = (n) => (row.recipients || []).some(id => agent(n, id))
  switch (node.t) {
    case 'from': return agent(node.x, row.from || null)
    case 'to': return anyRecipient(node.x)
    case 'lit':
    case 'me': return agent(node, row.from || null) || anyRecipient(node) || agent(node, row.agentId)
    case 'since': return !row.timestamp || row.timestamp >= node.v
    case 'before': return !row.timestamp || row.timestamp < node.v
    case 'type': return row.type === node.v || row.role === node.v
    case 'and': return evaluate(node.l, row) && evaluate(node.r, row)
    case 'or': return evaluate(node.l, row) || evaluate(node.r, row)
    case 'not': return !evaluate(node.x, row)
    default: return false
  }
}

const EVENTS = [
  { id: 1, type: 'chat', timestamp: '2026-08-18T01:00:00Z', from: 'fleet:skip', agentId: null, recipients: ['fleet:chief'] },
  { id: 2, type: 'chat', timestamp: '2026-08-18T02:00:00Z', from: 'fleet:skip', agentId: null, recipients: ['fleet:me'] },
  { id: 3, type: 'chat', timestamp: '2026-08-18T03:00:00Z', from: 'fleet:me', agentId: null, recipients: ['fleet:skip'] },
  { id: 4, type: 'chat', timestamp: '2026-08-18T04:00:00Z', from: 'fleet:chief', agentId: null, recipients: ['fleet:pm', 'fleet:me'] },
  { id: 5, type: 'report', timestamp: '2026-08-18T05:00:00Z', from: 'fleet:pm', agentId: 'fleet:pm', recipients: [] },
  { id: 6, type: 'chat', timestamp: '2026-08-18T06:00:00Z', from: null, agentId: null, recipients: [] },
]

const SESSIONS = [
  { id: 11, agentId: 'fleet:chief', role: 'user', timestamp: '2026-08-18T01:30:00Z' },
  { id: 12, agentId: 'fleet:me', role: 'assistant', timestamp: '2026-08-18T02:30:00Z' },
  { id: 13, agentId: 'fleet:skip', role: 'user', timestamp: '2026-08-18T03:30:00Z' },
]

function freshDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT, timestamp TEXT, from_id TEXT, agent_id TEXT);
    CREATE TABLE recipients (event_id INTEGER, agent_id TEXT, PRIMARY KEY (event_id, agent_id));
    CREATE TABLE session_entries (id INTEGER PRIMARY KEY, agent_id TEXT, role TEXT, timestamp TEXT);
  `)
  const e = db.prepare('INSERT INTO events (id, type, timestamp, from_id, agent_id) VALUES (?,?,?,?,?)')
  const r = db.prepare('INSERT INTO recipients (event_id, agent_id) VALUES (?,?)')
  for (const row of EVENTS) {
    e.run(row.id, row.type, row.timestamp, row.from, row.agentId)
    for (const to of row.recipients) r.run(row.id, to)
  }
  const s = db.prepare('INSERT INTO session_entries (id, agent_id, role, timestamp) VALUES (?,?,?,?)')
  for (const row of SESSIONS) s.run(row.id, row.agentId, row.role, row.timestamp)
  return db
}

const EXPRESSIONS = [
  'from:skip',
  'to:me',
  'me <> skip',
  'me <> chief',
  'involving:skip',
  'skip',
  'from:skip & to:me',
  'from:skip | from:chief',
  'from:(skip | chief)',
  '!from:skip',
  'from:(!skip)',
  'to:(!me)',
  'from:(skip | chief) & !to:me',
  'from:chief & !to:pm',
  'type:chat & from:skip',
  'from:skip & since:2026-08-18T01:30:00Z',
  'from:skip & before:2026-08-18T01:30:00Z',
  'from:nobody-at-all',
  '!from:nobody-at-all',
]

test('the compiled SQL selects exactly the rows the evaluator matches', () => {
  const db = freshDb()
  try {
    for (const expression of EXPRESSIONS) {
      const ast = annotate(expression)
      const compiled = compileMessageFilterSql(ast, { idsFor: node => node.ids || [] })
      assert.ok(compiled, `"${expression}" did not compile`)

      const sqlEventIds = db.prepare(
        `SELECT e.id FROM events e WHERE ${compiled.events.sql} ORDER BY e.id`,
      ).all(...compiled.events.params).map(r => r.id)
      const jsEventIds = EVENTS.filter(row => evaluate(ast, row)).map(row => row.id)
      assert.deepEqual(sqlEventIds, jsEventIds, `events disagree for "${expression}"`)

      const sqlSessionIds = db.prepare(
        `SELECT s.id FROM session_entries s WHERE ${compiled.sessions.sql} ORDER BY s.id`,
      ).all(...compiled.sessions.params).map(r => r.id)
      // A session row has no sender and no recipients, which is what the
      // evaluator sees too.
      const jsSessionIds = SESSIONS
        .filter(row => evaluate(ast, { ...row, from: null, recipients: [] }))
        .map(row => row.id)
      assert.deepEqual(sqlSessionIds, jsSessionIds, `session rows disagree for "${expression}"`)
    }
  } finally {
    db.close()
  }
})

test('a LIMIT taken with the filter in the query returns matching rows, not leftovers', () => {
  const db = freshDb()
  try {
    // The defect this exists for: `from:skip` narrowed only to the id union —
    // every row involving Skip, in both directions — takes the newest rows of
    // THAT and lets the filter discard them afterwards. Rows 1, 2 and 3 all
    // involve Skip; only 1 and 2 are from him.
    const prefilterOnly = db.prepare(`
      SELECT e.id FROM events e
      WHERE (e.from_id = ? OR EXISTS (SELECT 1 FROM recipients rc WHERE rc.event_id = e.id AND rc.agent_id = ?))
      ORDER BY e.timestamp DESC LIMIT 2
    `).all('fleet:skip', 'fleet:skip').map(r => r.id)
    assert.deepEqual(prefilterOnly, [3, 2])
    const survivingTheFilter = prefilterOnly.filter(id => EVENTS.find(e => e.id === id).from === 'fleet:skip')
    assert.deepEqual(survivingTheFilter, [2], 'a page of 2 delivers 1 — the other slot went to a row the filter discards')

    // Same page budget, filter inside the query: 2 asked for, 2 matching rows
    // returned, and the older one is no longer hidden behind a discard.
    const ast = annotate('from:skip')
    const compiled = compileMessageFilterSql(ast, { idsFor: node => node.ids || [] })
    const withFilter = db.prepare(
      `SELECT e.id FROM events e WHERE ${compiled.events.sql} ORDER BY e.timestamp DESC LIMIT 2`,
    ).all(...compiled.events.params).map(r => r.id)
    assert.deepEqual(withFilter, [2, 1])
  } finally {
    db.close()
  }
})

test('an unresolvable name compiles to a predicate that matches nothing, not to everything', () => {
  const ast = annotate('from:nobody-at-all')
  const compiled = compileMessageFilterSql(ast, { idsFor: node => node.ids || [] })
  const db = freshDb()
  try {
    const ids = db.prepare(`SELECT e.id FROM events e WHERE ${compiled.events.sql}`).all(...compiled.events.params)
    assert.deepEqual(ids, [])
  } finally {
    db.close()
  }
})

test('an unsupported node refuses the whole filter rather than compiling part of it', () => {
  const ast = { t: 'and', l: { t: 'from', x: { t: 'lit', v: 'skip', ids: ['fleet:skip'] } }, r: { t: 'unknown-node' } }
  assert.equal(compileMessageFilterSql(ast, { idsFor: node => node.ids || [] }), null)
})
