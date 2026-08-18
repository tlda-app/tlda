import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import Database from 'better-sqlite3'

// `activity_events_fts` is an external-content FTS5 table, and the only way to
// remove a row from one is to hand back the text that was indexed. FTS5 does not
// verify that text: a mismatch is accepted and silently corrupts the index, and
// nothing surfaces until a later search returns wrong results. That is both
// silent and destructive, which is what these tests are for.
//
// The schema and trigger below are copied from `sqlite_master` on the deployed
// database rather than from fleet-store.mjs, which carries three definitions of
// `events_ai` and only one of them is the one in effect.
const SCHEMA = `
CREATE TABLE events (
  id INTEGER PRIMARY KEY, type TEXT, timestamp TEXT, from_id TEXT,
  text TEXT, metadata TEXT, task_id TEXT, agent_id TEXT);
CREATE INDEX idx_events_type_id ON events(type, id);
CREATE TABLE search_index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE VIRTUAL TABLE events_fts USING fts5(
  text, content='events', content_rowid='id', tokenize='trigram');
CREATE VIRTUAL TABLE activity_events_fts USING fts5(
  text, content='events', content_rowid='id', tokenize='trigram');
CREATE TRIGGER events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, text) VALUES (
    new.id, CASE WHEN new.type = 'activity' THEN '' ELSE new.text END);
  INSERT INTO activity_events_fts(rowid, text)
  SELECT new.id, trim(
      coalesce(new.text, '') || ' ' ||
      coalesce(json_extract(new.metadata, '$.tool'), '') || ' ' ||
      coalesce(json_extract(new.metadata, '$.description'), '') || ' ' ||
      coalesce(json_extract(new.metadata, '$.input.description'), '') || ' ' ||
      coalesce(json_extract(new.metadata, '$.arg'), '') || ' ' ||
      coalesce(json_extract(new.metadata, '$.input.command'), ''))
  WHERE new.type = 'activity';
END;`

// Must stay identical to FleetStore._ACTIVITY_FTS_TEXT. If that drifts from the
// trigger, these tests fail on the integrity check rather than in production.
const INDEXED_TEXT = (a) => `trim(
  coalesce(${a}.text, '') || ' ' ||
  coalesce(json_extract(${a}.metadata, '$.tool'), '') || ' ' ||
  coalesce(json_extract(${a}.metadata, '$.description'), '') || ' ' ||
  coalesce(json_extract(${a}.metadata, '$.input.description'), '') || ' ' ||
  coalesce(json_extract(${a}.metadata, '$.arg'), '') || ' ' ||
  coalesce(json_extract(${a}.metadata, '$.input.command'), ''))`

// Shapes that a naive delete expression gets wrong: null text, null metadata,
// empty object, unicode, embedded quotes, significant surrounding whitespace.
const SHAPES = [
  ['ran the build', '{"tool":"Bash","input":{"command":"npm run build"}}'],
  [null, '{"tool":"Grep","description":"search for widgets"}'],
  ['', '{}'],
  [null, null],
  ['déjà vu — em dash', '{"tool":"Read","arg":"/tmp/a b.txt"}'],
  ['quote \' and " inside', '{"tool":"Edit","input":{"description":"fix it"}}'],
  ['   leading and trailing   ', '{"tool":"Write"}'],
]

const DAY = 24 * 60 * 60 * 1000

