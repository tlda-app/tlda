// The `unread` → `recipients` migration, against the real pre-change schema.
//
// This migration is exactly the failure shape that earns a test: if it drops a
// row or attributes one to the wrong agent, nothing raises. The message is
// simply gone from somebody's history, or present in somebody else's, and the
// only way anyone finds out is by missing it.
//
// The DDL below is `events` and `unread` verbatim from c369783f9, the commit
// this branch forked from — not an approximation of it. FleetStore's own
// _createTables runs the migration when it opens the file.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { FleetStore } from '../server/lib/fleet-store.mjs';

const LEGACY_DDL = `
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    from_id TEXT,
    to_id TEXT,
    text TEXT,
    metadata TEXT,
    task_id TEXT,
    agent_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_events_to ON events(to_id, timestamp DESC);

  CREATE TABLE IF NOT EXISTS unread (
    event_id INTEGER REFERENCES events(id),
    to_id TEXT NOT NULL,
    read INTEGER DEFAULT 0,
    PRIMARY KEY (event_id, to_id)
  );
  CREATE INDEX IF NOT EXISTS idx_unread_to ON unread(to_id, read);
`;

// Seed a database in the OLD shape, then hand the path to FleetStore, which
// migrates it on open. Returns whatever the callback makes of the migrated store.
function withMigratedStore(seed, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-recipients-migration-'));
  const file = join(dir, 'fleet.db');
  const legacy = new Database(file);
  legacy.exec(LEGACY_DDL);
  seed(legacy);
  legacy.close();

  const store = new FleetStore(file, { taskDoc: false });
  try {
    return fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const insertLegacyEvent = (db, { id, from, to, text, timestamp, type = 'chat' }) =>
  db.prepare(`
    INSERT INTO events (id, type, timestamp, from_id, to_id, text)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, type, timestamp, from, to, text);

const insertLegacyUnread = (db, eventId, toId, read) =>
  db.prepare('INSERT INTO unread (event_id, to_id, read) VALUES (?, ?, ?)')
    .run(eventId, toId, read);

const recipientsOf = (store, eventId) => store.db
  .prepare('SELECT agent_id, read FROM recipients WHERE event_id = ? ORDER BY agent_id')
  .all(eventId);

test('every historical recipient survives the migration, attributed to the same agent', () => {
  withMigratedStore(db => {
    insertLegacyEvent(db, { id: 1, from: 'fleet:skip', to: 'fleet:a', text: 'one', timestamp: '2026-07-01T00:00:00.000Z' });
    insertLegacyEvent(db, { id: 2, from: 'fleet:a', to: 'fleet:skip', text: 'two', timestamp: '2026-07-01T00:00:01.000Z' });
    insertLegacyEvent(db, { id: 3, from: 'fleet:skip', to: 'fleet:b', text: 'three', timestamp: '2026-07-01T00:00:02.000Z' });
    // Event 4 has a to_id and NO unread row — the shape reachable only through
    // the backfill. Without it in the fixture this test passes even when the
    // backfill is deleted outright, which is the whole failure it exists to catch.
    insertLegacyEvent(db, { id: 4, from: 'fleet:skip', to: 'fleet:c', text: 'four', timestamp: '2026-07-01T00:00:03.000Z' });
    insertLegacyUnread(db, 1, 'fleet:a', 0);
    insertLegacyUnread(db, 2, 'fleet:skip', 1);
    insertLegacyUnread(db, 3, 'fleet:b', 0);
  }, store => {
    assert.deepEqual(recipientsOf(store, 1).map(r => r.agent_id), ['fleet:a']);
    assert.deepEqual(recipientsOf(store, 2).map(r => r.agent_id), ['fleet:skip']);
    assert.deepEqual(recipientsOf(store, 3).map(r => r.agent_id), ['fleet:b']);
    assert.deepEqual(recipientsOf(store, 4).map(r => r.agent_id), ['fleet:c']);

    // Nothing invented and nothing lost: four events in, four recipient rows out.
    const total = store.db.prepare('SELECT COUNT(*) AS c FROM recipients').get().c;
    assert.equal(total, 4);

    // And no recipient ended up on somebody else's message.
    const misattributed = store.db.prepare(`
      SELECT COUNT(*) AS c FROM recipients WHERE event_id NOT IN (SELECT id FROM events)
    `).get().c;
    assert.equal(misattributed, 0);
  });
});

test('read state carried on the unread row wins over the to_id backfill', () => {
  withMigratedStore(db => {
    insertLegacyEvent(db, { id: 1, from: 'fleet:skip', to: 'fleet:a', text: 'unread', timestamp: '2026-07-01T00:00:00.000Z' });
    insertLegacyEvent(db, { id: 2, from: 'fleet:skip', to: 'fleet:a', text: 'read', timestamp: '2026-07-01T00:00:01.000Z' });
    insertLegacyUnread(db, 1, 'fleet:a', 0);
    insertLegacyUnread(db, 2, 'fleet:a', 1);
  }, store => {
    // The backfill inserts read=1 for every to_id. It must not overwrite the
    // genuine unread row, or the agent silently loses an unread message.
    assert.deepEqual(recipientsOf(store, 1), [{ agent_id: 'fleet:a', read: 0 }]);
    assert.deepEqual(recipientsOf(store, 2), [{ agent_id: 'fleet:a', read: 1 }]);
  });
});

test('an event whose unread row was deleted still records who it went to', () => {
  withMigratedStore(db => {
    // Task retract/retire used to DELETE the unread row. Under the new meaning
    // that row is the record of delivery, so the to_id backfill has to restore
    // it — as read, since resurfacing all of history unread would be worse.
    insertLegacyEvent(db, { id: 1, from: 'fleet:skip', to: 'fleet:a', text: 'retired', timestamp: '2026-07-01T00:00:00.000Z' });
  }, store => {
    assert.deepEqual(recipientsOf(store, 1), [{ agent_id: 'fleet:a', read: 1 }]);
  });
});

test('an event with several unread rows keeps every one of them', () => {
  withMigratedStore(db => {
    // The old table already held several rows per event for CC and wiretap
    // recipients. That is the shape group send generalises, so it must survive.
    insertLegacyEvent(db, { id: 1, from: 'fleet:skip', to: 'fleet:a', text: 'cc', timestamp: '2026-07-01T00:00:00.000Z' });
    insertLegacyUnread(db, 1, 'fleet:a', 0);
    insertLegacyUnread(db, 1, 'fleet:b', 0);
    insertLegacyUnread(db, 1, 'fleet:c', 1);
  }, store => {
    assert.deepEqual(recipientsOf(store, 1), [
      { agent_id: 'fleet:a', read: 0 },
      { agent_id: 'fleet:b', read: 0 },
      { agent_id: 'fleet:c', read: 1 },
    ]);
  });
});

test('an event with no recipient at all gains none', () => {
  withMigratedStore(db => {
    insertLegacyEvent(db, { id: 1, from: 'fleet:a', to: null, text: 'broadcast', timestamp: '2026-07-01T00:00:00.000Z', type: 'lifecycle' });
  }, store => {
    assert.deepEqual(recipientsOf(store, 1), []);
  });
});

test('the scalar column is gone and the recipient rows carry a sort key', () => {
  withMigratedStore(db => {
    insertLegacyEvent(db, { id: 1, from: 'fleet:skip', to: 'fleet:a', text: 'one', timestamp: '2026-07-01T00:00:00.000Z' });
    insertLegacyUnread(db, 1, 'fleet:a', 0);
  }, store => {
    const eventCols = store.db.prepare('PRAGMA table_info(events)').all().map(c => c.name);
    assert.ok(!eventCols.includes('to_id'), 'events.to_id must be dropped, not left as a second source of truth');

    // Rows that predate the rename carry no timestamp of their own; the
    // migration backfills it from the event, and recipient-scoped reads order by it.
    const row = store.db.prepare('SELECT timestamp FROM recipients WHERE event_id = 1').get();
    assert.equal(row.timestamp, '2026-07-01T00:00:00.000Z');
  });
});

test('migrating twice is a no-op — the second open must not duplicate or reset rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-recipients-migration-'));
  const file = join(dir, 'fleet.db');
  try {
    const legacy = new Database(file);
    legacy.exec(LEGACY_DDL);
    insertLegacyEvent(legacy, { id: 1, from: 'fleet:skip', to: 'fleet:a', text: 'one', timestamp: '2026-07-01T00:00:00.000Z' });
    insertLegacyUnread(legacy, 1, 'fleet:a', 0);
    legacy.close();

    const first = new FleetStore(file, { taskDoc: false });
    const afterFirst = first.db.prepare('SELECT agent_id, read FROM recipients ORDER BY agent_id').all();
    first.close();

    const second = new FleetStore(file, { taskDoc: false });
    const afterSecond = second.db.prepare('SELECT agent_id, read FROM recipients ORDER BY agent_id').all();
    second.close();

    assert.deepEqual(afterFirst, [{ agent_id: 'fleet:a', read: 0 }]);
    assert.deepEqual(afterSecond, afterFirst, 'reopening must not re-run the backfill over already-migrated rows');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
