import assert from 'node:assert/strict'
import test from 'node:test'

import Database from 'better-sqlite3'

import { literalFtsQuery } from '../shared/fts-query.mjs'

test('literalFtsQuery quotes natural terms so FTS operators do not leak', () => {
  assert.equal(literalFtsQuery('teacher-bot'), '"teacher-bot"')
  assert.equal(literalFtsQuery('teacher NOT bot'), '"teacher" "NOT" "bot"')
  assert.equal(literalFtsQuery('fleet-daemon'), '"fleet-daemon"')
})

test('literal FTS query finds hyphenated text that raw FTS misparses', () => {
  const db = new Database(':memory:')
  db.exec(`
    CREATE VIRTUAL TABLE f USING fts5(text, tokenize='trigram');
    INSERT INTO f(text) VALUES ('teacher-bot appears here');
    INSERT INTO f(text) VALUES ('teacher appears without the hyphenated name');
  `)

  assert.throws(
    () => db.prepare('SELECT rowid FROM f WHERE f MATCH ?').all('teacher-bot'),
    /no such column: bot/
  )

  const rows = db.prepare('SELECT rowid FROM f WHERE f MATCH ? ORDER BY rowid').all(literalFtsQuery('teacher-bot'))
  assert.deepEqual(rows.map(r => r.rowid), [1])
})
