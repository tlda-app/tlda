import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { FleetStore } from '../server/lib/fleet-store.mjs';

const BUILDER = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'build-session-history-index.mjs');

// The builder runs as its own process against its own connection. Calling a
// function that does the same CREATE INDEX would prove the SQL and nothing
// about the thing the server actually spawns, so this runs the script.
function build(dbPath) {
  return execFileSync(process.execPath, [BUILDER, dbPath], { encoding: 'utf8' });
}

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-session-index-'));
  const dbPath = join(dir, 'fleet.db');
  const store = new FleetStore(dbPath, { taskDoc: false });
  try {
    return fn(store, dbPath);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function indexExists(store) {
  return !!store.db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_session_entries_ts'"
  ).get();
}

test('the store does not create the session recency index on the boot path', () => withDb(store => {
  // The whole point of the out-of-band build: opening the store must not pay
  // for it. If someone later adds it to _createTables this fails, which is the
  // regression worth catching.
  assert.equal(indexExists(store), false);
}));

test('the builder creates the index, and running it again is a no-op', () => withDb((store, dbPath) => {
  for (let i = 0; i < 200; i++) {
    store.db.prepare(`
      INSERT INTO session_entries (agent_id, session_id, role, timestamp, text)
      VALUES (?, ?, ?, ?, ?)
    `).run('fleet:a', `session-${i}`, 'user', new Date(Date.parse('2026-08-01T00:00:00.000Z') + i * 1000).toISOString(), `entry ${i}`);
  }
  store.close();

  const first = build(dbPath);
  assert.match(first, /built in/);

  const second = build(dbPath);
  assert.match(second, /already present/);
  assert.doesNotMatch(second, /built in/);

  const reopened = new FleetStore(dbPath, { taskDoc: false });
  try {
    assert.equal(indexExists(reopened), true);
    const plan = reopened.db.prepare(
      'EXPLAIN QUERY PLAN SELECT s.id, s.text FROM session_entries s ORDER BY s.timestamp DESC LIMIT 20'
    ).all().map(row => row.detail).join(' / ');
    assert.match(plan, /idx_session_entries_ts/, `plan was: ${plan}`);
  } finally {
    reopened.close();
  }
}));

test('the builder is a no-op on a database with no session_entries table', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-session-index-bare-'));
  try {
    const dbPath = join(dir, 'bare.db');
    execFileSync(process.execPath, ['-e', `
      const D = require('better-sqlite3');
      const db = new D(process.argv[1]);
      db.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)');
      db.close();
    `, dbPath], { cwd: join(dirname(fileURLToPath(import.meta.url)), '..') });

    const out = build(dbPath);
    assert.match(out, /no session_entries table/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