function makeDb(t) {
  const dir = mkdtempSync(join(tmpdir(), 'activity-fts-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const db = new Database(join(dir, 'fleet.db'))
  db.exec(SCHEMA)
  const insert = db.prepare(
    'INSERT INTO events (type, timestamp, text, metadata) VALUES (?,?,?,?)')
  const old = new Date(Date.now() - 60 * DAY).toISOString()
  const recent = new Date(Date.now() - 2 * DAY).toISOString()
  for (const [text, meta] of SHAPES) {
    insert.run('activity', old, text, meta)
    insert.run('activity', recent, text, meta)
  }
  for (const [text, meta] of SHAPES) insert.run('chat', old, text ?? 'chat text', meta)
  return db
}

// The prune under test, as fleet-store.mjs runs it.
function prune(db, { cutoff, limit }) {
  return db.transaction(() => {
    const mark = Number(db.prepare(
      "SELECT value FROM search_index_meta WHERE key='activity_fts_pruned_through_id'"
    ).get()?.value) || 0
    const rows = db.prepare(
      `SELECT id FROM events WHERE type='activity' AND id > ? AND timestamp < ?
       ORDER BY id ASC LIMIT ?`).all(mark, cutoff, limit)
    if (!rows.length) return { deleted: 0, through: mark }
    const through = rows[rows.length - 1].id
    const deleted = db.prepare(`
      INSERT INTO activity_events_fts(activity_events_fts, rowid, text)
      SELECT 'delete', e.id, ${INDEXED_TEXT('e')} FROM events e
      WHERE e.type='activity' AND e.id > ? AND e.id <= ? AND e.timestamp < ?`
    ).run(mark, through, cutoff).changes
    db.prepare(
      `INSERT INTO search_index_meta(key,value) VALUES ('activity_fts_pruned_through_id', ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(through))
    return { deleted, through }
  })()
}

const integrity = (db, table) => {
  db.exec(`INSERT INTO ${table}(${table}) VALUES('integrity-check')`)
}
const cutoff30 = () => new Date(Date.now() - 30 * DAY).toISOString()

// One distinctive substring per field the trigger concatenates. If the delete
// expression omits or reorders any field, that field's terms are never removed
// from the index and its probe still finds the old row.
//
// `integrity-check` does NOT catch this and must not be relied on: it verifies
// the index's internal structure, not that it agrees with the content table. A
// deliberately broken delete expression (one field dropped) passed every
// integrity-check in this file, which is why the probes below exist.
const FIELD_PROBES = [
  ['text', 'em dash'],
  ['$.tool', 'Grep'],
  ['$.description', 'search for widgets'],
  ['$.input.description', 'fix it'],
  ['$.arg', 'a b.txt'],
  ['$.input.command', 'npm run build'],
]

test('every indexed field is actually removed from the index', (t) => {
  const db = makeDb(t)
  const hits = (term) => db.prepare(
    'SELECT COUNT(*) c FROM activity_events_fts WHERE activity_events_fts MATCH ?'
  ).get(`"${term}"`).c

  const before = FIELD_PROBES.map(([, term]) => hits(term))
  for (const [i, [field]] of FIELD_PROBES.entries()) {
    assert.equal(before[i], 2, `${field}: one old row and one recent row to start`)
  }

  const cutoff = cutoff30()
  let total = 0, round
  while ((round = prune(db, { cutoff, limit: 3 })).deleted > 0) total += round.deleted
  assert.equal(total, SHAPES.length, 'every old activity row pruned, across batches')

  // The load-bearing assertion. A delete expression that does not reproduce the
  // indexed text exactly leaves that field's postings behind, and the old row
  // stays findable by them — silently, with no error anywhere.
  for (const [field, term] of FIELD_PROBES) {
    assert.equal(hits(term), 1,
      `${field}: old row still matches "${term}" — the delete text does not match what was indexed`)
  }
  assert.doesNotThrow(() => integrity(db, 'activity_events_fts'))
})

test('conversation search is untouched', (t) => {
  const db = makeDb(t)
  while (prune(db, { cutoff: cutoff30(), limit: 100 }).deleted > 0) { /* drain */ }
  assert.doesNotThrow(() => integrity(db, 'events_fts'))
  const chat = db.prepare(
    'SELECT COUNT(*) c FROM events_fts WHERE events_fts MATCH ?').get('"em dash"').c
  assert.ok(chat > 0, 'chat text still findable after an activity prune')
})

test('only activity past the horizon loses its index entry', (t) => {
  const db = makeDb(t)
  const before = db.prepare(
    'SELECT COUNT(*) c FROM activity_events_fts WHERE activity_events_fts MATCH ?').get('"Bash"').c
  assert.equal(before, 2, 'one old and one recent to start')
  while (prune(db, { cutoff: cutoff30(), limit: 100 }).deleted > 0) { /* drain */ }
  const after = db.prepare(
    'SELECT COUNT(*) c FROM activity_events_fts WHERE activity_events_fts MATCH ?').get('"Bash"').c
  assert.equal(after, 1, 'recent activity still searchable, old is not')
})

test('the events themselves are never deleted', (t) => {
  const db = makeDb(t)
  const before = db.prepare("SELECT COUNT(*) c FROM events WHERE type='activity'").get().c
  while (prune(db, { cutoff: cutoff30(), limit: 100 }).deleted > 0) { /* drain */ }
  const after = db.prepare("SELECT COUNT(*) c FROM events WHERE type='activity'").get().c
  assert.equal(after, before, 'activity history stays readable; only search over it goes')
})

test('a repeated sweep deletes nothing twice', (t) => {
  const db = makeDb(t)
  const cutoff = cutoff30()
  while (prune(db, { cutoff, limit: 100 }).deleted > 0) { /* drain */ }
  // FTS5 has no "delete if present". Deleting the same rowid twice raises
  // SQLITE_CORRUPT_VTAB, "database disk image is malformed", on the second
  // delete and the index is unusable from then on — verified directly, not
  // assumed. The watermark is the only thing standing between a retried or
  // overlapping sweep and that, so this asserts it holds.
  assert.equal(prune(db, { cutoff, limit: 100 }).deleted, 0)
  assert.doesNotThrow(() => integrity(db, 'activity_events_fts'))
})
