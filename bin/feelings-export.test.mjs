import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'

function fixture(root) {
  const path = join(root, 'fleet.db')
  const db = new Database(path)
  db.exec(`
    CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT, timestamp TEXT, from_id TEXT, text TEXT, metadata TEXT);
    CREATE TABLE recipients (event_id INTEGER, agent_id TEXT, PRIMARY KEY (event_id, agent_id));
    CREATE TABLE agents (id TEXT PRIMARY KEY, friendly_name TEXT);
  `)
  const event = db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, NULL)')
  const recipient = db.prepare('INSERT INTO recipients VALUES (?, ?)')
  event.run(1, 'chat', '2026-01-01T00:02:00Z', 'fleet:skip', 'second')
  recipient.run(1, 'fleet:b')
  event.run(2, 'chat', '2026-01-01T00:01:00Z', 'fleet:a', 'first')
  recipient.run(2, 'fleet:skip')
  event.run(3, 'chat', '2026-01-01T00:03:00Z', 'fleet:a', 'third')
  recipient.run(3, 'fleet:skip')
  db.close()
  return path
}

test('feelings export pages through the indexed identity and preserves thread ordering', () => {
  const root = mkdtempSync(join(tmpdir(), 'feelings-export-'))
  try {
    const db = fixture(root)
    const output = join(root, 'export.jsonl')
    execFileSync(process.execPath, ['bin/feelings-export.mjs', '--db', db, '--out', output, '--no-push', '--batch-size', '1'], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
    })
    const rows = readFileSync(output, 'utf8').trim().split('\n').map(JSON.parse)
    assert.deepEqual(rows.map(row => [row.thread_id, row.msg_id]), [
      ['fleet:a', 2],
      ['fleet:a', 3],
      ['fleet:b', 1],
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('feelings export stops at its explicit total-row safety bound', () => {
  const root = mkdtempSync(join(tmpdir(), 'feelings-export-limit-'))
  try {
    const db = fixture(root)
    assert.throws(() => execFileSync(process.execPath, [
      'bin/feelings-export.mjs', '--db', db, '--out', join(root, 'export.jsonl'), '--no-push', '--max-messages', '2', '--batch-size', '1',
    ], { cwd: new URL('..', import.meta.url), stdio: 'pipe' }), error => {
      assert.match(String(error.stderr), /exceeds the 2 message safety limit/)
      return true
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
