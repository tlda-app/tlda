#!/usr/bin/env node
// Run-once history merge, executed at BOOT before the server opens the DB.
// Injects local PRE-cutover history into the live fleet.db with offset ids.
// Exclusive access (server not yet running) => zero loss, no corruption.
// No row text is ever printed; only counts.
//
// argv: [liveDbPath] [localHistoryDbPath]
import Database from 'better-sqlite3';

const LIVE = process.argv[2] || '/root/.config/tlda/fleet.db';
const HIST = process.argv[3] || '/root/.config/tlda/local-history.db';

const BACKUP = LIVE + '.pre-history-merge.bak';

const db = new Database(LIVE);
db.pragma('foreign_keys = OFF');
db.pragma('busy_timeout = 60000');

// Consistent, WAL-safe backup before any mutation (entrypoint restores this on failure).
await db.backup(BACKUP);
console.log(`[merge] backup written: ${BACKUP}`);

const before = db.prepare('SELECT COUNT(*) c, MAX(id) m, MIN(timestamp) t FROM events').get();
const cut = before.t;                 // cutover = earliest live event
const off = before.m || 0;            // offset = current max live id
console.log(`[merge] live before: ${before.c} events, maxId=${off}, cutover=${cut}`);

db.exec(`ATTACH DATABASE '${HIST.replace(/'/g, "''")}' AS loc`);

// Drop FTS triggers during bulk load; rebuild FTS after.
db.exec(`
  DROP TRIGGER IF EXISTS events_ai;
  DROP TRIGGER IF EXISTS events_ad;
  DROP TRIGGER IF EXISTS session_entries_ai;
  DROP TRIGGER IF EXISTS session_entries_ad;
`);

const tx = db.transaction(() => {
  db.prepare(`
    INSERT INTO main.events (id, type, timestamp, from_id, to_id, text, metadata, task_id, agent_id)
    SELECT e.id + ?, e.type, e.timestamp, e.from_id, e.to_id, e.text, e.metadata, e.task_id, e.agent_id
    FROM loc.events e
    WHERE e.timestamp < ?
  `).run(off, cut);

  db.exec(`
    INSERT INTO main.session_entries (id, agent_id, session_id, role, timestamp, text)
    SELECT id, agent_id, session_id, role, timestamp, text FROM loc.session_entries;
    INSERT OR IGNORE INTO main.agents   SELECT * FROM loc.agents;
    INSERT OR IGNORE INTO main.name_history (fleet_id, friendly_name, from_ts, to_ts)
      SELECT fleet_id, friendly_name, from_ts, to_ts FROM loc.name_history;
    INSERT OR IGNORE INTO main.tasks    SELECT * FROM loc.tasks;
    INSERT OR IGNORE INTO main.lineages SELECT * FROM loc.lineages;
  `);
});
tx();

// Rebuild FTS from content tables.
db.exec(`INSERT INTO main.events_fts(events_fts) VALUES('rebuild');`);
db.exec(`INSERT INTO main.session_entries_fts(session_entries_fts) VALUES('rebuild');`);

// Recreate triggers for the live server.
db.exec(`
  CREATE TRIGGER events_ai AFTER INSERT ON events BEGIN
    INSERT INTO events_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER events_ad AFTER DELETE ON events BEGIN
    INSERT INTO events_fts(events_fts, rowid, text) VALUES('delete', old.id, old.text);
  END;
  CREATE TRIGGER session_entries_ai AFTER INSERT ON session_entries BEGIN
    INSERT INTO session_entries_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER session_entries_ad AFTER DELETE ON session_entries BEGIN
    INSERT INTO session_entries_fts(session_entries_fts, rowid, text) VALUES('delete', old.id, old.text);
  END;
`);

// Advance AUTOINCREMENT counters past injected max.
db.exec(`
  UPDATE sqlite_sequence SET seq=(SELECT MAX(id) FROM main.events) WHERE name='events';
  INSERT INTO sqlite_sequence(name,seq)
    SELECT 'events',(SELECT MAX(id) FROM main.events)
    WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='events');
  UPDATE sqlite_sequence SET seq=(SELECT MAX(id) FROM main.session_entries) WHERE name='session_entries';
  INSERT INTO sqlite_sequence(name,seq)
    SELECT 'session_entries',(SELECT MAX(id) FROM main.session_entries)
    WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='session_entries');
`);

db.exec('DETACH DATABASE loc');
const after = db.prepare('SELECT COUNT(*) c FROM events').get();
const se = db.prepare('SELECT COUNT(*) c FROM session_entries').get();
const integ = db.pragma('integrity_check', { simple: true });
console.log(`[merge] live after: ${after.c} events, ${se.c} session_entries, integrity=${integ}`);
db.close();
console.log('[merge] done.');
