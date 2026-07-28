/**
 * FleetStore — SQLite as the single source of truth for fleet events.
 *
 * Every event goes through share() → one row in the `events` table.
 * State.json is a write-through cache, regenerable from SQLite.
 * JSONL is an optional append-only backup.
 *
 * Event types:
 *   - chat: agent-to-agent message
 *   - delegate: task assignment
 *   - task_done: task completion
 *   - task_update: status change (working, idle, blocked, rejected)
 *   - report: self-review submission
 *   - register: agent registration
 *   - lifecycle: name_change, deregister, cleanup, adopt, etc.
 */

import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { createLiveStore } from '../../shared/live-store.ts';
import { PSEUDO_LABELS, parseFilter, evalExpr, evalExprDirectional, astReadsSubscriberLabels, labelsForAgent } from '../../shared/fleet-labels.mjs';
import { anyTermFtsQuery, ftsQueryTerms } from '../../shared/fts-query.mjs';
// isFleetRosterAgent only. fleetRosterCategory went with the count's move:
// the store no longer categorises an agent, it is told which ids are alive and
// joins that against its own roster.
import { isFleetRosterAgent } from '../../shared/fleet-runtime-status.mjs';
import { createTaskDocMaterializer } from './task-doc-materializer.mjs';
import { ServerDaemonOutbox } from './server-daemon-outbox.mjs';
// The one liveness constant this file needs, and only as a threshold: the count
// derives human-vs-human-away from last_seen on every call. Importing the same
// number the projector uses is what stops the two drifting apart.
import { HUMAN_HEARTBEAT_TTL_MS } from './agent-runtime-status.mjs';

// Persistent DB under ~/.config/tlda/ (survives macOS reboots).
// Previously /tmp/fleet.db which got wiped on reboot — lost all agents/state.
// Excluded from Spotlight via a .metadata_never_index file next to the DB.
const DB_PATH = path.join(os.homedir(), '.config', 'tlda', 'fleet.db');
const FLEET_DIR = path.join(os.homedir(), '.fleet');
// Largest result payload transport_operations will store for replay. Above this
// the row is kept and the payload dropped; see recordTransportOperationResult.
// 64 KiB clears every ordinary operation (chat, heartbeat, report-close are all
// well under 1 KB) and excludes the bulk reads that filled the volume.
const TRANSPORT_PAYLOAD_MAX_BYTES = Number(process.env.TLDA_TRANSPORT_PAYLOAD_MAX_BYTES) || 65536;
// Marker key for a row whose payload was dropped. Deliberately unlikely to collide
// with a real result field, since a result that happened to carry it would be
// mistaken for an omitted one and re-executed.
const TRANSPORT_PAYLOAD_OMITTED = '__tlda_payload_omitted';
function envNumber(name, fallback) {
  if (process.env[name] == null || process.env[name] === '') return fallback;
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
const TRANSPORT_OPERATION_RETENTION_HOURS = envNumber('TLDA_TRANSPORT_OPERATION_RETENTION_HOURS', 24);
const TRANSPORT_OPERATION_ACCEPTED_RETENTION_HOURS = envNumber('TLDA_TRANSPORT_OPERATION_ACCEPTED_RETENTION_HOURS', 168);
const TRANSPORT_OPERATION_PRUNE_INTERVAL_MS = envNumber('TLDA_TRANSPORT_OPERATION_PRUNE_INTERVAL_MS', 10 * 60 * 1000);
const TRANSPORT_OPERATION_PRUNE_BATCH_MAX = envNumber('TLDA_TRANSPORT_OPERATION_PRUNE_BATCH_MAX', 500);
// Slow queries are appended here as JSON lines, alongside stdout. Readable after
// the fact the way client.log is, so naming a slow query does not depend on
// someone tailing `fly logs` at the instant it fires.
const SLOWQUERY_LOG_FILE = path.join(os.homedir(), '.config', 'tlda', 'slowquery.log');
const WIRETAP_EVENT_TYPES = new Set(['chat', 'delegate', 'task_done']);

function statementArgs(params) {
  if (params === undefined) return [];
  return Array.isArray(params) ? params : [params];
}

function cwdPathSegments(cwd) {
  const normalized = String(cwd || '').trim().replace(/\/+$/, '');
  if (!normalized) return [];
  return [...new Set(normalized.split('/').filter(Boolean))];
}

// Newest first, bucketed to the MINUTE — Skip's design, from the screen rather
// than from a profile:
//
//   "the sort should be on what the active row actually shows — basically in
//    minute increments... that way if agents are active they're not always
//    jumping around in the list."
//
// The agents panel displays minutes, so ordering on milliseconds sorts on
// precision the user cannot see. Every heartbeat rewrote a timestamp, changed
// the order, and moved rows under him. Bucketing to the displayed granularity
// means a row only moves when what it *shows* has changed.
//
// So this is a CORRECTNESS fix before it is a speed one, in two ways. The old
// comparator also mapped every missing or unparseable timestamp to 0 via
// `new Date(x).getTime() || 0`, so all such rows compared EQUAL and
// `Array.prototype.sort` was free to reorder them between renders — 261 of the
// 6521 live rows have a NULL timestamp, so that was not hypothetical. Minute
// buckets plus the `id` tiebreak below make the order total and deterministic:
// the list stops moving on its own.
//
// That invariant is not new here — the keyset pagination cursor below
// (`agents.last_seen < @lastSeen OR (... AND agents.id < @id)`) already depends
// on it, since SQLite compares those TEXT columns the same way. Verified on the
// live database: 6488 of 6488 non-null `last_seen`/`last_active` values are
// exactly 24 characters in that format, zero exceptions. Writers produce them
// with `toISOString()`. If a writer ever emits another format the cursor breaks
// too, so there is one invariant to hold, not two.
//
// Why it matters: the previous version built two Date objects per comparison.
// This is the comparator for sorted-insert into the in-memory agent index, so it
// runs on EVERY agent update, and a sort of the ~2000-agent roster is ~22000
// comparisons — ~44000 Date allocations and string parses each time. The live
// lag profiler caught it on its first day: 13.2s of a 17s startup stall and
// 401ms of a 890ms steady-state stall, both inside this function. Same defect
// class as the rest of that sweep — cost that scales with agents merely
// existing. Measured at the live roster size: 2.85ms -> 0.21ms per sort, order
// identical.
// Compare two fixed-width ISO timestamps at MINUTE granularity without slicing
// them (a substring per comparison would reallocate ~2.5M short strings per
// liveness batch, which is the allocation pressure this whole change removes).
// 'YYYY-MM-DDTHH:MM' is the first 16 characters.
const ROSTER_MINUTE_CHARS = 16;
function compareIsoMinute(x, y) {
  if (x === y) return 0;
  for (let i = 0; i < ROSTER_MINUTE_CHARS; i += 1) {
    const cx = x.charCodeAt(i), cy = y.charCodeAt(i);
    // NaN from a short/empty string sorts last, matching the old `|| 0` floor.
    if (cx === cy) continue;
    if (Number.isNaN(cx)) return 1;
    if (Number.isNaN(cy)) return -1;
    return cx < cy ? 1 : -1;
  }
  return 0;
}

function compareAgentsForRoster(a, b) {
  const seen = compareIsoMinute(a.last_seen || '', b.last_seen || '');
  if (seen !== 0) return seen;
  const active = compareIsoMinute(a.last_active || '', b.last_active || '');
  if (active !== 0) return active;
  // Deterministic tiebreak so rows inside a minute bucket cannot swap places on
  // a re-render or a re-insert. `id DESC` is the same tiebreak the keyset
  // pagination cursor already uses (_getAliveAgentsPage), so the in-memory order
  // and the SQL order agree instead of diverging on ties.
  const aId = a.id || '', bId = b.id || '';
  if (aId !== bId) return aId < bId ? 1 : -1;
  return 0;
}

function astLiteral(ast) {
  return ast && ast.t === 'lit' ? ast.v : null;
}

function serializePrettyName(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

const PROTECTED_AGENT_UPSERT_FIELDS = [
  'cwd',
];

// Clears the fields that belong to the durable daemon-route projection, not to
// the mutable agents row. The flat seat_* fields are what runtime routing reads.
function withoutProtectedAgentFields(agent) {
  if (!agent) return agent;
  const next = { ...agent };
  for (const field of PROTECTED_AGENT_UPSERT_FIELDS) next[field] = null;
  next.route_present = false;
  next.route_daemon_key = null;
  return next;
}

function parsePrettyName(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed); } catch { return value; }
  }
  return value;
}

function rankUnifiedSearchRows(rows, { terms = [], query = '', explicitActivitySearch = false } = {}) {
  const normalizedQuery = String(query || '').trim().toLowerCase();
  const normalizedTerms = terms.map(t => String(t || '').toLowerCase()).filter(Boolean);
  return rows
    .map((row, index) => {
      const text = `${row.snippet || ''}\n${row.text || ''}`.toLowerCase();
      const rank = Number(row.ftsRank || 0);
      let score = -rank;

      if (row.source === 'fleet') score += 30;
      if (row.source === 'session') score += 10;

      if (row.type === 'chat') score += 90;
      else if (row.type === 'delegate' || row.type === 'report') score += 75;
      else if (row.type === 'task_update' || row.type === 'task_done') score += 55;
      else if (row.type === 'activity') score += explicitActivitySearch ? 15 : -1000;

      if (normalizedQuery && text.includes(normalizedQuery)) score += 300;
      let matchedTerms = 0;
      for (const term of normalizedTerms) {
        if (text.includes(term)) {
          matchedTerms++;
          score += 25;
        }
      }
      if (normalizedTerms.length > 0 && matchedTerms === normalizedTerms.length) score += 150;
      score += matchedTerms * matchedTerms;

      return { row, index, score };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const tc = (b.row.timestamp ?? '').localeCompare(a.row.timestamp ?? '');
      return tc || a.index - b.index;
    })
    .map(x => x.row);
}

// Virtual labels emitted by the DNF chat-routing resolver based on liveness
// state. A friendly_name or label that equals one of these would silently
// shadow the routing category. Single source of truth: shared/fleet-labels.mjs
// (statusLabels), re-exported here for the name-collision checks.
export { PSEUDO_LABELS };

export const CHAT_HISTORY_EVENT_TYPES = Object.freeze([
  'chat',
  'delegate',
  'task_done',
  'terminal_user',
  'terminal_assistant',
  'timer',
  'compacting',
  'activity',
  'terminal_attention',
  'terminal_card',
  'plan_approval',
  'kill-session',
  'interrupt',
]);

export function isChatHistoryEventType(type) {
  return CHAT_HISTORY_EVENT_TYPES.includes(type);
}

// The one place the "what was this agent called at instant ts" rule lives.
// Pure, and resolved against one entry from nameSpansFor(), so naming a page of
// events is in-memory work over data already fetched rather than a query per
// row. `entry.spans` is every name_history row for the agent, oldest first.
//
// The three no-covering-span outcomes are DIFFERENT and must stay that way:
// before all recorded history is the earliest known name, after the last span
// is null (the agent aged out and is genuinely nameless then), and no history
// at all is the current name. Flattening them silently rewrites history in
// every thread view. Comparisons are on the ISO strings, matching the TEXT
// comparison the SQL did.
//
// The ID is always the durable handle — callers pair this name WITH the id.
export function resolveNameAt(entry, ts) {
  if (!entry) return null;
  const spans = entry.spans;
  if (ts && spans.length) {
    // Newest qualifying span wins. Spans arrive oldest-first, so walking back
    // and taking the first match is the one `ORDER BY from_ts DESC LIMIT 1`
    // returned.
    for (let i = spans.length - 1; i >= 0; i -= 1) {
      const span = spans[i];
      if (span.from_ts <= ts && (span.to_ts == null || span.to_ts > ts)) {
        return span.friendly_name; // may be null (nameless span)
      }
    }
    return ts < spans[0].from_ts ? spans[0].friendly_name : null;
  }
  return entry.current ?? null;
}

export class FleetStore {
  constructor(dbPath, options = {}) {
    dbPath = dbPath || DB_PATH;
    // Ensure directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // The file this store actually opened, as a plain property rather than
    // something read back off the connection. Diagnostics compare it against
    // the configured path to catch a store pointed at the wrong database, and
    // the connection is not reachable from the main thread once this store
    // runs on a worker — FleetStoreClient carries the same property.
    this.dbPath = dbPath;
    this.db = new Database(dbPath);
    // Slow-query logger: any .all()/.get() >= TLDA_SLOWQUERY_MS (default 25ms)
    // logs its SQL + duration + rowcount to [slowquery] in server.log. Installed
    // before any statement is prepared so it covers every query. Kept permanently
    // — these logs are how we catch event-loop-blocking scans.
    {
      const SLOW_MS = Number(process.env.TLDA_SLOWQUERY_MS || 25);
      const _origPrepare = this.db.prepare.bind(this.db);
      this.db.prepare = (sql) => {
        const stmt = _origPrepare(sql);
        for (const m of ['all', 'get']) {
          const orig = stmt[m].bind(stmt);
          stmt[m] = (...args) => {
            const t = process.hrtime.bigint();
            const r = orig(...args);
            const ms = Number(process.hrtime.bigint() - t) / 1e6;
            if (ms >= SLOW_MS) {
              const flat = String(sql).replace(/\s+/g, ' ').trim().slice(0, 200);
              const n = Array.isArray(r) ? r.length : (r ? 1 : 0);
              console.warn(`[slowquery] ${ms.toFixed(0)}ms rows=${n} :: ${flat}`);
              // Also append to a file. stdout alone means this is only readable by
              // whoever happens to be tailing `fly logs` at the moment it fires --
              // there is no server.log on the Fly machine, and the log buffer rolls
              // in minutes. Two agents chasing a 1.5s query both lost it to the
              // rolled window on the same night. An instrument that requires a
              // witness is a stakeout, not an instrument.
              fs.appendFile(
                SLOWQUERY_LOG_FILE,
                JSON.stringify({ ts: new Date().toISOString(), ms: Number(ms.toFixed(1)), rows: n, sql: flat }) + '\n',
                err => { if (err) console.warn(`[slowquery] append failed: ${err.message}`); },
              );
            }
            return r;
          };
        }
        return stmt;
      };
    }
    // WAL is a persistent property of the file. The server uses this store
    // through FleetStoreClient, so slow SQLite work stays on the store worker
    // rather than the server event loop. NORMAL is durable across an app crash;
    // only a power loss can lose the last txn, never corrupts.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    // The dominant cost of a read here is I/O, not the query plan: identical
    // SQL returning identical rows has spanned 1,575x (113ms to 178s). Measured
    // on the live file 2026-07-26: a 16MB page cache against a 29.2GB database,
    // mmap off. Both defaults, neither chosen.
    //
    // 256MB of cache on a 4GB machine, and 1GB of mmap so hot pages are read
    // through the page table instead of copied per query. Sized to leave room
    // for the Node heap; raise deliberately with a measurement, not by feel.
    this.db.pragma('cache_size = -262144');
    this.db.pragma('mmap_size = 1073741824');
    // Keep the WAL from growing without bound. Both live WALs reached ~1GB —
    // roughly 250x the checkpoint target — before being truncated by hand.
    this.db.pragma('wal_autocheckpoint = 1000');
    this.db.pragma('journal_size_limit = 67108864');
    this._createTables();
    this._prepareStatements();
    // Two delivery ledgers that are nothing but tables in this database. They
    // were constructed by unified-server from fleetStore.db, which cannot
    // survive the store moving to a worker — and they should not have to,
    // because neither reaches main-thread state. ServerDaemonOutbox in
    // particular wraps its enqueue in a db.transaction(), and a transaction
    // has to run on the thread that owns the connection.
    this._serverDaemonOutbox = new ServerDaemonOutbox(this.db);
    this._closed = false;
    this._cwdSegmentBackfillImmediate = null;
    this._scheduleCwdSegmentBackfill();
    this._initAgentRegistry();
    this._wiretapCache = null;
    this._lastTransportOperationPruneAt = 0;
    this._upgradeLegacyDefaultSubscriptions();
    this._backfillNameHistory();
    this._listeners = []; // SSE broadcast callbacks
    this._taskDocMaterializer = options.taskDoc === true && process.env.TLDA_TASK_DOC_DISABLE !== '1'
      ? createTaskDocMaterializer({ fleetStore: this, ...(options.taskDocOptions || {}) })
      : null;

  }

  // Await a write, resolving to { lastInsertRowid, changes }. Used where the
  // caller needs the row id (share) or the constraint error.
  _wAwait(stmtOrSql, params) {
    const stmt = typeof stmtOrSql === 'string' ? this.db.prepare(stmtOrSql) : stmtOrSql;
    return stmt.run(...statementArgs(params));
  }

  _replaceCwdSegments(source, agentId, cwd) {
    if (!source || !agentId) return;
    const segments = cwdPathSegments(cwd);
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM agent_cwd_segments WHERE source = ? AND agent_id = ?').run(source, agentId);
      const insert = this.db.prepare('INSERT OR IGNORE INTO agent_cwd_segments (source, agent_id, segment) VALUES (?, ?, ?)');
      for (const segment of segments) insert.run(source, agentId, segment);
    });
    tx();
  }

  _scheduleCwdSegmentBackfill() {
    const batchSize = Math.max(1, Number(process.env.TLDA_CWD_SEGMENT_BACKFILL_BATCH || 50) || 50);
    // Advance by cursor, not by "rows that still lack segments". A cwd of "/"
    // normalizes to no segments, so nothing is inserted for it and the
    // NOT EXISTS predicate stays true forever: the batch re-selects the same
    // rows and setImmediate reschedules itself without end. Progress must not
    // depend on the write having had an effect.
    const selectAgents = this.db.prepare(`
      SELECT id AS agent_id, cwd FROM agents
      WHERE cwd IS NOT NULL AND cwd != '' AND id > ?
        AND NOT EXISTS (
          SELECT 1 FROM agent_cwd_segments cs
          WHERE cs.source = 'agent' AND cs.agent_id = agents.id
        )
      ORDER BY id
      LIMIT ?
    `);
    let agentCursor = '';
    const runBatch = () => {
      this._cwdSegmentBackfillImmediate = null;
      if (this._closed || !this.db.open) return;
      let rows = [];
      try {
        const agents = selectAgents.all(agentCursor, batchSize).map(r => ({ ...r, source: 'agent' }));
        if (agents.length) agentCursor = agents[agents.length - 1].agent_id;
        rows = agents;
        for (const row of rows) this._replaceCwdSegments(row.source, row.agent_id, row.cwd);
      } catch (e) {
        if (this._closed || !this.db.open) return;
        console.warn(`[fleet-store] cwd segment backfill failed: ${e.message}`);
        return;
      }
      if (rows.length > 0 && !this._closed) this._cwdSegmentBackfillImmediate = setImmediate(runBatch);
    };
    this._cwdSegmentBackfillImmediate = setImmediate(runBatch);
  }

  _wBatchAwait(ops) {
    const tx = this.db.transaction(() => {
      let result = null;
      for (const op of ops) {
        const stmt = typeof op.stmtOrSql === 'string' ? this.db.prepare(op.stmtOrSql) : op.stmtOrSql;
        result = stmt.run(...statementArgs(op.params));
      }
      return result;
    });
    return tx();
  }

  _createTables() {
    this.db.exec(`
      -- Core event table: every share() writes one row here
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,           -- chat, delegate, task_done, task_update, report, register, lifecycle
        timestamp TEXT NOT NULL,
        from_id TEXT,                 -- sender agent ID
        to_id TEXT,                   -- recipient agent ID
        text TEXT,                    -- message text / description
        metadata TEXT,                -- JSON blob for type-specific data
        task_id TEXT,                 -- associated task ID (for delegate, task_done, task_update, report)
        agent_id TEXT                 -- subject agent (for register, lifecycle)
      );

      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, timestamp DESC);
      -- The polling reads -- WHERE type = ? AND id > ? ORDER BY id ASC LIMIT ?,
      -- in routes/fleet.mjs and the fleet WS events handler -- cannot use the
      -- index above: it is ordered by timestamp, so id can only be filtered
      -- after the fact and the whole type has to be read and re-sorted. Cost
      -- grows with total history. This one answers those queries directly.
      CREATE INDEX IF NOT EXISTS idx_events_type_id ON events(type, id);
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_events_from ON events(from_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_events_to ON events(to_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id);
      CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_events_chat_client_temp_id
        ON events(json_extract(metadata, '$.client_temp_id'), id)
        WHERE type = 'chat';
      CREATE INDEX IF NOT EXISTS idx_events_operation_id
        ON events(json_extract(metadata, '$.client_operation_id'), type, id)
        WHERE type IN ('report', 'chat', 'task_done');
      CREATE INDEX IF NOT EXISTS idx_events_delegate_operation_id
        ON events(json_extract(metadata, '$.client_operation_id'), id)
        WHERE type = 'delegate';
      CREATE TABLE IF NOT EXISTS transport_operations (
        operation_id TEXT PRIMARY KEY,
        operation_type TEXT NOT NULL,
        delivery_class TEXT NOT NULL CHECK (delivery_class IN ('durable', 'ephemeral')),
        sender TEXT,
        destination TEXT,
        parent_operation_id TEXT,
        created_at TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL CHECK (status IN ('accepted', 'completed', 'failed')),
        terminal_kind TEXT CHECK (terminal_kind IN ('result', 'error')),
        terminal_payload TEXT,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_transport_operations_parent
        ON transport_operations(parent_operation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_transport_operations_terminal_retention
        ON transport_operations(status, completed_at);
      CREATE INDEX IF NOT EXISTS idx_transport_operations_accepted_retention
        ON transport_operations(status, created_at);
      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
        text,
        content='events',
        content_rowid='id',
        tokenize='trigram'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS activity_events_fts USING fts5(
        text,
        content='events',
        content_rowid='id',
        tokenize='trigram'
      );
      DROP TRIGGER IF EXISTS events_ai;
      DROP TRIGGER IF EXISTS events_ad;
      DROP TRIGGER IF EXISTS events_au;
      CREATE TRIGGER events_ai AFTER INSERT ON events BEGIN
        INSERT INTO events_fts(rowid, text) VALUES (
          new.id,
          CASE WHEN new.type = 'activity' THEN '' ELSE new.text END
        );
        INSERT INTO activity_events_fts(rowid, text)
        SELECT
          new.id,
          trim(
            coalesce(new.text, '') || ' ' ||
            coalesce(json_extract(new.metadata, '$.tool'), '') || ' ' ||
            coalesce(json_extract(new.metadata, '$.description'), '') || ' ' ||
            coalesce(json_extract(new.metadata, '$.input.description'), '') || ' ' ||
            coalesce(json_extract(new.metadata, '$.arg'), '') || ' ' ||
            coalesce(json_extract(new.metadata, '$.input.command'), '')
          )
        WHERE new.type = 'activity';
      END;
      CREATE TRIGGER events_ad AFTER DELETE ON events BEGIN
        INSERT INTO events_fts(events_fts, rowid, text) VALUES(
          'delete',
          old.id,
          CASE WHEN old.type = 'activity' THEN '' ELSE old.text END
        );
        INSERT INTO activity_events_fts(activity_events_fts, rowid, text)
        SELECT
          'delete',
          old.id,
          trim(
            coalesce(old.text, '') || ' ' ||
            coalesce(json_extract(old.metadata, '$.tool'), '') || ' ' ||
            coalesce(json_extract(old.metadata, '$.description'), '') || ' ' ||
            coalesce(json_extract(old.metadata, '$.input.description'), '') || ' ' ||
            coalesce(json_extract(old.metadata, '$.arg'), '') || ' ' ||
            coalesce(json_extract(old.metadata, '$.input.command'), '')
          )
        WHERE old.type = 'activity';
      END;
      CREATE TRIGGER events_au AFTER UPDATE OF type, text, metadata ON events BEGIN
        INSERT INTO events_fts(events_fts, rowid, text) VALUES(
          'delete',
          old.id,
          CASE WHEN old.type = 'activity' THEN '' ELSE old.text END
        );
        INSERT INTO activity_events_fts(activity_events_fts, rowid, text)
        SELECT
          'delete',
          old.id,
          trim(
            coalesce(old.text, '') || ' ' ||
            coalesce(json_extract(old.metadata, '$.tool'), '') || ' ' ||
            coalesce(json_extract(old.metadata, '$.description'), '') || ' ' ||
            coalesce(json_extract(old.metadata, '$.input.description'), '') || ' ' ||
            coalesce(json_extract(old.metadata, '$.arg'), '') || ' ' ||
            coalesce(json_extract(old.metadata, '$.input.command'), '')
          )
        WHERE old.type = 'activity';
        INSERT INTO events_fts(rowid, text) VALUES (
          new.id,
          CASE WHEN new.type = 'activity' THEN '' ELSE new.text END
        );
        INSERT INTO activity_events_fts(rowid, text)
        SELECT
          new.id,
          trim(
            coalesce(new.text, '') || ' ' ||
            coalesce(json_extract(new.metadata, '$.tool'), '') || ' ' ||
            coalesce(json_extract(new.metadata, '$.description'), '') || ' ' ||
            coalesce(json_extract(new.metadata, '$.input.description'), '') || ' ' ||
            coalesce(json_extract(new.metadata, '$.arg'), '') || ' ' ||
            coalesce(json_extract(new.metadata, '$.input.command'), '')
          )
        WHERE new.type = 'activity';
      END;

      -- Materialized agent state (cache, rebuilt from events)
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        friendly_name TEXT,
        pretty_name TEXT,              -- JSON string/array or plain string, display-only
        cwd TEXT,
        labels TEXT,                  -- JSON array
        registered_at TEXT,
        last_seen TEXT,
        dead INTEGER DEFAULT 0,
        human INTEGER DEFAULT 0,
        is_manager INTEGER DEFAULT 0,
        metadata TEXT                 -- JSON blob for extra fields
      );

      CREATE TABLE IF NOT EXISTS agent_daemon_routes (
        agent_id TEXT PRIMARY KEY,
        daemon_key TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS daemon_agent_bindings (
        daemon_key TEXT NOT NULL,
        local_agent_id TEXT NOT NULL,
        agent_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (daemon_key, local_agent_id)
      );

      -- Daemon registry: durable record of scoped daemon identities. This is
      -- the authority for "which daemon is allowed to do which job"; websocket
      -- connections are just the current live transport for a registry row.
      CREATE TABLE IF NOT EXISTS daemon_registry (
        daemon_key TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL,
        env_name TEXT NOT NULL,
        install_path TEXT,
        user TEXT,
        hostname TEXT,
        version TEXT,
        boot_id INTEGER,
        status TEXT NOT NULL DEFAULT 'disconnected',
        connected_at TEXT,
        disconnected_at TEXT,
        last_seen TEXT,
        metadata TEXT
      );

      -- Materialized task state (cache, rebuilt from events)
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        description TEXT,
        message TEXT,
        delegated_by TEXT,
        delegated_at TEXT,
        status TEXT DEFAULT 'pending', -- pending, blocked, working, idle, done
        acknowledged INTEGER DEFAULT 0,
        completed_at TEXT,
        last_checked TEXT,
        updated_at TEXT,
        blocked_by TEXT,              -- JSON array of task IDs
        success_criteria TEXT,        -- JSON array
        reported INTEGER DEFAULT 0,
        synthetic INTEGER DEFAULT 0,
        metadata TEXT                 -- JSON blob for extra fields
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent, status);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      -- Partial index for the frequent active-tasks list (status != 'done' can't
      -- use idx_tasks_status; this serves the scan + ORDER BY index-only).
      CREATE INDEX IF NOT EXISTS idx_tasks_active ON tasks(delegated_at DESC) WHERE status != 'done';
      CREATE INDEX IF NOT EXISTS idx_tasks_active_live ON tasks(delegated_at DESC, id DESC) WHERE status NOT IN ('done', 'retracted');
      CREATE INDEX IF NOT EXISTS idx_tasks_agent_active_live ON tasks(agent, delegated_at DESC) WHERE status NOT IN ('done', 'retracted');

      -- Unread message tracking (multiple entries per event for CC)
      CREATE TABLE IF NOT EXISTS unread (
        event_id INTEGER REFERENCES events(id),
        to_id TEXT NOT NULL,
        read INTEGER DEFAULT 0,
        PRIMARY KEY (event_id, to_id)
      );

      CREATE INDEX IF NOT EXISTS idx_unread_to ON unread(to_id, read);

      -- Wiretaps: persistent message subscriptions
      CREATE TABLE IF NOT EXISTS wiretaps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,          -- who is listening
        filter TEXT NOT NULL,            -- JSON object: { from?: string[][], to?: string[][] }
        types TEXT,                      -- JSON array of event types to filter (null = all)
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_wiretaps_agent ON wiretaps(agent_id);

      CREATE TABLE IF NOT EXISTS subscriptions (
        subscription_id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner TEXT NOT NULL,
        query TEXT NOT NULL,
        notification_policy TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        adapter TEXT NOT NULL,
        adapter_id INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_subscriptions_owner ON subscriptions(owner);

      -- Daemon outbox at-most-once ledger. A daemon redelivers an envelope it
      -- did not see acked, so the server has to recognise one it already
      -- handled. Owned here rather than created by unified-server at import,
      -- which is where it lived until the store moved off the main thread and
      -- the server stopped holding a database handle to create it with.
      CREATE TABLE IF NOT EXISTS daemon_outbox_processed (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        processed_at TEXT NOT NULL
      );

      -- Shared document metadata
      CREATE TABLE IF NOT EXISTS shared_docs (
        doc TEXT PRIMARY KEY,            -- document name (e.g. "fleet-data-design")
        path TEXT,                       -- source file path
        title TEXT,
        agent TEXT,                      -- who shared it
        ephemeral INTEGER DEFAULT 0,     -- 0/1
        shared_at TEXT,                  -- ISO timestamp
        updated_at TEXT                  -- ISO timestamp
      );

      -- QA system: config for QA agent fleet IDs
      CREATE TABLE IF NOT EXISTS qa_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- QA system: reports submitted by implementers
      CREATE TABLE IF NOT EXISTS qa_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,          -- who submitted
        task_type TEXT NOT NULL,         -- 'app' or 'math'
        fields TEXT NOT NULL,            -- JSON blob of report fields
        submitted_at TEXT NOT NULL,
        superseded INTEGER DEFAULT 0    -- 1 if replaced by a newer report
      );

      CREATE INDEX IF NOT EXISTS idx_qa_reports_task ON qa_reports(task_id, superseded);

      -- QA system: signatures from QA agents
      CREATE TABLE IF NOT EXISTS qa_signatures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        report_id INTEGER NOT NULL REFERENCES qa_reports(id),
        agent_id TEXT NOT NULL,          -- qa-haiku or qa-opus fleet ID
        verdict TEXT NOT NULL,           -- 'approved' or 'rejected'
        notes TEXT,
        signed_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_qa_signatures_task ON qa_signatures(task_id);
      CREATE INDEX IF NOT EXISTS idx_qa_signatures_report ON qa_signatures(report_id);
    `);

    // ---- User preferences (per fleet ID) ----
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fleet_prefs (
        user_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (user_id, key)
      );
      CREATE TABLE IF NOT EXISTS search_index_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // ---- Session JSONL text entries (for unified search) ----
    // Populated by the fleet-daemon as it watches active session JSONLs.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        text TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_session_entries_unique ON session_entries(session_id, timestamp, role);
      CREATE INDEX IF NOT EXISTS idx_session_entries_session ON session_entries(session_id);
      CREATE INDEX IF NOT EXISTS idx_session_entries_agent ON session_entries(agent_id, timestamp DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS session_entries_fts USING fts5(
        text,
        content='session_entries',
        content_rowid='id',
        tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS session_entries_ai AFTER INSERT ON session_entries BEGIN
        INSERT INTO session_entries_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS session_entries_ad AFTER DELETE ON session_entries BEGIN
        INSERT INTO session_entries_fts(session_entries_fts, rowid, text) VALUES('delete', old.id, old.text);
      END;
    `);

    // ---- Migrations (idempotent) ----
    const agentCols = this.db.prepare("PRAGMA table_info(agents)").all();
    if (agentCols.some(c => c.name === 'tmux_session')) {
      this.db.exec("ALTER TABLE agents DROP COLUMN tmux_session");
    }
    if (!agentCols.some(c => c.name === 'pretty_name')) this.db.exec("ALTER TABLE agents ADD COLUMN pretty_name TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_daemon_registry_status ON daemon_registry(status, machine_id, env_name)");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_cwd_segments (
        source TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        segment TEXT NOT NULL,
        PRIMARY KEY (source, agent_id, segment)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_cwd_segments_segment
        ON agent_cwd_segments(segment, source, agent_id);
    `);
    const hasCurrentSeats = this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_current_seats'"
    ).get();
    if (hasCurrentSeats) {
      this.db.exec(`
        INSERT OR REPLACE INTO agent_daemon_routes (agent_id, daemon_key)
        SELECT agent_id, daemon_key FROM agent_current_seats
        WHERE daemon_key IS NOT NULL AND daemon_key != '';
      `);
    }
    const routeMigrationAgentCols = this.db.prepare('PRAGMA table_info(agents)').all();
    if (routeMigrationAgentCols.some(c => c.name === 'daemon_key')) {
      this.db.exec(`
        INSERT OR IGNORE INTO agent_daemon_routes (agent_id, daemon_key)
        SELECT id, daemon_key FROM agents
        WHERE daemon_key IS NOT NULL AND daemon_key != '';
      `);
    }
    this.db.exec(`
      DROP TABLE IF EXISTS agent_seat_binding_obligations;
      DROP TABLE IF EXISTS agent_current_seats;
      DROP TABLE IF EXISTS agent_seats;
    `);
    this.db.exec('DROP INDEX IF EXISTS idx_agents_machine_env; DROP INDEX IF EXISTS idx_agents_daemon_key; DROP INDEX IF EXISTS idx_agents_machine_env_alive;');
    for (const column of ['session_id', 'session_ids', 'resume_id', 'machine_id', 'env_name', 'daemon_key']) {
      if (this.db.prepare('PRAGMA table_info(agents)').all().some(c => c.name === column)) {
        this.db.exec(`ALTER TABLE agents DROP COLUMN ${column}`);
      }
    }
    const taskCols = this.db.prepare("PRAGMA table_info(tasks)").all();
    if (!taskCols.some(c => c.name === 'updated_at')) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN updated_at TEXT");
      this.db.exec("UPDATE tasks SET updated_at = COALESCE(completed_at, last_checked, delegated_at) WHERE updated_at IS NULL");
    }

    // Add lineage columns to agents if missing
    if (!agentCols.some(c => c.name === 'lineage_id')) {
      this.db.exec("ALTER TABLE agents ADD COLUMN lineage_id TEXT");
    }

    // last_active = most recent event timestamp where the agent is sender or
    // recipient. Maintained incrementally on every event insert (see share())
    // so the agents-list query is a plain indexed read and NEVER scans the
    // ~400k-row events table — the correlated/grouped scan it replaced pinned
    // the event loop for tens of seconds under load.
    if (!agentCols.some(c => c.name === 'last_active')) {
      this.db.exec("ALTER TABLE agents ADD COLUMN last_active TEXT");
      // One-time backfill from existing events (single indexed pass).
      this.db.exec(`
        UPDATE agents SET last_active = la.la FROM (
          SELECT id, MAX(ts) AS la FROM (
            SELECT from_id AS id, MAX(timestamp) AS ts FROM events WHERE from_id IS NOT NULL GROUP BY from_id
            UNION ALL
            SELECT to_id AS id, MAX(timestamp) AS ts FROM events WHERE to_id IS NOT NULL GROUP BY to_id
          ) GROUP BY id
        ) AS la WHERE agents.id = la.id
      `);
    }

    // Lineage tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS lineages (
        id TEXT PRIMARY KEY,
        friendly_name TEXT UNIQUE,
        labels TEXT,
        created_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_agents_lineage ON agents(lineage_id);

      -- Stack model (source of truth for lineage membership). A lineage is an
      -- explicit stack of agents; stack_index 0 = current/top holder. Phase is
      -- NOT stored — position is. Todd owns the position→name pretty-printing and
      -- applies exact names via renameAgentFriendlyName(). The server stores
      -- opaque positions and never interprets a name. Full history is retained
      -- (active=0 rows) so search can answer "every id ever on this stack",
      -- including swapped-out occupants.
      CREATE TABLE IF NOT EXISTS lineage_stack_entries (
        lineage_id TEXT NOT NULL,
        fleet_id TEXT NOT NULL,
        stack_index INTEGER NOT NULL,      -- 0 = top/current holder
        active INTEGER NOT NULL DEFAULT 1, -- 1 = live stack member, 0 = historical
        entered_at INTEGER NOT NULL,
        exited_at INTEGER,
        entry_reason TEXT,                 -- push-new, push-existing, pop, adopt, swap, migration
        replaced_by TEXT,
        metadata TEXT,
        PRIMARY KEY (lineage_id, fleet_id, entered_at)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_lineage_stack_active_pos
        ON lineage_stack_entries(lineage_id, stack_index) WHERE active = 1;
      CREATE INDEX IF NOT EXISTS idx_lineage_stack_fleet
        ON lineage_stack_entries(fleet_id, active, stack_index);
      CREATE INDEX IF NOT EXISTS idx_lineage_stack_lineage_active
        ON lineage_stack_entries(lineage_id, active, stack_index);
    `);

    // One-way cutover from the retired phase tables. This runs only when an
    // older database still has them, copies their history into the stack, then
    // deletes the old schema. Runtime lineage behavior never reads phase data.
    const hasPhaseLog = this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='lineage_phase_log'"
    ).get();
    if (hasPhaseLog) {
      const position = new Map([['dawn', 0], ['day', 1], ['dusk', 2], ['night', 3]]);
      const rows = this.db.prepare(
        'SELECT lineage_id, fleet_id, phase, entered_at, exited_at FROM lineage_phase_log ORDER BY entered_at'
      ).all();
      const insertHistory = this.db.prepare(`
        INSERT OR IGNORE INTO lineage_stack_entries
          (lineage_id, fleet_id, stack_index, active, entered_at, exited_at, entry_reason)
        VALUES (?, ?, ?, 0, ?, ?, 'phase-cutover')
      `);
      const latestActive = new Map();
      this.db.transaction(() => {
        for (const row of rows) {
          const stackIndex = position.get(row.phase);
          if (stackIndex == null) continue;
          insertHistory.run(row.lineage_id, row.fleet_id, stackIndex, row.entered_at, row.exited_at);
          if (row.exited_at == null) latestActive.set(`${row.lineage_id}:${stackIndex}`, row);
        }
        const insertActive = this.db.prepare(`
          INSERT OR IGNORE INTO lineage_stack_entries
            (lineage_id, fleet_id, stack_index, active, entered_at, entry_reason)
          VALUES (?, ?, ?, 1, ?, 'phase-cutover')
        `);
        for (const row of latestActive.values()) {
          insertActive.run(row.lineage_id, row.fleet_id, position.get(row.phase), Date.now());
        }
      })();
      this.db.exec('DROP TABLE lineage_phase_log');
    }
    const currentAgentCols = this.db.prepare("PRAGMA table_info(agents)").all();
    if (currentAgentCols.some(c => c.name === 'phase')) this.db.exec('ALTER TABLE agents DROP COLUMN phase');

    // Dedupe + enforce unique friendly_name among live agents.
    // Step 1: resolve existing duplicates — keep the most-recently-seen, mark the rest dead.
    const dupes = this.db.prepare(`
      SELECT friendly_name, COUNT(*) AS cnt FROM agents
      WHERE dead = 0 AND friendly_name IS NOT NULL
      GROUP BY friendly_name HAVING cnt > 1
    `).all();
    if (dupes.length > 0) {
      // A name collision RENAMES the loser. It does not kill it.
      //
      // Skip: "Nothing should kill an agent, ever, other than a manual
      // operation" and "the name rotation doesn't kill an agent — it wipes
      // their name, but it doesn't kill them."
      //
      // This used to mark every duplicate `dead = 1`, ordered by `last_seen`,
      // so the quieter of two live agents was killed at startup for the crime
      // of sharing a name — the duplicate-chief failure. Death was being used
      // as the mechanism for freeing a name, because the live-name unique index
      // only covers `dead = 0`. Rotating the name frees it just as well and
      // costs nobody their session.
      const renamed = [];
      this.db.transaction(() => {
        for (const { friendly_name } of dupes) {
          const rows = this.db.prepare(
            'SELECT id, last_seen FROM agents WHERE friendly_name = ? AND dead = 0 ORDER BY last_seen DESC'
          ).all(friendly_name);
          // The most-recently-seen keeps the name; everyone else rotates.
          for (let i = 1; i < rows.length; i++) {
            // If a name can't be rotated (reserved label, alphabet exhausted),
            // wipe it rather than kill the agent — the unique index is partial
            // on `friendly_name IS NOT NULL`, so a nameless agent satisfies it
            // and stays alive to be renamed later. This runs during schema init,
            // so it must not be able to throw: a rename failure here would take
            // the whole server down at startup.
            let next = null;
            try {
              next = this.allocateFreshFriendlyName(friendly_name, { excludeId: rows[i].id });
            } catch { next = null; }
            this.db.prepare('UPDATE agents SET friendly_name = ? WHERE id = ?').run(next, rows[i].id);
            renamed.push(`${friendly_name}→${next || '(name cleared)'}`);
          }
        }
      })();
      console.log(`[fleet-store] rotated colliding friendly_names: ${renamed.join(', ')}`);
    }
    // Step 2: create partial unique index (idempotent)
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_live_name
      ON agents(friendly_name) WHERE dead = 0 AND friendly_name IS NOT NULL
    `);

    // ---- FTS tokenizer migration: unicode61 → trigram ----
    // unicode61 treats dashes and colons as token separators, so searching for
    // "chief:day" or "balancing-act" breaks into separate words. trigram preserves
    // them as part of 3-char windows, making dash-named things actually searchable.
    const ftsSchema = this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='events_fts'"
    ).get();
    if (ftsSchema && ftsSchema.sql.includes('unicode61')) {
      this.db.exec(`
        DROP TRIGGER IF EXISTS events_ai;
        DROP TRIGGER IF EXISTS events_ad;
        DROP TRIGGER IF EXISTS events_au;
        DROP TABLE IF EXISTS events_fts;
        CREATE VIRTUAL TABLE events_fts USING fts5(
          text,
          content='events',
          content_rowid='id',
          tokenize='trigram'
        );
        CREATE TRIGGER events_ai AFTER INSERT ON events BEGIN
          INSERT INTO events_fts(rowid, text) VALUES (
            new.id,
            CASE
              WHEN new.type = 'activity' THEN trim(
                coalesce(new.text, '') || ' ' ||
                coalesce(json_extract(new.metadata, '$.tool'), '') || ' ' ||
                coalesce(json_extract(new.metadata, '$.description'), '') || ' ' ||
                coalesce(json_extract(new.metadata, '$.input.description'), '') || ' ' ||
                coalesce(json_extract(new.metadata, '$.arg'), '') || ' ' ||
                coalesce(json_extract(new.metadata, '$.input.command'), '')
              )
              ELSE new.text
            END
          );
        END;
        CREATE TRIGGER events_ad AFTER DELETE ON events BEGIN
          INSERT INTO events_fts(events_fts, rowid, text) VALUES(
            'delete',
            old.id,
            CASE
              WHEN old.type = 'activity' THEN trim(
                coalesce(old.text, '') || ' ' ||
                coalesce(json_extract(old.metadata, '$.tool'), '') || ' ' ||
                coalesce(json_extract(old.metadata, '$.description'), '') || ' ' ||
                coalesce(json_extract(old.metadata, '$.input.description'), '') || ' ' ||
                coalesce(json_extract(old.metadata, '$.arg'), '') || ' ' ||
                coalesce(json_extract(old.metadata, '$.input.command'), '')
              )
              ELSE old.text
            END
          );
        END;
        CREATE TRIGGER events_au AFTER UPDATE ON events BEGIN
          INSERT INTO events_fts(events_fts, rowid, text) VALUES(
            'delete',
            old.id,
            CASE
              WHEN old.type = 'activity' THEN trim(
                coalesce(old.text, '') || ' ' ||
                coalesce(json_extract(old.metadata, '$.tool'), '') || ' ' ||
                coalesce(json_extract(old.metadata, '$.description'), '') || ' ' ||
                coalesce(json_extract(old.metadata, '$.input.description'), '') || ' ' ||
                coalesce(json_extract(old.metadata, '$.arg'), '') || ' ' ||
                coalesce(json_extract(old.metadata, '$.input.command'), '')
              )
              ELSE old.text
            END
          );
          INSERT INTO events_fts(rowid, text) VALUES (
            new.id,
            CASE
              WHEN new.type = 'activity' THEN trim(
                coalesce(new.text, '') || ' ' ||
                coalesce(json_extract(new.metadata, '$.tool'), '') || ' ' ||
                coalesce(json_extract(new.metadata, '$.description'), '') || ' ' ||
                coalesce(json_extract(new.metadata, '$.input.description'), '') || ' ' ||
                coalesce(json_extract(new.metadata, '$.arg'), '') || ' ' ||
                coalesce(json_extract(new.metadata, '$.input.command'), '')
              )
              ELSE new.text
            END
          );
        END;
      `);
      this.db.exec("INSERT INTO events_fts(events_fts) VALUES ('rebuild')");
      console.log('[fleet-store] migrated events_fts tokenizer: unicode61 → trigram');
    }

    const sessFtsSchema = this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='session_entries_fts'"
    ).get();
    if (sessFtsSchema && sessFtsSchema.sql.includes('unicode61')) {
      this.db.exec(`
        DROP TRIGGER IF EXISTS session_entries_ai;
        DROP TRIGGER IF EXISTS session_entries_ad;
        DROP TABLE IF EXISTS session_entries_fts;
        CREATE VIRTUAL TABLE session_entries_fts USING fts5(
          text,
          content='session_entries',
          content_rowid='id',
          tokenize='trigram'
        );
        CREATE TRIGGER session_entries_ai AFTER INSERT ON session_entries BEGIN
          INSERT INTO session_entries_fts(rowid, text) VALUES (new.id, new.text);
        END;
        CREATE TRIGGER session_entries_ad AFTER DELETE ON session_entries BEGIN
          INSERT INTO session_entries_fts(session_entries_fts, rowid, text) VALUES('delete', old.id, old.text);
        END;
      `);
      this.db.exec("INSERT INTO session_entries_fts(session_entries_fts) VALUES ('rebuild')");
      console.log('[fleet-store] migrated session_entries_fts tokenizer: unicode61 → trigram');
    }

    this.db.exec(`
      DROP TRIGGER IF EXISTS events_ai;
      DROP TRIGGER IF EXISTS events_ad;
      DROP TRIGGER IF EXISTS events_au;
      CREATE TRIGGER events_ai AFTER INSERT ON events BEGIN
        INSERT INTO events_fts(rowid, text) VALUES (
          new.id,
          CASE WHEN new.type = 'activity' THEN '' ELSE new.text END
        );
        INSERT INTO activity_events_fts(rowid, text)
        SELECT
          new.id,
          trim(
            coalesce(new.text, '') || ' ' ||
            coalesce(json_extract(new.metadata, '$.tool'), '') || ' ' ||
            coalesce(json_extract(new.metadata, '$.description'), '') || ' ' ||
            coalesce(json_extract(new.metadata, '$.input.description'), '') || ' ' ||
            coalesce(json_extract(new.metadata, '$.arg'), '') || ' ' ||
            coalesce(json_extract(new.metadata, '$.input.command'), '')
          )
        WHERE new.type = 'activity';
      END;
      CREATE TRIGGER events_ad AFTER DELETE ON events BEGIN
        INSERT INTO events_fts(events_fts, rowid, text) VALUES(
          'delete',
          old.id,
          CASE WHEN old.type = 'activity' THEN '' ELSE old.text END
        );
        INSERT INTO activity_events_fts(activity_events_fts, rowid, text)
        SELECT
          'delete',
          old.id,
          trim(
            coalesce(old.text, '') || ' ' ||
            coalesce(json_extract(old.metadata, '$.tool'), '') || ' ' ||
            coalesce(json_extract(old.metadata, '$.description'), '') || ' ' ||
            coalesce(json_extract(old.metadata, '$.input.description'), '') || ' ' ||
            coalesce(json_extract(old.metadata, '$.arg'), '') || ' ' ||
            coalesce(json_extract(old.metadata, '$.input.command'), '')
          )
        WHERE old.type = 'activity';
      END;
      CREATE TRIGGER events_au AFTER UPDATE OF type, text, metadata ON events BEGIN
        INSERT INTO events_fts(events_fts, rowid, text) VALUES(
          'delete',
          old.id,
          CASE WHEN old.type = 'activity' THEN '' ELSE old.text END
        );
        INSERT INTO activity_events_fts(activity_events_fts, rowid, text)
        SELECT
          'delete',
          old.id,
          trim(
            coalesce(old.text, '') || ' ' ||
            coalesce(json_extract(old.metadata, '$.tool'), '') || ' ' ||
            coalesce(json_extract(old.metadata, '$.description'), '') || ' ' ||
            coalesce(json_extract(old.metadata, '$.input.description'), '') || ' ' ||
            coalesce(json_extract(old.metadata, '$.arg'), '') || ' ' ||
            coalesce(json_extract(old.metadata, '$.input.command'), '')
          )
        WHERE old.type = 'activity';
        INSERT INTO events_fts(rowid, text) VALUES (
          new.id,
          CASE WHEN new.type = 'activity' THEN '' ELSE new.text END
        );
        INSERT INTO activity_events_fts(rowid, text)
        SELECT
          new.id,
          trim(
            coalesce(new.text, '') || ' ' ||
            coalesce(json_extract(new.metadata, '$.tool'), '') || ' ' ||
            coalesce(json_extract(new.metadata, '$.description'), '') || ' ' ||
            coalesce(json_extract(new.metadata, '$.input.description'), '') || ' ' ||
            coalesce(json_extract(new.metadata, '$.arg'), '') || ' ' ||
            coalesce(json_extract(new.metadata, '$.input.command'), '')
          )
        WHERE new.type = 'activity';
      END;
    `);

    // Backfill/migrate split event FTS indexes for existing events. The primary
    // table indexes conversation/task rows; the activity table indexes compact
    // diagnostics, not prettyResult copies of whole tool outputs.
    // Cheap existence check, NOT COUNT(*): FTS5 has no maintained row count, so
    // COUNT(*) scans the whole index — O(events), ~seconds on a large DB, every
    // startup. We only need to know whether the index is EMPTY (one-time backfill).
    const ftsHasRows = this.db.prepare("SELECT 1 FROM events_fts LIMIT 1").get();
    const eventFtsVersion = this.db.prepare("SELECT value FROM search_index_meta WHERE key = 'events_fts_content_version'").get()?.value;
    if (!ftsHasRows || eventFtsVersion !== 'primary-events-plus-activity-diagnostics-v2') {
      this.db.exec(`
        INSERT INTO events_fts(events_fts) VALUES ('delete-all');
        INSERT INTO events_fts(rowid, text)
        SELECT id,
          CASE WHEN type = 'activity' THEN '' ELSE text END
        FROM events;
        INSERT INTO activity_events_fts(activity_events_fts) VALUES ('delete-all');
        INSERT INTO activity_events_fts(rowid, text)
        SELECT id,
          trim(
            coalesce(text, '') || ' ' ||
            coalesce(json_extract(metadata, '$.tool'), '') || ' ' ||
            coalesce(json_extract(metadata, '$.description'), '') || ' ' ||
            coalesce(json_extract(metadata, '$.input.description'), '') || ' ' ||
            coalesce(json_extract(metadata, '$.arg'), '') || ' ' ||
            coalesce(json_extract(metadata, '$.input.command'), '')
          )
        FROM events
        WHERE type = 'activity';
        INSERT OR REPLACE INTO search_index_meta(key, value)
        VALUES ('events_fts_content_version', 'primary-events-plus-activity-diagnostics-v2');
      `);
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skill_reads (
        agent_id TEXT NOT NULL,
        skill_key TEXT NOT NULL,
        read_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (agent_id, skill_key)
      );
    `);

    // Drill report cards — the graded result of a drill, the "how they performed"
    // half of the education record (skill_reads is the "what they know" half).
    // One row per (agent, drill); a re-run replaces the prior card.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS drill_cards (
        agent_id TEXT NOT NULL,
        drill_id TEXT NOT NULL,
        gradient TEXT,
        pass INTEGER,
        card_json TEXT NOT NULL,
        graded_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (agent_id, drill_id)
      );
    `);

    // ---- Boot-path index migration ----
    // These cover the queries that show up as full SCANs in slowquery logs:
    //   SELECT * FROM agents ORDER BY last_seen DESC          → idx_agents_last_seen
    //   SELECT * FROM agents WHERE dead=0 AND id!=?           → idx_agents_alive
    //   SELECT * FROM agents WHERE friendly_name=?            → (already covered by idx_agents_live_name for dead=0)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agents_last_seen ON agents(last_seen DESC);
      CREATE INDEX IF NOT EXISTS idx_agents_alive ON agents(dead, last_seen DESC);
      CREATE INDEX IF NOT EXISTS idx_agents_friendly_name ON agents(friendly_name);
      CREATE INDEX IF NOT EXISTS idx_agents_cwd ON agents(cwd, id);
      CREATE INDEX IF NOT EXISTS idx_agents_cwd_trimmed ON agents(rtrim(cwd, '/'), id);
      CREATE INDEX IF NOT EXISTS idx_unread_unread ON unread(event_id) WHERE read = 0;
    `);

    // ---- Name provenance (name-at-time) ----
    // friendly_name rotates (lineage phases, renames, aging out). To render any
    // PAST event with the name the agent ACTUALLY held then, we keep a span log:
    // one row per (agent, name) interval [from_ts, to_ts). to_ts NULL = current;
    // friendly_name NULL = a nameless span (aged-out, reachable only by id).
    // Timestamps are ISO-8601 TEXT — directly comparable to events.timestamp.
    //
    // The two triggers below are the ENFORCEMENT: every friendly_name write —
    // from the rename route, lineage rotation, the worker, or an external sweep
    // script — passes through agents, so no rename can ever skip the history.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS name_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fleet_id TEXT NOT NULL,
        friendly_name TEXT,           -- NULL = nameless span
        from_ts TEXT NOT NULL,        -- ISO-8601, inclusive
        to_ts TEXT                    -- ISO-8601, exclusive; NULL = still current
      );
      CREATE INDEX IF NOT EXISTS idx_name_history_fleet ON name_history(fleet_id, from_ts);
      CREATE INDEX IF NOT EXISTS idx_name_history_open ON name_history(fleet_id) WHERE to_ts IS NULL;

      -- New agent that registers with a name → open its first span.
      CREATE TRIGGER IF NOT EXISTS name_history_ai AFTER INSERT ON agents
      WHEN NEW.friendly_name IS NOT NULL BEGIN
        INSERT INTO name_history (fleet_id, friendly_name, from_ts, to_ts)
        VALUES (NEW.id, NEW.friendly_name,
                COALESCE(NEW.registered_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')), NULL);
      END;

      -- friendly_name changed (incl. →NULL when aging out, or NULL→ on reanimate):
      -- close the open span, then open a new one iff the new name is non-NULL.
      CREATE TRIGGER IF NOT EXISTS name_history_au AFTER UPDATE OF friendly_name ON agents
      WHEN NEW.friendly_name IS NOT OLD.friendly_name BEGIN
        UPDATE name_history SET to_ts = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE fleet_id = NEW.id AND to_ts IS NULL;
        INSERT INTO name_history (fleet_id, friendly_name, from_ts, to_ts)
          SELECT NEW.id, NEW.friendly_name, strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL
          WHERE NEW.friendly_name IS NOT NULL;
      END;
    `);
  }

  // Standard SELECT for events — aliases from_id/to_id so consumers always see `from`/`to`
  // Use _EVT for standalone queries, _EVTE for queries that join (prefixes with e.)
  get _EVT() { return 'id, type, timestamp, from_id as "from", to_id as "to", text, metadata, task_id, agent_id' }
  get _EVTE() { return 'e.id, e.type, e.timestamp, e.from_id as "from", e.to_id as "to", e.text, e.metadata, e.task_id, e.agent_id' }

  _prepareStatements() {
    this._insertEvent = this.db.prepare(`
      INSERT INTO events (type, timestamp, from_id, to_id, text, metadata, task_id, agent_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this._insertUnread = this.db.prepare(`
      INSERT OR IGNORE INTO unread (event_id, to_id, read) VALUES (?, ?, 0)
    `);

    // Incrementally bump last_active for the event's sender + recipient. Both
    // params are the event timestamp; MAX keeps the newest if events arrive out
    // of order. id IN (?, ?) is an O(1) PK lookup; null from/to simply matches
    // nothing. The server runs this store on the store worker, off the main loop.
    this._updateAgentLastActive = this.db.prepare(`
      UPDATE agents SET last_active = MAX(COALESCE(last_active, ?), ?) WHERE id IN (?, ?)
    `);

    this._markRead = this.db.prepare(`
      UPDATE unread SET read = 1 WHERE to_id = ? AND read = 0
    `);

    this._markEventRead = this.db.prepare(`
      UPDATE unread SET read = 1 WHERE event_id = ? AND to_id = ?
    `);

    this._updateEventMetadata = this.db.prepare(`
      UPDATE events SET metadata = json_patch(COALESCE(metadata, '{}'), ?) WHERE id = ?
    `);

    // Distinct from _updateEventMetadata above, which MERGES via json_patch.
    // This one REPLACES. Callers that derive a complete metadata object and
    // want a removed key to stay removed need replacement — json_patch would
    // keep the old key, and additionally reads a null value as "delete this
    // key", so the two are not interchangeable in either direction.
    this._replaceEventMetadata = this.db.prepare(`
      UPDATE events SET metadata = ? WHERE id = ?
    `);

    this._replaceEventTextAndMetadata = this.db.prepare(`
      UPDATE events SET text = ?, metadata = ? WHERE id = ?
    `);

    this._unreadPendingRow = this.db.prepare(`
      SELECT read FROM unread WHERE event_id = ? AND to_id = ?
    `);

    // Claude Code can write the same user message to its JSONL more than once
    // (compaction, in particular), and several daemons compound that. The
    // daemon dedups within its own offset; this is the authoritative check.
    this._terminalChatDuplicate = this.db.prepare(`
      SELECT 1 FROM events
      WHERE timestamp = ? AND from_id = ? AND to_id = ? AND substr(text, 1, 500) = ? AND type = 'chat'
      LIMIT 1
    `);

    this._daemonOutboxProcessedGet = this.db.prepare(`
      SELECT 1 FROM daemon_outbox_processed WHERE id = ? LIMIT 1
    `);

    this._daemonOutboxProcessedInsert = this.db.prepare(`
      INSERT OR IGNORE INTO daemon_outbox_processed (id, type, processed_at) VALUES (?, ?, ?)
    `);

    // No unbounded variant of this query exists on purpose. Fetching an agent's
    // entire unread backlog to slice it in JS grows all day and blocks the event
    // loop synchronously; the caller that did that is gone. Use the limited form.
    this._getUnreadLimited = this.db.prepare(`
      SELECT ${this._EVTE} FROM events e
      JOIN unread u ON u.event_id = e.id
      WHERE u.to_id = ? AND u.read = 0
      ORDER BY e.timestamp ASC
      LIMIT ?
    `);

    this._getUnreadCount = this.db.prepare(`
      SELECT COUNT(*) as c FROM unread WHERE to_id = ? AND read = 0
    `);

    // Recent messages TO an agent (regardless of read status — for hook display)
    this._getRecentMessagesTo = this.db.prepare(`
      SELECT ${this._EVTE} FROM events e
      WHERE e.to_id = ? AND e.type = 'chat'
      ORDER BY e.timestamp DESC LIMIT ?
    `);

    // Agent queries
    this._upsertAgent = this.db.prepare(`
      INSERT INTO agents (id, friendly_name, pretty_name, cwd, labels, registered_at, last_seen, dead, human, is_manager, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        friendly_name = COALESCE(excluded.friendly_name, agents.friendly_name),
        pretty_name = COALESCE(excluded.pretty_name, agents.pretty_name),
        labels = COALESCE(excluded.labels, agents.labels),
        registered_at = COALESCE(excluded.registered_at, agents.registered_at),
        last_seen = excluded.last_seen,
        dead = excluded.dead,
        human = excluded.human,
        is_manager = excluded.is_manager,
        metadata = CASE
          WHEN excluded.metadata IS NULL THEN agents.metadata
          WHEN agents.metadata IS NULL THEN excluded.metadata
          ELSE json_patch(agents.metadata, excluded.metadata)
        END
    `);
    const AGENT_SELECT = [
      'agents.*',
      'lineages.friendly_name AS lineage_name',
      'route.agent_id IS NOT NULL AS route_present',
      'route.daemon_key AS route_daemon_key',
    ].join(', ');
    const AGENT_JOIN = `FROM agents
      LEFT JOIN lineages ON lineages.id = agents.lineage_id
      LEFT JOIN agent_daemon_routes route ON route.agent_id = agents.id`;
    this._getAgent = this.db.prepare(`SELECT ${AGENT_SELECT} ${AGENT_JOIN} WHERE agents.id = ?`);
    // A daemon's agents are the ones it most recently reported as its own.
    this._getAgentsByDaemonKey = this.db.prepare(`SELECT ${AGENT_SELECT} ${AGENT_JOIN} WHERE agents.dead = 0 AND agents.id IN (SELECT agent_id FROM agent_daemon_routes WHERE daemon_key = @daemonKey)`);
    this._getAgentByName = this.db.prepare(`SELECT ${AGENT_SELECT} ${AGENT_JOIN} WHERE agents.friendly_name = ?`);
    this._getLiveAgentsByFriendlyName = this.db.prepare(`SELECT ${AGENT_SELECT} ${AGENT_JOIN} WHERE agents.dead = 0 AND agents.friendly_name = ?`);
    this._getLiveHumanByFriendlyName = this.db.prepare('SELECT * FROM agents WHERE friendly_name = ? AND dead = 0 AND human = 1');
    this._nameTakenByOther = this.db.prepare('SELECT id FROM agents WHERE friendly_name = ? AND dead = 0 AND id != ?');
    // findAgent's name branch. Deliberately the bare row, not AGENT_SELECT: the
    // branch this replaced also read `SELECT *`, so keeping it identical makes
    // removing the tie-break a pure deletion. (It means a name lookup returns no
    // lineage_name while an id lookup does — a real inconsistency, but an
    // existing one, and not this change's to alter.)
    this._getLiveAgentRowByFriendlyName = this.db.prepare('SELECT * FROM agents WHERE friendly_name = ? AND dead = 0');
    this._getAgentDaemonRoute = this.db.prepare('SELECT agent_id, daemon_key FROM agent_daemon_routes WHERE agent_id = ?');
    this._setAgentDaemonRoute = this.db.prepare(`
      INSERT INTO agent_daemon_routes (agent_id, daemon_key) VALUES (?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET daemon_key = excluded.daemon_key
    `);
    this._deleteAgentDaemonRoute = this.db.prepare('DELETE FROM agent_daemon_routes WHERE agent_id = ?');
    this._getDaemonAgentBinding = this.db.prepare('SELECT * FROM daemon_agent_bindings WHERE daemon_key = ? AND local_agent_id = ?');
    this._getDaemonAgentBindingByAgent = this.db.prepare('SELECT * FROM daemon_agent_bindings WHERE agent_id = ?');
    this._insertDaemonAgentBinding = this.db.prepare(`
      INSERT INTO daemon_agent_bindings (daemon_key, local_agent_id, agent_id, created_at)
      VALUES (?, ?, ?, ?)
    `);
    this._upsertDaemonRegistration = this.db.prepare(`
      INSERT INTO daemon_registry (daemon_key, machine_id, env_name, install_path, user, hostname, version, boot_id, status, connected_at, disconnected_at, last_seen, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(daemon_key) DO UPDATE SET
        machine_id = excluded.machine_id,
        env_name = excluded.env_name,
        install_path = excluded.install_path,
        user = excluded.user,
        hostname = excluded.hostname,
        version = excluded.version,
        boot_id = excluded.boot_id,
        status = excluded.status,
        connected_at = excluded.connected_at,
        disconnected_at = excluded.disconnected_at,
        last_seen = excluded.last_seen,
        metadata = excluded.metadata
    `);
    this._markDaemonDisconnected = this.db.prepare(`
      UPDATE daemon_registry
      SET status = 'disconnected', disconnected_at = ?, last_seen = ?
      WHERE daemon_key = ?
    `);
    this._getDaemonRegistration = this.db.prepare('SELECT * FROM daemon_registry WHERE daemon_key = ?');
    this._listDaemonRegistrations = this.db.prepare('SELECT * FROM daemon_registry ORDER BY daemon_key');

    this._nameHistoryStmt = this.db.prepare(`
      SELECT friendly_name, from_ts, to_ts FROM name_history WHERE fleet_id = ?
      ORDER BY from_ts ASC
    `);
    // last_active is a maintained column on agents (bumped on every event
    // insert — see share()), so this is a plain indexed read that never touches
    // the events table. Earlier versions computed last_active inline (correlated
    // subquery, then a grouped index pass); both scanned ~400k events per call
    // and pinned the event loop for seconds-to-tens-of-seconds under load.
    this._getAllAgents = this.db.prepare(`SELECT ${AGENT_SELECT} ${AGENT_JOIN} ORDER BY agents.last_seen DESC`);
    // Live-only roster (the agents panel never shows dead agents). Indexed by
    // idx_agents_alive(dead, last_seen DESC) → returns ~tens of rows, not ~1300.
    this._getAliveAgents = this.db.prepare(`SELECT ${AGENT_SELECT} ${AGENT_JOIN} WHERE agents.dead = 0 AND COALESCE(json_extract(agents.metadata, '$.shell'), 0) != 1 ORDER BY agents.last_seen DESC`);
    this._getAliveAgentsPage = this.db.prepare(`
      SELECT ${AGENT_SELECT} ${AGENT_JOIN}
      WHERE agents.dead = 0
        AND COALESCE(json_extract(agents.metadata, '$.shell'), 0) != 1
        AND (agents.last_seen < @lastSeen OR (agents.last_seen = @lastSeen AND agents.id < @id))
      ORDER BY agents.last_seen DESC, agents.id DESC
      LIMIT @limit
    `);
    // id→friendly_name only — for labeling chat history without hydrating all
    // ~1300 agents (parsing labels/metadata/session JSON per row).
    this._getAgentNames = this.db.prepare(`SELECT id, friendly_name FROM agents`);
    this._deleteAgent = this.db.prepare('DELETE FROM agents WHERE id = ?');
    this._updateAgentLastSeen = this.db.prepare('UPDATE agents SET last_seen = ? WHERE id = ?');
    this._markAgentDead = this.db.prepare('UPDATE agents SET dead = 1 WHERE id = ?');
    this._markAgentAlive = this.db.prepare('UPDATE agents SET dead = 0 WHERE id = ?');

    // Task queries
    this._upsertTask = this.db.prepare(`
      INSERT INTO tasks (id, agent, description, message, delegated_by, delegated_at, status, acknowledged, completed_at, last_checked, updated_at, blocked_by, success_criteria, reported, synthetic, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        agent = excluded.agent,
        description = excluded.description,
        message = COALESCE(excluded.message, tasks.message),
        delegated_by = COALESCE(excluded.delegated_by, tasks.delegated_by),
        status = excluded.status,
        acknowledged = excluded.acknowledged,
        completed_at = excluded.completed_at,
        last_checked = excluded.last_checked,
        updated_at = excluded.updated_at,
        blocked_by = excluded.blocked_by,
        success_criteria = COALESCE(excluded.success_criteria, tasks.success_criteria),
        reported = excluded.reported,
        synthetic = excluded.synthetic,
        metadata = COALESCE(excluded.metadata, tasks.metadata)
    `);

    this._getTask = this.db.prepare('SELECT * FROM tasks WHERE id = ?');
    this._getActiveTasksByAgent = this.db.prepare("SELECT * FROM tasks WHERE agent = ? AND status NOT IN ('done', 'retracted') ORDER BY delegated_at DESC");
    this._getActiveTasksByAgentLimited = this.db.prepare("SELECT * FROM tasks WHERE agent = ? AND status NOT IN ('done', 'retracted') ORDER BY delegated_at DESC LIMIT ?");
    this._getActiveTaskCountByAgent = this.db.prepare("SELECT COUNT(*) as c FROM tasks WHERE agent = ? AND status NOT IN ('done', 'retracted')");
    this._getAllActiveTasks = this.db.prepare("SELECT * FROM tasks WHERE status NOT IN ('done', 'retracted') ORDER BY delegated_at DESC");
    this._getActiveTaskCount = this.db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status NOT IN ('done', 'retracted')");
    this._getActiveTasksPage = this.db.prepare(`
      SELECT * FROM tasks
      WHERE status NOT IN ('done', 'retracted')
        AND (delegated_at < @delegatedAt OR (delegated_at = @delegatedAt AND id < @id))
      ORDER BY delegated_at DESC, id DESC
      LIMIT @limit
    `);
    this._getAllTasks = this.db.prepare('SELECT * FROM tasks ORDER BY delegated_at DESC');
    this._deleteTask = this.db.prepare('DELETE FROM tasks WHERE id = ?');
    this._hasSessionEntries = this.db.prepare('SELECT 1 FROM session_entries WHERE session_id = ? LIMIT 1');
    this._getDelegateEventForTask = this.db.prepare(`
      SELECT ${this._EVT} FROM events WHERE task_id = ? AND type = 'delegate' ORDER BY id DESC LIMIT 1
    `);
    this._getUnreadForEvent = this.db.prepare('SELECT event_id, to_id, read FROM unread WHERE event_id = ? AND to_id = ?');
    this._deleteUnreadForEvent = this.db.prepare('DELETE FROM unread WHERE event_id = ? AND to_id = ? AND read = 0');

    // Shared doc queries
    // A null path/title/agent CLEARS the stored value; it does not preserve it.
    // This statement used to COALESCE those three, but nothing called the
    // method — the two live share paths (the shared-docs-set socket verb and
    // POST /api/shared-docs) each ran their own copy of this SQL with plain
    // `= excluded.x`, so clearing is the behaviour the app actually has. The
    // method now matches the app rather than the app matching the method.
    // shared_at is left alone on conflict: the first share is when it was
    // shared.
    this._upsertSharedDoc = this.db.prepare(`
      INSERT INTO shared_docs (doc, path, title, agent, ephemeral, shared_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(doc) DO UPDATE SET
        path = excluded.path,
        title = excluded.title,
        agent = excluded.agent,
        ephemeral = excluded.ephemeral,
        updated_at = excluded.updated_at
    `);

    this._getSharedDoc = this.db.prepare('SELECT * FROM shared_docs WHERE doc = ?');
    this._getAllSharedDocs = this.db.prepare('SELECT * FROM shared_docs ORDER BY updated_at DESC');

    // Wiretap queries
    this._addWiretap = this.db.prepare('INSERT INTO wiretaps (agent_id, filter, types) VALUES (?, ?, ?)');
    this._getWiretaps = this.db.prepare('SELECT * FROM wiretaps');
    this._getWiretapsByAgent = this.db.prepare('SELECT * FROM wiretaps WHERE agent_id = ?');
    this._deleteWiretap = this.db.prepare('DELETE FROM wiretaps WHERE id = ?');
    this._deleteWiretapsByAgent = this.db.prepare('DELETE FROM wiretaps WHERE agent_id = ?');
    this._addSubscription = this.db.prepare(`INSERT INTO subscriptions (owner, query, notification_policy, created_at, created_by, adapter, adapter_id) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    this._getSubscriptionsByOwner = this.db.prepare('SELECT * FROM subscriptions WHERE owner = ? ORDER BY subscription_id DESC');
    this._getSubscriptionsByAdapter = this.db.prepare('SELECT * FROM subscriptions WHERE adapter = ? ORDER BY subscription_id');
    this._getSubscription = this.db.prepare('SELECT * FROM subscriptions WHERE subscription_id = ?');
    this._deleteSubscription = this.db.prepare('DELETE FROM subscriptions WHERE subscription_id = ?');
    this._updateSubscriptionQuery = this.db.prepare('UPDATE subscriptions SET query = ?, adapter_id = ? WHERE subscription_id = ?');
    this._updateWiretapFilter = this.db.prepare('UPDATE wiretaps SET filter = ? WHERE id = ?');

    // Event queries for chat history
    const E = this._EVT;
    const chatTypePh = CHAT_HISTORY_EVENT_TYPES.map(() => '?').join(',');
    // Selection is always DESC — the newest rows are the page — and the final
    // order is applied by an outer sort so callers never reverse an array.
    this._queryEventsBefore = this.db.prepare(`
      SELECT * FROM (SELECT ${E} FROM events INDEXED BY idx_events_ts WHERE timestamp < ? AND type IN (${chatTypePh}) ORDER BY timestamp DESC LIMIT ?) ORDER BY timestamp ASC
    `);
    this._queryEventsBeforeDesc = this.db.prepare(`
      SELECT ${E} FROM events INDEXED BY idx_events_ts WHERE timestamp < ? AND type IN (${chatTypePh}) ORDER BY timestamp DESC LIMIT ?
    `);
    this._queryEventsLatest = this.db.prepare(`
      SELECT * FROM (SELECT ${E} FROM events INDEXED BY idx_events_ts WHERE type IN (${chatTypePh}) ORDER BY timestamp DESC LIMIT ?) ORDER BY timestamp ASC
    `);
    this._queryEventsLatestDesc = this.db.prepare(`
      SELECT ${E} FROM events INDEXED BY idx_events_ts WHERE type IN (${chatTypePh}) ORDER BY timestamp DESC LIMIT ?
    `);
    // Agent-scoped history matches the exact requested fleet ids. The SQL has
    // variable arity and is built per-call in queryChatHistory().
    this._queryEventsByType = this.db.prepare(`
      SELECT ${E} FROM events WHERE type = ? ORDER BY timestamp DESC LIMIT ?
    `);
    this._queryEventsAfterRowid = this.db.prepare(`
      SELECT ${E} FROM events WHERE id > ? ORDER BY id ASC LIMIT ?
    `);
    this._lastRowid = this.db.prepare('SELECT MAX(id) as max_id FROM events');

    // QA system queries
    this._setQaConfig = this.db.prepare('INSERT OR REPLACE INTO qa_config (key, value) VALUES (?, ?)');
    this._getQaConfig = this.db.prepare('SELECT value FROM qa_config WHERE key = ?');
    this._getAllQaConfig = this.db.prepare('SELECT * FROM qa_config');
    this._insertQaReport = this.db.prepare(`
      INSERT INTO qa_reports (task_id, agent_id, task_type, fields, submitted_at, superseded)
      VALUES (?, ?, ?, ?, ?, 0)
    `);
    this._supersedeQaReports = this.db.prepare('UPDATE qa_reports SET superseded = 1 WHERE task_id = ? AND superseded = 0');
    this._getActiveQaReport = this.db.prepare('SELECT * FROM qa_reports WHERE task_id = ? AND superseded = 0 ORDER BY id DESC LIMIT 1');
    this._insertQaSignature = this.db.prepare(`
      INSERT INTO qa_signatures (task_id, report_id, agent_id, verdict, notes, signed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this._getQaSignatures = this.db.prepare('SELECT * FROM qa_signatures WHERE report_id = ? ORDER BY signed_at ASC');
    this._getQaSignaturesByTask = this.db.prepare('SELECT * FROM qa_signatures WHERE task_id = ? ORDER BY signed_at DESC');
  }

  // Run a prepared statement and parse metadata JSON on each row
  _query(stmt, ...args) {
    return stmt.all(...args).map(r => ({
      ...r,
      metadata: r.metadata ? JSON.parse(r.metadata) : null,
    }))
  }

  // ---- share() — the single write primitive ----

  /**
   * Write an event to the store. This is the ONE function that writes data.
   *
   * @param {Object} event
   * @param {string} event.type - Event type (chat, delegate, task_done, task_update, report, register, lifecycle)
   * @param {string} [event.from] - Sender agent ID
   * @param {string} [event.to] - Recipient agent ID
   * @param {string} [event.text] - Message text or description
   * @param {Object} [event.metadata] - Type-specific data (JSON-serialized)
   * @param {string} [event.taskId] - Associated task ID
   * @param {string} [event.agentId] - Subject agent ID
   * @param {boolean} [event.unread] - If true, creates an unread entry for the recipient
   * @returns {Object} The inserted event with its ID
   */
  async _insertEventRecord(event, { notify = true } = {}) {
    const ts = event.timestamp || new Date().toISOString();
    let metadata = event.metadata || null;

    // Resolve wiretap recipients before writing the event so the persisted
    // record, its unread mailbox rows, and the broadcast payload agree.
    if (WIRETAP_EVENT_TYPES.has(event.type) && event.from && event.to) {
      if (typeof metadata === 'string') {
        try { metadata = JSON.parse(metadata) } catch { metadata = {} }
      }
      if (!metadata || typeof metadata !== 'object') metadata = {};
      const resolved = this.resolveWiretaps(event.from, event.to, event.type);
      const wiretapCc = [...new Set([...(metadata.wiretap_cc || []), ...resolved])];
      if (wiretapCc.length) metadata = { ...metadata, wiretap_cc: wiretapCc };
    }
    const meta = metadata ? JSON.stringify(metadata) : null;

    // The events INSERT runs inside fleet-store.worker.mjs: a slow FTS merge
    // here never freezes the main event loop. We await it because we need the
    // real row id.
    const result = await this._wAwait(this._insertEvent, [
      event.type,
      ts,
      event.from || null,
      event.to || null,
      event.text || null,
      meta,
      event.taskId || null,
      event.agentId || null,
    ]);

    const eventId = result.lastInsertRowid;

    // Maintain agents.last_active incrementally, ordered after the insert, so
    // getAllAgents never scans events.
    if (event.from || event.to) {
      await this._wAwait(this._updateAgentLastActive, [ts, ts, event.from || null, event.to || null]);
    }

    // Track unread before returning so callers that immediately retract can
    // operate on a real mailbox row.
    if (event.unread !== false && event.to && (event.type === 'chat' || event.type === 'delegate')) {
      // Direct, explicit-CC, and wiretap recipients must all have the same
      // durable inbox path. Channel notifications are only previews.
      const unreadRecipients = new Set([event.to]);
      for (const recipient of metadata?.cc || []) unreadRecipients.add(recipient);
      for (const recipient of metadata?.wiretap_cc || []) unreadRecipients.add(recipient);
      for (const recipient of unreadRecipients) {
        await this._wAwait(this._insertUnread, [eventId, recipient]);
      }
    }

    const inserted = {
      id: Number(eventId),
      type: event.type,
      timestamp: ts,
      from_id: event.from || null,
      to_id: event.to || null,
      text: event.text || null,
      metadata,
      task_id: event.taskId || null,
      agent_id: event.agentId || null,
      read: false,
    };

    // Notify listeners (SSE broadcast)
    if (notify) {
      for (const fn of this._listeners) {
        try { fn(inserted); } catch {}
      }
    }

    return inserted;
  }

  insertEventRecord(event, options = {}) {
    return this._insertEventRecord(event, options);
  }

  getChatTempIdResult(tempId) {
    if (!tempId) return null
    const rows = this.db.prepare(`
      SELECT id, to_id
      FROM events
      WHERE type = 'chat'
        AND json_extract(metadata, '$.client_temp_id') = ?
      ORDER BY id
    `).all(tempId)
    if (!rows.length) return null
    return {
      eventIds: rows.map(row => Number(row.id)),
      recipients: rows.map(row => row.to_id).filter(Boolean),
      receipts: [],
    }
  }

  getTransportOperationResult(operationId, operationType) {
    if (!operationId) return null
    const row = this.db.prepare(`
      SELECT operation_type, status, terminal_kind, terminal_payload, completed_at
      FROM transport_operations
      WHERE operation_id = ?
    `).get(operationId)
    if (!row) return null
    if (row.operation_type !== operationType) {
      const error = new Error(`operation id ${operationId} was already used for ${row.operation_type}`)
      error.code = 'operation-id-conflict'
      throw error
    }
    if (row.status === 'accepted' || !row.terminal_kind) return null
    const payload = JSON.parse(row.terminal_payload)
    // A row whose payload was dropped for size has nothing to replay. Returning
    // null sends the caller down the ordinary re-execute path, the same one taken
    // when no row was ever written. Replaying the marker would hand the client an
    // object that looks like a result and isn't.
    if (payload && typeof payload === 'object' && payload[TRANSPORT_PAYLOAD_OMITTED]) return null
    return {
      kind: row.terminal_kind,
      payload,
      completedAt: row.completed_at,
    }
  }

  beginTransportOperation(envelope) {
    const operationId = envelope?.operation_id
    if (!operationId) return null
    const existing = this.db.prepare(`
      SELECT operation_type, delivery_class
      FROM transport_operations
      WHERE operation_id = ?
    `).get(operationId)
    if (existing && (
      existing.operation_type !== envelope.operation_type
      || existing.delivery_class !== envelope.delivery_class
    )) {
      const error = new Error(
        `operation id ${operationId} was already used for `
        + `${existing.delivery_class}:${existing.operation_type}`,
      )
      error.code = 'operation-id-conflict'
      throw error
    }
    this.db.prepare(`
      INSERT INTO transport_operations (
        operation_id, operation_type, delivery_class, sender, destination,
        parent_operation_id, created_at, attempt, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accepted')
      ON CONFLICT(operation_id) DO UPDATE SET
        attempt = MAX(transport_operations.attempt, excluded.attempt)
    `).run(
      operationId,
      envelope.operation_type,
      envelope.delivery_class,
      envelope.sender || null,
      envelope.destination || null,
      envelope.parent_operation_id || null,
      envelope.created_at || new Date().toISOString(),
      Number(envelope.attempt) || 1,
    )
    return this.getTransportOperationStatus(operationId)
  }

  getTransportOperationStatus(operationId) {
    if (!operationId) return null
    const row = this.db.prepare(`
      SELECT *
      FROM transport_operations
      WHERE operation_id = ?
    `).get(operationId)
    if (!row) return null
    return {
      operation_id: row.operation_id,
      operation_type: row.operation_type,
      delivery_class: row.delivery_class,
      sender: row.sender,
      destination: row.destination,
      parent_operation_id: row.parent_operation_id,
      created_at: row.created_at,
      attempt: row.attempt,
      status: row.status,
      terminal_kind: row.terminal_kind,
      terminal_payload: row.terminal_payload ? JSON.parse(row.terminal_payload) : null,
      completed_at: row.completed_at,
    }
  }

  recordTransportOperationResult(operationId, operationType, kind, payload, envelope = null) {
    if (!operationId) return
    const terminalKind = kind === 'error' ? 'error' : 'result'
    let serialized = JSON.stringify(payload ?? null)

    // Oversized results are recorded WITHOUT their payload.
    //
    // This column stores a result so that a retry of the same operation_id can
    // be answered from it instead of re-executing (see
    // getTransportOperationResult and its use in handleFleetWsMessage). That
    // makes it an idempotency cache, not just an audit trail — so it cannot be
    // truncated in place: a retry would be replayed a mangled payload and
    // believe it.
    //
    // Instead, drop the payload and store a marker object in its place.
    // getTransportOperationResult recognises the marker and declines to replay,
    // so the operation re-executes — exactly what already happens for any
    // operation whose row was never written. Replay is an optimisation; losing
    // it for a handful of bulk reads costs one repeated query.
    //
    // The marker goes in the payload rather than in terminal_kind because that
    // column has a CHECK constraint (`terminal_kind IN ('result','error')`), and
    // widening a CHECK in SQLite means rebuilding the table — a 28 GB rewrite on
    // Skip's live database to fix a problem about disk space.
    //
    // Why this exists: on 2026-07-25 this table was 28.6 GB of a 40 GB volume
    // with ~7 hours of headroom, and 21.95 GB of that was 3,776 `store-agents`
    // rows averaging 5.81 MB each — the entire agent roster, stored as the
    // audit record of having asked for the agent roster. Nothing pruned it.
    if (serialized && serialized.length > TRANSPORT_PAYLOAD_MAX_BYTES) {
      serialized = JSON.stringify({
        [TRANSPORT_PAYLOAD_OMITTED]: true,
        reason: 'payload-too-large',
        bytes: serialized.length,
        limit: TRANSPORT_PAYLOAD_MAX_BYTES,
        operation_type: operationType,
      })
    }
    this.db.prepare(`
      INSERT INTO transport_operations (
        operation_id, operation_type, delivery_class, sender, destination,
        parent_operation_id, created_at, attempt, status,
        terminal_kind, terminal_payload, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(operation_id) DO UPDATE SET
        status = excluded.status,
        terminal_kind = excluded.terminal_kind,
        terminal_payload = excluded.terminal_payload,
        completed_at = excluded.completed_at,
        attempt = MAX(transport_operations.attempt, excluded.attempt)
    `).run(
      operationId,
      operationType,
      envelope?.delivery_class || 'durable',
      envelope?.sender || null,
      envelope?.destination || null,
      envelope?.parent_operation_id || null,
      envelope?.created_at || new Date().toISOString(),
      Number(envelope?.attempt) || 1,
      terminalKind === 'error' ? 'failed' : 'completed',
      terminalKind,
      serialized,
      new Date().toISOString(),
    )
    this._maybePruneTransportOperations()
  }

  pruneTransportOperations({
    now = new Date(),
    terminalRetentionHours = TRANSPORT_OPERATION_RETENTION_HOURS,
    acceptedRetentionHours = TRANSPORT_OPERATION_ACCEPTED_RETENTION_HOURS,
    batchMax = TRANSPORT_OPERATION_PRUNE_BATCH_MAX,
  } = {}) {
    const limit = Math.floor(Number(batchMax) || 0)
    if (limit <= 0) return { terminal: 0, accepted: 0 }

    let terminal = 0
    if (Number(terminalRetentionHours) > 0) {
      const cutoff = new Date(now.getTime() - Number(terminalRetentionHours) * 60 * 60 * 1000).toISOString()
      terminal = this.db.prepare(`
        DELETE FROM transport_operations
        WHERE operation_id IN (
          SELECT operation_id
          FROM transport_operations
          WHERE status IN ('completed', 'failed')
            AND completed_at IS NOT NULL
            AND completed_at < ?
          ORDER BY completed_at ASC
          LIMIT ?
        )
      `).run(cutoff, limit).changes
    }

    let accepted = 0
    if (terminal < limit && Number(acceptedRetentionHours) > 0) {
      const cutoff = new Date(now.getTime() - Number(acceptedRetentionHours) * 60 * 60 * 1000).toISOString()
      accepted = this.db.prepare(`
        DELETE FROM transport_operations
        WHERE operation_id IN (
          SELECT operation_id
          FROM transport_operations
          WHERE status = 'accepted'
            AND created_at < ?
          ORDER BY created_at ASC
          LIMIT ?
        )
      `).run(cutoff, limit - terminal).changes
    }

    return { terminal, accepted }
  }

  _maybePruneTransportOperations(nowMs = Date.now()) {
    if (TRANSPORT_OPERATION_PRUNE_INTERVAL_MS <= 0 || TRANSPORT_OPERATION_PRUNE_BATCH_MAX <= 0) return
    if (this._lastTransportOperationPruneAt && nowMs - this._lastTransportOperationPruneAt < TRANSPORT_OPERATION_PRUNE_INTERVAL_MS) return
    this._lastTransportOperationPruneAt = nowMs
    try {
      this.pruneTransportOperations({ now: new Date(nowMs) })
    } catch (e) {
      // Deliberately swallowed: this is an opportunistic prune riding on the
      // path that records a transport operation. Housekeeping must never fail
      // the operation it piggybacks on — a prune that doesn't happen costs some
      // disk until the next interval, while rethrowing here would break the
      // thing the caller actually came to do. Logged, not raised.
      console.warn(`[fleet-store] transport operation prune failed: ${e.message}`)
    }
  }

  getReportCloseOperationResult(operationId) {
    if (!operationId) return null
    const rows = this.db.prepare(`
      SELECT id, type, task_id
      FROM events
      WHERE type IN ('report', 'chat', 'task_done')
        AND json_extract(metadata, '$.client_operation_id') = ?
      ORDER BY id
    `).all(operationId)
    if (!rows.length) return null
    const report = rows.find(row => row.type === 'report') || null
    const chat = rows.find(row => row.type === 'chat') || null
    const close = rows.find(row => row.type === 'task_done') || null
    return {
      reportEventId: report ? Number(report.id) : null,
      chatEventId: chat ? Number(chat.id) : null,
      closeEventId: close ? Number(close.id) : null,
      taskId: close?.task_id || report?.task_id || null,
      eventIds: rows.map(row => Number(row.id)),
    }
  }

  getDelegateOperationResult(operationId) {
    if (!operationId) return null
    const events = this.db.prepare(`
      SELECT id, task_id
      FROM events
      WHERE type = 'delegate'
        AND json_extract(metadata, '$.client_operation_id') = ?
      ORDER BY id
    `).all(operationId)
    const task = this.db.prepare(`
      SELECT id
      FROM tasks
      WHERE json_extract(metadata, '$.client_operation_id') = ?
      ORDER BY delegated_at DESC
      LIMIT 1
    `).get(operationId)
    if (!events.length && !task) return null
    const event = events[0] || null
    return {
      delegateEventId: event ? Number(event.id) : null,
      taskId: event?.task_id || task?.id || null,
      eventIds: events.map(row => Number(row.id)),
    }
  }

  async share(event) {
    return this._insertEventRecord(event, { notify: true });
  }

  // ---- Convenience write methods (all call share() internally) ----

  chat(from, to, text, metadata, timestamp) {
    return this.share({ type: 'chat', from, to, text, metadata, unread: true, timestamp });
  }

  delegate(from, to, taskId, description, metadata, { unread = true } = {}) {
    return this.share({
      type: 'delegate', from, to, text: description,
      taskId, metadata, unread,
    });
  }

  taskDone(agentId, taskId, description, metadata) {
    return this.share({
      type: 'task_done', from: agentId, text: description,
      taskId, agentId, metadata, unread: false,
    });
  }

  taskUpdate(agentId, taskId, status, metadata) {
    return this.share({
      type: 'task_update', agentId, taskId,
      text: `status → ${status}`, metadata: { ...metadata, status },
    });
  }

  report(agentId, taskId, summary, metadata) {
    return this.share({
      type: 'report', from: agentId, text: summary,
      taskId, agentId, metadata,
    });
  }

  lifecycle(type, agentId, text, metadata) {
    return this.share({
      type: 'lifecycle', agentId, text: `${type}: ${text}`,
      metadata: { ...metadata, subtype: type },
    });
  }

  _initAgentRegistry() {
    this._agentRegistry = createLiveStore();
    this._aliveAgentRegistry = createLiveStore();
    this._agentById = this._agentRegistry.index('byId', a => a.id);
    this._agentByName = this._agentRegistry.index('byName', a => a.friendly_name || []);
    this._agentByLabel = this._agentRegistry.index('byLabel', a => labelsForAgent(a));
    this._aliveAgentById = this._aliveAgentRegistry.index('byId', a => a.id);
    this._aliveAgentByName = this._aliveAgentRegistry.index('byName', a => a.friendly_name || []);
    this._aliveAgentByLabel = this._aliveAgentRegistry.index('byLabel', a => labelsForAgent(a));
    this._agentRosterView = this._agentRegistry.view(
      () => true,
      { key: 'fleet-roster:all', compare: compareAgentsForRoster }
    );
    this._aliveAgentRosterView = this._aliveAgentRegistry.view(
      () => true,
      { key: 'fleet-roster:alive', compare: compareAgentsForRoster }
    );
    this._agentRegistryLoaded = false;
    this._taskChanges = [];
    this._taskChangesOverflow = false;
    this._maxQueuedTaskChanges = 1000;
  }

  _ensureAgentRegistryLoaded() {
    if (this._agentRegistryLoaded) return;
    this._reloadAgentRegistry();
  }

  _reloadAgentRegistry() {
    if (!this._agentRegistry || !this._aliveAgentRegistry) return;
    const rows = this._getAllAgents.all().map(r => this.projectAgentDaemonRoute(this._hydrateAgent(r)));
    const ids = new Set(rows.map(a => a.id));
    const aliveIds = new Set(rows.filter(isFleetRosterAgent).map(a => a.id));
    this._agentRegistry.bulk(s => {
      for (const a of rows) s.upsert(a);
      for (const a of s.all()) {
        if (!ids.has(a.id)) s.remove(a.id);
      }
    });
    this._aliveAgentRegistry.bulk(s => {
      for (const a of rows) {
        if (!isFleetRosterAgent(a)) s.remove(a.id);
        else s.upsert(a);
      }
      for (const a of s.all()) {
        if (!aliveIds.has(a.id)) s.remove(a.id);
      }
    });
    this._agentRegistryLoaded = true;
  }

  _syncAgentRegistry(id) {
    if (!this._agentRegistry || !this._aliveAgentRegistry || !id) return;
    const agent = this.getAgent(id);
    if (!agent) {
      this._agentRegistry.remove(id);
      this._aliveAgentRegistry.remove(id);
      return;
    }
    this._agentRegistry.upsert(agent);
    if (!isFleetRosterAgent(agent)) this._aliveAgentRegistry.remove(id);
    else this._aliveAgentRegistry.upsert(agent);
  }

  _agentRegistryViewKey(filter, from) {
    return `fleet-recipient:${filter || '<all>'}:from:${from || ''}`;
  }

  resolveChatRecipients(filterAst, { from = null, filter = '' } = {}) {
    this._ensureAgentRegistryLoaded();
    const literal = astLiteral(filterAst);
    if (literal) {
      const found = new Map();
      const byId = this._aliveAgentRegistry.get(literal);
      if (byId) found.set(byId.id, byId);
      for (const a of this._aliveAgentByName.get(literal)) found.set(a.id, a);
      for (const a of this._aliveAgentByLabel.get(literal)) found.set(a.id, a);
      return [...found.values()]
        .filter(a => a.id !== from)
        .sort(compareAgentsForRoster)
        .map(a => a.id);
    }

    const view = this._aliveAgentRegistry.view(
      a => a.id !== from && evalExpr(filterAst, labelsForAgent(a)),
      { key: this._agentRegistryViewKey(filter, from), compare: compareAgentsForRoster }
    );
    return view.list.map(a => a.id);
  }

  // ---- Agent state management ----

  getAgentDaemonRoute(agentId) {
    return this._getAgentDaemonRoute.get(agentId) || null;
  }

  getAgentDaemonRoutes(agentIds) {
    const ids = [...new Set((agentIds || []).filter(Boolean))];
    const routes = new Map();
    if (!ids.length) return routes;
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT agent_id, daemon_key FROM agent_daemon_routes WHERE agent_id IN (${placeholders})`
    ).all(...ids);
    for (const row of rows) routes.set(row.agent_id, row);
    return routes;
  }

  setAgentDaemonRoute(agentId, daemonKey) {
    if (!agentId || !daemonKey) throw new Error('agent daemon route requires agentId and daemonKey');
    this._setAgentDaemonRoute.run(String(agentId), String(daemonKey));
    this._bustAgentsCache();
    this._syncAgentRegistry(agentId);
    return this.getAgentDaemonRoute(agentId);
  }

  getDaemonAgentBinding(daemonKey, localAgentId) {
    if (!daemonKey || !localAgentId) return null;
    return this._getDaemonAgentBinding.get(String(daemonKey), String(localAgentId)) || null;
  }

  bindDaemonAgent({ daemonKey, localAgentId, agentId, now = new Date().toISOString() } = {}) {
    if (!daemonKey || !localAgentId || !agentId) {
      throw new Error('daemon agent binding requires daemonKey, localAgentId, and agentId');
    }
    const existingLocal = this.getDaemonAgentBinding(daemonKey, localAgentId);
    if (existingLocal) {
      if (existingLocal.agent_id === agentId) return existingLocal;
      throw new Error(`daemon agent ${daemonKey}/${localAgentId} is already bound to ${existingLocal.agent_id}`);
    }
    const existingAgent = this._getDaemonAgentBindingByAgent.get(String(agentId));
    if (existingAgent) {
      throw new Error(`server agent ${agentId} is already bound to ${existingAgent.daemon_key}/${existingAgent.local_agent_id}`);
    }
    this._insertDaemonAgentBinding.run(String(daemonKey), String(localAgentId), String(agentId), now);
    return this.getDaemonAgentBinding(daemonKey, localAgentId);
  }


  upsertAgent(agent, { allowProtectedAgentFields = false } = {}) {
    try {
      if (!allowProtectedAgentFields) {
        agent = withoutProtectedAgentFields(agent);
      }
      // An agent must not hold a label equal to a live agent's friendly_name —
      // DNF chat routing treats friendly_names and labels equivalently, so a
      // colliding label shadows the named agent and breaks filter-by-label.
      // Strip such labels at write time (only when labels are actually being set).
      if (Array.isArray(agent.labels) && agent.labels.length) {
        const taken = new Set(
          this.db.prepare(
            'SELECT friendly_name FROM agents WHERE dead = 0 AND friendly_name IS NOT NULL AND id != ?'
          ).all(agent.id || '').map(r => r.friendly_name)
        );
        const filtered = agent.labels.filter(l => !taken.has(l));
        if (filtered.length !== agent.labels.length) {
          const dropped = agent.labels.filter(l => taken.has(l));
          console.log(`[fleet-store] stripped friendly-name-colliding label(s) from ${agent.id}: ${dropped.join(', ')}`);
          agent = { ...agent, labels: filtered };
        }
      }
      this._upsertAgent.run(
        agent.id,
        agent.friendly_name || null,
        serializePrettyName(agent.pretty_name),
        agent.cwd || null,
        agent.labels ? JSON.stringify(agent.labels) : null,
        agent.registered_at || null,
        agent.last_seen || new Date().toISOString(),
        agent.dead ? 1 : 0,
        agent.human ? 1 : 0,
        agent.is_manager ? 1 : 0,
        agent.metadata ? JSON.stringify(agent.metadata) : null
      );
      if (agent.cwd != null) this._replaceCwdSegments('agent', agent.id, agent.cwd);
      this._bustAgentsCache();
      this._syncAgentRegistry(agent.id);
    } catch (e) {
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || e.message?.includes('UNIQUE constraint failed')) {
        throw new Error(`Name "${agent.friendly_name}" is already taken by another live agent`);
      }
      throw e;
    }
  }

  // Agents associated with a particular daemon registry identity. Used by the
  // server when sending a `daemon-welcome` message and when routing RPCs.
  getAgentsByDaemon(machineId, envName) {
    if (!machineId || !envName) return [];
    return this.getAgentsByDaemonKey(`${machineId}:${envName}`);
  }

  getAgentsByDaemonKey(daemonKey) {
    if (!daemonKey) return [];
    return this._getAgentsByDaemonKey.all({ daemonKey })
      .map(r => this.projectAgentDaemonRoute(this._hydrateAgent(r)));
  }

  projectAgentDaemonRoute(agent) {
    if (!agent?.id) return agent;
    const route = this.getAgentDaemonRoute(agent.id);
    if (!route) return withoutProtectedAgentFields(agent);
    return {
      ...agent,
      route_present: true,
      route_daemon_key: route.daemon_key,
      daemon_key: route.daemon_key,
    };
  }

  upsertDaemonRegistration(daemon) {
    const now = daemon.last_seen || new Date().toISOString();
    this._upsertDaemonRegistration.run(
      daemon.daemon_key,
      daemon.machine_id,
      daemon.env_name,
      daemon.install_path || null,
      daemon.user || null,
      daemon.hostname || null,
      daemon.version || null,
      daemon.boot_id || null,
      daemon.status || 'connected',
      daemon.connected_at || now,
      null,
      now,
      daemon.metadata ? JSON.stringify(daemon.metadata) : null
    );
  }

  markDaemonDisconnected(daemonKey, ts = new Date().toISOString()) {
    if (!daemonKey) return;
    this._markDaemonDisconnected.run(ts, ts, daemonKey);
  }

  getDaemonRegistration(daemonKey) {
    const row = this._getDaemonRegistration.get(daemonKey);
    if (!row) return null;
    return { ...row, metadata: row.metadata ? JSON.parse(row.metadata) : null };
  }

  listDaemonRegistrations() {
    return this._listDaemonRegistrations.all().map(row => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
    }));
  }

  getAgent(id) {
    const row = this._getAgent.get(id);
    return row ? this.projectAgentDaemonRoute(this._hydrateAgent(row)) : null;
  }

  // ---- Name provenance ----

  // Everything needed to name a set of agents at arbitrary instants, in two
  // queries regardless of how many rows are being named.
  //
  // This replaces a per-(id, ts) `nameAt` lookup. Its only caller was
  // `stampNames` in unified-server.mjs, which ran SIX store calls per row —
  // three `nameAt` and three `getAgent` — over a page capped at 5,000 rows.
  // That is up to 30,000 point queries to render one events reply, and it was
  // the largest single fan-out in the server. A page mentions a few dozen
  // distinct agents at most, so the work was never proportional to the answer.
  //
  // The `getAgent` half was worse than a query: it hydrated the whole agent —
  // JSON.parse of metadata and labels, plus runtime-status and
  // seat projection — to read one column off the row. `_hydrateAgent` is the
  // top frame in six of the stalls in the live lag profiler.
  //
  // Returns a Map from fleet id to { spans, current }. `spans` is oldest-first,
  // which is the order resolveNameAt walks.
  nameSpansFor(ids) {
    const unique = [...new Set((ids || []).filter(Boolean))];
    const out = new Map();
    if (!unique.length) return out;
    for (const id of unique) out.set(id, { spans: [], current: null });

    // Chunked because a parameter list is bounded (SQLITE_MAX_VARIABLE_NUMBER
    // is 999 on older builds). A page's distinct agents fit in one chunk in
    // practice; the loop is so a caller passing a large id set cannot fail.
    for (let i = 0; i < unique.length; i += 400) {
      const chunk = unique.slice(i, i + 400);
      const holes = chunk.map(() => '?').join(',');
      const spans = this.db.prepare(`
        SELECT fleet_id, friendly_name, from_ts, to_ts FROM name_history
        WHERE fleet_id IN (${holes})
        ORDER BY fleet_id, from_ts ASC, id ASC
      `).all(...chunk);
      for (const span of spans) out.get(span.fleet_id)?.spans.push(span);

      const current = this.db.prepare(
        `SELECT id, friendly_name FROM agents WHERE id IN (${holes})`,
      ).all(...chunk);
      for (const row of current) {
        const entry = out.get(row.id);
        if (entry) entry.current = row.friendly_name;
      }
    }
    return out;
  }

  // Full span list for an agent, oldest first. Used for the thread-header
  // provenance trail (e.g. "conc4 → concentration → (current)").
  nameHistory(fleetId) {
    if (!fleetId) return [];
    return this._nameHistoryStmt.all(fleetId);
  }

  // One-time seed so existing agents (registered before the triggers existed)
  // resolve correctly. The exact current friendly_name is copied verbatim.
  // Pre-history events (before from_ts) fall back to the earliest known name.
  _backfillNameHistory() {
    const has = this.db.prepare('SELECT 1 FROM name_history LIMIT 1').get();
    if (has) return;
    const insert = this.db.prepare(
      'INSERT INTO name_history (fleet_id, friendly_name, from_ts, to_ts) VALUES (?, ?, ?, ?)'
    );
    const seeded = new Set(); // fleet_ids that got at least one span
    let spans = 0;
    this.db.transaction(() => {
      // Reconcile every agent's open span against its CURRENT friendly_name.
      //    The agents table is the source of truth for the present name; the open
      //    span must match it. Three cases:
      //      (a) no open span        → seed current name from registered_at.
      //      (b) open span agrees    → nothing to do.
      //      (c) open span disagrees → the agent was renamed OUTSIDE the phase
      //          log (the /rename route or an admin sweep), so the phase-replay
      //          span is stale. Close it at last_seen (best estimate of when the
      //          new name took hold — a precise boundary needs the rename event,
      //          which a pre-trigger rename never recorded) and open the current
      //          name there. A dedicated seed script can refine the boundary.
      const closeOpen = this.db.prepare(
        'UPDATE name_history SET to_ts = ? WHERE fleet_id = ? AND to_ts IS NULL'
      );
      const named = this.db.prepare(
        'SELECT id, friendly_name, registered_at, last_seen FROM agents WHERE friendly_name IS NOT NULL'
      ).all();
      for (const a of named) {
        const open = this.db.prepare(
          'SELECT friendly_name FROM name_history WHERE fleet_id = ? AND to_ts IS NULL ORDER BY from_ts DESC LIMIT 1'
        ).get(a.id);
        if (open && open.friendly_name === a.friendly_name) continue; // (b)
        const boundary = a.last_seen || a.registered_at || new Date(0).toISOString();
        if (open) closeOpen.run(boundary, a.id);                      // (c) close stale
        const from = open ? boundary : (a.registered_at || new Date(0).toISOString());
        insert.run(a.id, a.friendly_name, from, null);               // (a)/(c) open current
        seeded.add(a.id);
        spans++;
      }
    })();
    if (spans > 0) console.log(`[fleet-store] name_history backfill: ${spans} spans across ${seeded.size} agents`);
  }

  findAgent(query) {
    if (!query) return null;

    // A name is an opaque atom — resolved exact-match, never parsed. `chief:day`
    // is one whole friendly_name, not a lineage:phase lookup. "Phase" is a
    // Todd-owned naming convention the server never interprets.
    let row = this._getAgent.get(query);
    if (!row) {
      // Name lookup. A living name has exactly one holder — the partial unique
      // index idx_agents_live_name (friendly_name WHERE dead = 0) makes a second
      // one unrepresentable — so there is nothing to disambiguate and liveness
      // never enters the question. Falls back to any row (incl. dead) only when
      // no living agent holds the name, so reanimate-by-name still resolves
      // (Skip's spec G.22, scratch/registration-rules.md).
      row = this._getLiveAgentRowByFriendlyName.get(query) || this._getAgentByName.get(query);
    }
    return row ? this.projectAgentDaemonRoute(this._hydrateAgent(row)) : null;
  }

  findAgentStored(query) {
    if (!query) return null;
    let row = this._getAgent.get(query);
    if (!row) {
      row = this._getLiveAgentRowByFriendlyName.get(query) || this._getAgentByName.get(query);
    }
    return row ? this._hydrateAgent(row) : null;
  }

  getAllAgents() {
    this._ensureAgentRegistryLoaded();
    // Maintained roster view. Startup/reconciliation may reload the registry
    // from SQLite, but hot callers (store-agents, fleet-table, WS init,
    // broadcastState paths) should never rebuild the whole roster from SQL.
    // Treat the returned agent objects as read-only.
    return this._agentRosterView?.list || [];
  }

  getAgentSummary() {
    const totals = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN dead = 0 THEN 1 ELSE 0 END) AS live,
        SUM(CASE WHEN dead = 1 THEN 1 ELSE 0 END) AS dead
      FROM agents
    `).get() || {};
    const byMachine = {};
    for (const row of this.db.prepare(`
      SELECT COALESCE(d.machine_id, '(none)') AS machine_id, COUNT(*) AS count
      FROM agents a
      LEFT JOIN agent_daemon_routes r ON r.agent_id = a.id
      LEFT JOIN daemon_registry d ON d.daemon_key = r.daemon_key
      WHERE a.dead = 0
      GROUP BY COALESCE(d.machine_id, '(none)')
    `).all()) {
      byMachine[row.machine_id] = row.count;
    }
    return {
      total: totals.total || 0,
      live: totals.live || 0,
      dead: totals.dead || 0,
      byMachine,
      agents: [],
    };
  }

  // Plain { id: friendly_name } map for labeling chat history. The hot
  // chat-history callers only need display names, so this avoids pulling and
  // hydrating the full ~1300-row roster (the remaining `agents ORDER BY
  // last_seen` slow query). Cached 1s, busted by the same structural hook.
  // Returns the cached object directly — callers must not mutate it (spread
  // it first if they need to add keys).
  getAgentNameMap() {
    const TTL_MS = 1000;
    const now = Date.now();
    if (this._nameMapCache && (now - this._nameMapCacheTs) < TTL_MS) {
      return this._nameMapCache;
    }
    const map = {};
    for (const r of this._getAgentNames.all()) map[r.id] = r.friendly_name || r.id;
    this._nameMapCache = map;
    this._nameMapCacheTs = now;
    return map;
  }

  // Force the next getAgentNameMap() to rebuild. Agent roster membership/order is
  // maintained by _syncAgentRegistry(id) and _reloadAgentRegistry().
  _bustAgentsCache() {
    this._nameMapCacheTs = 0;
  }

  // Single gate for naming/labeling. Returns [] if all `names` are available.
  //
  // Rules (DNF chat routing treats friendly_names and labels equivalently):
  //   1. No name may equal a pseudo-label (awake/hibernating/human/human-away)
  //      — would silently shadow the routing category.
  //   2. No name may equal another live agent's durable id or friendly_name — would fan out
  //      every message addressed to that name across both agents.
  //   3. If `asFriendlyName`, additionally: no name may equal another live
  //      agent's label — friendly_name=X with someone else's label=X has the
  //      same fan-out problem. (When setting labels, repetition across agents
  //      is allowed; group tags are intentional.)
  //
  // `excludeId` is the agent the names are being assigned to; it's exempt
  // from the friendly_name and label collision checks.
  checkNameAvailable(names, { excludeId = null, asFriendlyName = false } = {}) {
    const collisions = [];
    const rows = this.db.prepare(
      'SELECT id, friendly_name, labels FROM agents WHERE dead = 0 AND id != ?'
    ).all(excludeId || '');
    const ids = new Set();
    const nameToId = new Map();
    const labelToIds = new Map();
    for (const r of rows) {
      ids.add(r.id);
      if (r.friendly_name) nameToId.set(r.friendly_name, r.id);
      if (r.labels) {
        let parsed;
        try { parsed = JSON.parse(r.labels); } catch { continue; }
        if (Array.isArray(parsed)) {
          for (const l of parsed) {
            if (!labelToIds.has(l)) labelToIds.set(l, []);
            labelToIds.get(l).push(r.id);
          }
        }
      }
    }
    for (const name of names) {
      if (!name || typeof name !== 'string') continue;
      if (PSEUDO_LABELS.includes(name)) {
        collisions.push({ name, kind: 'pseudo_label' });
        continue;
      }
      if (ids.has(name)) {
        collisions.push({ name, kind: 'agent_id', agent_id: name });
      }
      const owner = nameToId.get(name);
      if (owner) {
        collisions.push({ name, kind: 'friendly_name', agent_id: owner });
      }
      if (asFriendlyName) {
        const labelHolders = labelToIds.get(name);
        if (labelHolders?.length) {
          for (const id of labelHolders) collisions.push({ name, kind: 'label', agent_id: id });
        }
      }
    }
    return collisions;
  }

  _friendlyNameUnavailableLower({ excludeId = null, asFriendlyName = false } = {}) {
    const unavailable = new Set(PSEUDO_LABELS.map(name => String(name).toLowerCase()));
    const rows = this.db.prepare(
      'SELECT id, friendly_name, labels FROM agents WHERE dead = 0 AND id != ?'
    ).all(excludeId || '');
    for (const r of rows) {
      if (r.id) unavailable.add(String(r.id).toLowerCase());
      if (r.friendly_name) unavailable.add(String(r.friendly_name).toLowerCase());
      if (asFriendlyName && r.labels) {
        let parsed;
        try { parsed = JSON.parse(r.labels); } catch { continue; }
        if (Array.isArray(parsed)) {
          for (const label of parsed) {
            if (label) unavailable.add(String(label).toLowerCase());
          }
        }
      }
    }
    return unavailable;
  }

  allocateFreshFriendlyName(requestedName, { excludeId = null } = {}) {
    if (!requestedName || typeof requestedName !== 'string') return null;
    const requested = requestedName.trim();
    if (!requested) return null;
    const lowerRequested = requested.toLowerCase();
    if (PSEUDO_LABELS.includes(lowerRequested)) {
      throw new Error(`Name "${requested}" unavailable: reserved routing label`);
    }

    const unavailable = this._friendlyNameUnavailableLower({ excludeId, asFriendlyName: true });
    if (!unavailable.has(lowerRequested)) return requested;

    const first = requested[0];
    const rest = requested.slice(1);
    if (/^[A-Za-z]$/.test(first)) {
      const isUpper = first >= 'A' && first <= 'Z';
      const base = isUpper ? 'A'.charCodeAt(0) : 'a'.charCodeAt(0);
      const code = first.charCodeAt(0);
      for (let next = code - 1; next >= base; next--) {
        const candidate = `${String.fromCharCode(next)}${rest}`;
        if (!unavailable.has(candidate.toLowerCase())) return candidate;
      }
    }

    for (let i = 2; i < 10000; i++) {
      const candidate = `${requested}-${i}`;
      if (!unavailable.has(candidate.toLowerCase())) return candidate;
    }
    throw new Error(`No available friendly-name variant for "${requested}"`);
  }

  getAliveAgents() {
    this._ensureAgentRegistryLoaded();
    // Highest-frequency roster read (store-agents / agents panel /
    // broadcastState). Serve the maintained alive view instead of re-querying
    // and re-hydrating the full live set under churn.
    return this._aliveAgentRosterView?.list || [];
  }

  getAgentsByIds(ids = []) {
    const unique = [...new Set((ids || []).filter(Boolean).map(String))];
    if (!unique.length) return [];
    const placeholders = unique.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT agents.*, lineages.friendly_name AS lineage_name
      FROM agents LEFT JOIN lineages ON lineages.id = agents.lineage_id
      WHERE agents.id IN (${placeholders})
    `).all(...unique);
    return rows.map(row => this.projectAgentDaemonRoute(this._hydrateAgent(row)));
  }

  getLiveAgentsByFriendlyName(friendlyName) {
    if (!friendlyName) return [];
    return this._getLiveAgentsByFriendlyName.all(String(friendlyName)).map(row => this.projectAgentDaemonRoute(this._hydrateAgent(row)));
  }

  // The live human holding this name, or null. Deliberately NOT
  // getLiveAgentsByFriendlyName filtered by `human`: that one applies
  // projectAgentDaemonRoute, which rewrites route/display fields when an agent
  // has a daemon route, and the login path this serves writes the row straight
  // back through upsertAgent. Hydrated but unprojected is what that write
  // needs. At most one row can exist — idx_agents_live_name makes a second
  // live holder of a name unrepresentable.
  getLiveHumanByFriendlyName(friendlyName) {
    if (!friendlyName) return null;
    const row = this._getLiveHumanByFriendlyName.get(String(friendlyName));
    return row ? this._hydrateAgent(row) : null;
  }

  // Is this live name held by somebody other than `excludeId`? Narrower than
  // checkNameAvailable on purpose: that gate also rejects pseudo-labels and
  // names colliding with another agent's label, and the rename path this
  // serves has never rejected either. Widening it is a product change.
  nameTakenByOther(friendlyName, excludeId) {
    if (!friendlyName) return false;
    return !!this._nameTakenByOther.get(String(friendlyName), excludeId || '');
  }

  getAliveAgentsPage({ limit = 100, cursor = null } = {}) {
    const size = Math.max(1, Math.min(Number(limit) || 100, 200));
    let boundary = { lastSeen: '9999-12-31T23:59:59.999Z', id: '\uffff' };
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (typeof decoded.lastSeen !== 'string' || typeof decoded.id !== 'string') throw new Error('bad cursor');
        boundary = decoded;
      } catch {
        const error = new Error('invalid agents cursor');
        error.code = 'INVALID_CURSOR';
        throw error;
      }
    }
    const rows = this._getAliveAgentsPage.all({ ...boundary, limit: size + 1 });
    const hasMore = rows.length > size;
    const page = rows.slice(0, size).map(row => this.projectAgentDaemonRoute(this._hydrateAgent(row)));
    const tail = page[page.length - 1];
    const nextCursor = hasMore && tail
      ? Buffer.from(JSON.stringify({ lastSeen: tail.last_seen, id: tail.id })).toString('base64url')
      : null;
    return { agents: page, nextCursor };
  }

  // The agents panel materializes this roster in pages, but its footer is an
  // aggregate over the whole non-dead roster.  Keep that distinction explicit:
  // callers must not derive footer counts from a page or virtualized rows.
  // Counting is a JOIN, and the two sides of it live on different threads.
  // Roster membership is here; which agents have positive daemon/process
  // evidence is on the main thread. So one side has to cross.
  //
  // Shipping the roster OUT to be counted was measured and rejected: p99
  // 63/75/120 ms at 1000/5000/9000 rows, on every agents-delta broadcast, which
  // costs more than the freeze the worker was moved to remove. Maintaining an
  // awake set incrementally on the main thread was rejected too — agent-row and
  // seat changes have no hook, so it needs an invalidation map that is complete,
  // and an incomplete one yields a count that is WRONG rather than stale.
  //
  // So the two small main-thread facts come IN, and the join happens here. A
  // few dozen flat strings each way; the answer is three numbers.
  //
  // THESE ARE PARAMETERS. THEY ARE NOT STORED.
  //
  // Nothing on this instance remembers liveEvidenceIds after this call returns,
  // and nothing else may read them. That is deliberate
  // and it is the condition on which this design was accepted: a retained copy
  // of live state is the thing that goes stale and reaps working agents, and a
  // set sitting on the store as a field would look authoritative enough that the
  // next reader routes off it. The store is TOLD who is alive for the duration
  // of one computation; it never decides, and it never remembers.
  //
  // This recomputes the same predicate the roster-wide version computed, from
  // the same inputs — it is not a cache and not an approximation. `human` vs
  // `human-away` is derived from last_seen against nowMs on EVERY call, which is
  // why no timer is needed to keep the count honest as a human goes idle.
  getAliveAgentCounts({ liveEvidenceIds = [], nowMs = Date.now() } = {}) {
    this._ensureAgentRegistryLoaded();
    const alive = liveEvidenceIds instanceof Set ? liveEvidenceIds : new Set(liveEvidenceIds);
    const totals = { awake: 0, hibernating: 0, total: 0 };
    for (const agent of this._aliveAgentRosterView.list) {
      totals.total += 1;
      if (this._countsAsAwake(agent, alive, nowMs)) totals.awake += 1;
      else totals.hibernating += 1;
    }
    return totals;
  }

  // fleetRosterCategory(agent) === 'awake', with the projection inlined against
  // the row's own fields. Mirrors projectAgentRuntimeStatus branch for branch:
  // dead, then human by heartbeat recency, then shell, then positive evidence
  // from the daemon. Anything else is hibernating.
  //
  // Note what this does NOT consult: agent.runtime_status. It computes from
  // dead / human / last_seen / evidence directly, so the `unknown` that
  // runtimeStatusForAgent now returns for an unstamped row can never reach the
  // count and be silently bucketed as hibernating. That was the fabrication
  // coming back through a different door, and this shape is immune to it by
  // construction rather than by a check.
  //
  // The shell branch is kept although isFleetRosterAgent already excludes shells
  // from the roster this iterates. It costs one property read, and it keeps this
  // predicate a faithful mirror of the projection rather than something that is
  // only correct given a filter applied somewhere else.
  _countsAsAwake(agent, aliveIds, nowMs) {
    if (!agent || agent.dead) return false;
    if (agent.human) {
      if (!agent.last_seen) return false;
      return (nowMs - new Date(agent.last_seen).getTime()) < HUMAN_HEARTBEAT_TTL_MS;
    }
    if (agent.metadata?.shell) return false;
    return aliveIds.has(agent.id);
  }

  removeAgent(id) {
    this.retireTasksForGoneAgent(id, 'agent row deleted');
    this._deleteAgent.run(id);
    this._bustAgentsCache();
    this._syncAgentRegistry(id);
  }

  /**
   * An agent's open tasks die when the agent does.
   *
   * Called from the two places an agent stops existing — markDead() and
   * removeAgent(). Without this, every death leaves its tasks open forever and
   * the active-task list grows without bound; 851 rows had accumulated by
   * 2026-07-26, 688 of them on agents that were dead or whose row was gone.
   */
  retireTasksForGoneAgent(id, why) {
    const open = this.getActiveTasksByAgent(id);
    const retired = [];
    for (const task of open) {
      const result = this.retireTask(task, { reason: `${why} — task closed with its agent`, retiredBy: 'system' });
      if (result) retired.push(result.task_id);
    }
    return retired;
  }

  updateHeartbeat(id) {
    const _t0 = Date.now();
    this._updateAgentLastSeen.run(new Date().toISOString(), id);
    this._syncAgentRegistry(id);
    const _dt = Date.now() - _t0; if (_dt > 100) process.stderr.write(`[hb-slow] ${_dt}ms id=${id}\n`);
  }

  /**
   * Did this agent ever actually run?
   *
   * Skip's rule: nothing kills an agent except a manual operation — with one
   * carve-out he named, which is the whole reason this predicate exists:
   *
   *   "if an agent never exists, and we [made] a binding for them, and then we
   *    fail to actually have a process ever, then we can release the name."
   *
   * A reservation that never became a process was never an agent, so releasing
   * it is not a death. Anything that HAS run stays, however lost we are about
   * where it sits — a missing seat, an unreachable process and a silent socket
   * are all things to recover from, never grounds to kill.
   *
   * Evidence of having run is anything only a live process can produce: a
   * harness session or resume handle, or activity after registration. Note that
   * `last_seen` alone is NOT evidence — registration itself stamps it, so a seat
   * reservation that never launched still carries one.
   */
  hasEverRun(id) {
    const row = this._getAgent.get(id);
    if (!row) return false;
    if (row.last_active) return true;
    const ev = this.db.prepare(
      'SELECT 1 FROM events WHERE from_id = ? OR agent_id = ? LIMIT 1'
    ).get(id, id);
    return !!ev;
  }

  markDead(id) {
    this.db.transaction(() => {
      this._deleteAgentDaemonRoute.run(id);
      this._markAgentDead.run(id);
    })();
    this.retireTasksForGoneAgent(id, 'agent marked dead');
    this._bustAgentsCache();
    this._syncAgentRegistry(id);
  }

  markAlive(id) {
    const agent = this.getAgent(id);
    if (!agent) throw new Error('agent not found');
    if (agent.human) throw new Error('cannot reanimate a human');
    if (!agent.dead) return agent;
    const liveNamesakes = agent.friendly_name
      ? this._getLiveAgentsByFriendlyName.all(agent.friendly_name)
      : [];
    const holder = liveNamesakes.find(row => row.id !== id);
    if (holder) {
      throw new Error(`cannot reanimate ${id}: live agent ${holder.id} already holds name "${agent.friendly_name}"`);
    }
    this.db.transaction(() => {
      this._markAgentAlive.run(id);
    })();
    this._bustAgentsCache();
    this._syncAgentRegistry(id);
    return this.getAgent(id);
  }

  async renameAgentFriendlyName(id, friendlyName, { actorId = null, reason = 'rename', prettyName = undefined } = {}) {
    const agent = this._getAgent.get(id);
    if (!agent) throw new Error('agent not found');
    const oldName = agent.friendly_name || null;
    const newName = friendlyName || null;
    this.db.transaction(() => {
      this.db.prepare('UPDATE agents SET friendly_name = ?, pretty_name = ? WHERE id = ?')
        .run(newName, prettyName === undefined ? null : serializePrettyName(prettyName), id);
      this._bustAgentsCache();
      this._syncAgentRegistry(id);
    })();
    await this.lifecycle('rename', id, `${oldName || id} -> ${newName || '(unnamed)'}`, {
      actorId,
      reason,
      oldName,
      newName,
    });
    return this.getAgent(id);
  }

  updateAgentStatus(id, state, tool, ts) {
    // Store status in metadata JSON blob — no schema migration needed
    const row = this._getAgent.get(id);
    if (!row) return;
    let metadata;
    try { metadata = row.metadata ? JSON.parse(row.metadata) : {}; } catch (e) { console.warn(`[fleet-store] corrupt metadata JSON for agent ${id}, resetting: ${e.message}`); metadata = {}; }
    if (typeof metadata !== 'object' || metadata === null) metadata = {};
    metadata.status = { state, tool: tool || null, ts: ts || new Date().toISOString() };
    this.db.prepare('UPDATE agents SET metadata = ?, last_seen = ? WHERE id = ?')
      .run(JSON.stringify(metadata), new Date().toISOString(), id);
    this._syncAgentRegistry(id);
  }

  updateAgentMeta(id, patch) {
    // Merge patch into agent metadata JSON blob — no schema migration needed
    const row = this._getAgent.get(id);
    if (!row) return;
    let metadata;
    try { metadata = row.metadata ? JSON.parse(row.metadata) : {}; } catch (e) { console.warn(`[fleet-store] corrupt metadata JSON for agent ${id}, resetting: ${e.message}`); metadata = {}; }
    if (typeof metadata !== 'object' || metadata === null) metadata = {};
    Object.assign(metadata, patch);
    this.db.prepare('UPDATE agents SET metadata = ? WHERE id = ?')
      .run(JSON.stringify(metadata), id);
    this._syncAgentRegistry(id);
  }

  updateAgentActivityHealth(id, health) {
    const row = this._getAgent.get(id);
    if (!row) return null;
    let metadata;
    try { metadata = row.metadata ? JSON.parse(row.metadata) : {}; } catch (e) { console.warn(`[fleet-store] corrupt metadata JSON for agent ${id}, resetting: ${e.message}`); metadata = {}; }
    if (typeof metadata !== 'object' || metadata === null) metadata = {};
    const previous = metadata.activityHealth || null;
    metadata.activityHealth = health;
    this.db.prepare('UPDATE agents SET metadata = ? WHERE id = ?')
      .run(JSON.stringify(metadata), id);
    this._syncAgentRegistry(id);
    return { agent: this.getAgent(id), previous };
  }

  updateAgentActivityHealthIncidents(id, incidents) {
    const row = this._getAgent.get(id);
    if (!row) return null;
    let metadata;
    try { metadata = row.metadata ? JSON.parse(row.metadata) : {}; } catch (e) { console.warn(`[fleet-store] corrupt metadata JSON for agent ${id}, resetting: ${e.message}`); metadata = {}; }
    if (typeof metadata !== 'object' || metadata === null) metadata = {};
    metadata.activityHealthIncidents = incidents && typeof incidents === 'object' ? incidents : {};
    this.db.prepare('UPDATE agents SET metadata = ? WHERE id = ?')
      .run(JSON.stringify(metadata), id);
    this._syncAgentRegistry(id);
    return this.getAgent(id);
  }


  refreshAgentLiveness(id) {
    this._syncAgentRegistry(id);
  }

  // ---- Lineage management ----

  getOrCreateLineage(friendlyName) {
    let row = this.db.prepare('SELECT * FROM lineages WHERE friendly_name = ?').get(friendlyName);
    if (row) {
      row.labels = row.labels ? JSON.parse(row.labels) : [];
      return row;
    }
    const id = 'lineage:' + crypto.randomUUID().slice(0, 8);
    this.db.prepare('INSERT INTO lineages (id, friendly_name, labels, created_at) VALUES (?, ?, ?, ?)')
      .run(id, friendlyName, '[]', Date.now());
    return { id, friendly_name: friendlyName, labels: [], created_at: Date.now() };
  }

  getLineage(idOrName) {
    let row = this.db.prepare('SELECT * FROM lineages WHERE id = ? OR friendly_name = ?').get(idOrName, idOrName);
    if (!row) return null;
    row.labels = row.labels ? JSON.parse(row.labels) : [];
    return row;
  }

  // Current named roster. Stack position is returned as data; names remain
  // opaque atoms and are never interpreted by the store.
  getLineageRoster(lineageId) {
    return this.db.prepare(
      `SELECT agents.*, lineages.friendly_name AS lineage_name, stack.stack_index
       FROM lineage_stack_entries stack
       JOIN agents ON agents.id = stack.fleet_id
       LEFT JOIN lineages ON lineages.id = stack.lineage_id
       WHERE stack.lineage_id = ? AND stack.active = 1
         AND agents.friendly_name IS NOT NULL AND agents.dead = 0
       ORDER BY stack.stack_index`
    ).all(lineageId).map(r => this.projectAgentDaemonRoute(this._hydrateAgent(r)));
  }

  // The lineage this agent currently occupies a stack slot on, or null.
  getActiveStackEntry(agentId) {
    if (!agentId) return null;
    return this.db.prepare(
      'SELECT lineage_id FROM lineage_stack_entries WHERE fleet_id = ? AND active = 1'
    ).get(agentId) || null;
  }

  // The live active stack (ascending by position) for a lineage.
  _activeStack(lineageId) {
    return this.db.prepare(
      'SELECT fleet_id, stack_index, entered_at FROM lineage_stack_entries WHERE lineage_id = ? AND active = 1 ORDER BY stack_index'
    ).all(lineageId);
  }

  // Apply Todd-computed exact names for a re-seat. Two-phase to dodge the
  // (friendly_name unique) index: null every affected name first (NULLs don't
  // collide), then set each final name (all targets now free) through the
  // event-emitting rename. The server NEVER computes these names — Todd passes
  // them in. Every agent vacating a named slot must be in the list (→ its new
  // name or null) so the name it holds is freed for whoever takes it.
  async _applyNameAssignments(nameAssignments, { actorId = null, reason = 'stack' } = {}) {
    if (!nameAssignments || !nameAssignments.length) return;
    this.db.transaction(() => {
      const clear = this.db.prepare('UPDATE agents SET friendly_name = NULL, pretty_name = NULL WHERE id = ?');
      const setLabels = this.db.prepare('UPDATE agents SET labels = ? WHERE id = ?');
      for (const { fleetId, labels } of nameAssignments) {
        clear.run(fleetId);
        if (labels !== undefined) setLabels.run(JSON.stringify(labels), fleetId);
      }
      this._bustAgentsCache();
    })();
    for (const { fleetId, friendlyName, prettyName } of nameAssignments) {
      await this.renameAgentFriendlyName(fleetId, friendlyName || null, { actorId, reason, prettyName });
    }
  }

  // ---- CP3: the atomic re-seat primitive ----
  // The server stores opaque stack POSITIONS and never derives a name. The caller
  // (Todd) passes `nameAssignments` = [{ fleetId, friendlyName }] it has already
  // computed; those are applied via renameAgentFriendlyName() (each atomic +
  // event-emitting) right after the stack transaction. Every op returns the set
  // of affected ids so the route wrapper does exactly one broadcastState().
  //
  // Position mutations run in a single transaction. To respect the
  // (lineage_id, stack_index) WHERE active=1 unique index, a shifted member's
  // position-tenure is CLOSED and re-opened at its new index (history preserved),
  // processed in an order that always frees the target slot first: descending for
  // a downward push, ascending for an upward pop.

  // Seat `incomingId` at `position` (default top=0), pushing active members at
  // index >= position down by one.
  async adoptIntoLineage({ lineageId, incomingId, position = 0, reason = 'adopt', actorId = null, nameAssignments = [] }) {
    const now = Date.now();
    const affected = new Set();
    this.db.transaction(() => {
      const active = this._activeStack(lineageId);
      const closeOne = this.db.prepare('UPDATE lineage_stack_entries SET active=0, exited_at=? WHERE lineage_id=? AND fleet_id=? AND stack_index=? AND active=1');
      const insert = this.db.prepare("INSERT INTO lineage_stack_entries (lineage_id, fleet_id, stack_index, active, entered_at, entry_reason) VALUES (?, ?, ?, 1, ?, ?)");
      const incomingActive = active.find(a => a.fleet_id === incomingId);
      if (incomingActive) closeOne.run(now, lineageId, incomingId, incomingActive.stack_index);
      const rest = active.filter(a => a.fleet_id !== incomingId);
      const pos = Math.max(0, Math.min(position, rest.length));
      const toShift = rest.filter(a => a.stack_index >= pos).sort((x, y) => y.stack_index - x.stack_index);
      let tick = 0;
      for (const r of toShift) {
        closeOne.run(now, lineageId, r.fleet_id, r.stack_index);
        insert.run(lineageId, r.fleet_id, r.stack_index + 1, now + (++tick), reason);
        affected.add(r.fleet_id);
      }
      insert.run(lineageId, incomingId, pos, now + (++tick), reason);
      affected.add(incomingId);
      this.db.prepare('UPDATE agents SET lineage_id = ? WHERE id = ?').run(lineageId, incomingId);
      this._bustAgentsCache();
    })();
    await this._applyNameAssignments(nameAssignments, { actorId, reason: `stack-${reason}` });
    for (const { fleetId } of nameAssignments) affected.add(fleetId);
    return { lineageId, affected: [...affected] };
  }

  // Seat an existing fleet id at the top of a lineage.
  pushExisting(lineageId, incomingId, nameAssignments = [], opts = {}) {
    return this.adoptIntoLineage({ lineageId, incomingId, position: 0, reason: 'push-existing', nameAssignments, ...opts });
  }

  // Close the top holder and shift everyone below up by one. The popped agent
  // leaves current membership (its history rows remain).
  async pop(lineageId, nameAssignments = [], { reason = 'pop', actorId = null } = {}) {
    const now = Date.now();
    const affected = new Set();
    let popped = null;
    let successor = null;
    this.db.transaction(() => {
      const active = this._activeStack(lineageId);
      if (active.length === 0) return;
      const top = active[0];
      popped = top.fleet_id;
      successor = active[1]?.fleet_id || null;
      const closeOne = this.db.prepare('UPDATE lineage_stack_entries SET active=0, exited_at=? WHERE lineage_id=? AND fleet_id=? AND stack_index=? AND active=1');
      const insert = this.db.prepare("INSERT INTO lineage_stack_entries (lineage_id, fleet_id, stack_index, active, entered_at, entry_reason) VALUES (?, ?, ?, 1, ?, ?)");
      closeOne.run(now, lineageId, top.fleet_id, top.stack_index);
      affected.add(top.fleet_id);
      const rest = active.slice(1).sort((x, y) => x.stack_index - y.stack_index);
      let tick = 0;
      for (const r of rest) {
        closeOne.run(now, lineageId, r.fleet_id, r.stack_index);
        insert.run(lineageId, r.fleet_id, r.stack_index - 1, now + (++tick), reason);
        affected.add(r.fleet_id);
      }
      this.db.prepare('UPDATE agents SET lineage_id = NULL WHERE id = ?').run(top.fleet_id);
      if (successor) this.transferTasks(top.fleet_id, successor);
      this._bustAgentsCache();
    })();
    await this._applyNameAssignments(nameAssignments, { actorId, reason: `stack-${reason}` });
    for (const { fleetId } of nameAssignments) affected.add(fleetId);
    return { lineageId, popped, affected: [...affected] };
  }

  // Replace the exact stack position held by `recipientId` with `incomingId`.
  // The anywhere-op — no shift of other members.
  async swap(recipientId, incomingId, nameAssignments = [], { reason = 'swap', actorId = null } = {}) {
    const now = Date.now();
    const affected = new Set();
    let lineageId = null, idx = null;
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT lineage_id, stack_index FROM lineage_stack_entries WHERE fleet_id = ? AND active = 1').get(recipientId);
      if (!row) throw new Error('swap recipient is not on any active stack');
      lineageId = row.lineage_id; idx = row.stack_index;
      this.db.prepare('UPDATE lineage_stack_entries SET active=0, exited_at=?, replaced_by=? WHERE lineage_id=? AND fleet_id=? AND stack_index=? AND active=1')
        .run(now, incomingId, lineageId, recipientId, idx);
      this.db.prepare("INSERT INTO lineage_stack_entries (lineage_id, fleet_id, stack_index, active, entered_at, entry_reason) VALUES (?, ?, ?, 1, ?, ?)")
        .run(lineageId, incomingId, idx, now, reason);
      this.db.prepare('UPDATE agents SET lineage_id = ? WHERE id = ?').run(lineageId, incomingId);
      this.db.prepare('UPDATE agents SET lineage_id = NULL WHERE id = ?').run(recipientId);
      this._bustAgentsCache();
      affected.add(recipientId); affected.add(incomingId);
    })();
    await this._applyNameAssignments(nameAssignments, { actorId, reason: `stack-${reason}` });
    for (const { fleetId } of nameAssignments) affected.add(fleetId);
    return { lineageId, stackIndex: idx, affected: [...affected] };
  }

  // Current active stack members, top-first, hydrated.
  getStack(lineageId) {
    const rows = this._activeStack(lineageId);
    return rows.map(r => {
      const a = this.getAgent(r.fleet_id);
      return a ? { ...a, stack_index: r.stack_index } : { id: r.fleet_id, stack_index: r.stack_index };
    });
  }

  getLineageHistory(lineageId) {
    return this.db.prepare(
      'SELECT * FROM lineage_stack_entries WHERE lineage_id = ? ORDER BY entered_at'
    ).all(lineageId);
  }

  getLineageFleetIds(lineageId) {
    const rows = this.db.prepare(
      'SELECT DISTINCT fleet_id FROM lineage_stack_entries WHERE lineage_id = ?'
    ).all(lineageId);
    return rows.map(r => r.fleet_id);
  }


  _hydrateAgent(row) {
    const lastActive = row.last_active || null
    const metadata = row.metadata ? JSON.parse(row.metadata) : null
    const baseAgent = {
      ...row,
      labels: row.labels ? JSON.parse(row.labels) : [],
      dead: !!row.dead,
      human: !!row.human,
      is_manager: !!row.is_manager,
      metadata,
      pretty_name: parsePrettyName(row.pretty_name),
      last_active: lastActive,
      lineage_id: row.lineage_id || null,
      // Names are opaque atoms. Stack position is separate lineage data.
      lineage_name: row.lineage_name || null,
      // The seat facts the runtime projection needs, and only those three.
      // Route STATE is not decided here: whether a routable-looking seat is
      // actually reachable depends on which daemons currently hold a socket,
      // which is main-thread knowledge. This thread reports what the route
      // authority says; the main thread applies the daemon check.
      route_present: !!row.route_present,
      route_daemon_key: row.route_daemon_key || null,
    }
    // No runtime_status here. Liveness is a projection over things this thread
    // cannot see — live WebSocket handles, daemon connections, heartbeat
    // evidence — and it used to be stamped on via a closure injected from the
    // main thread. That closure is why the store could not move off the event
    // loop: a function cannot cross a worker boundary, and a worker calling
    // back into the main thread mid-query while the main thread awaits the
    // worker is a deadlock rather than a slow path.
    //
    // The agent row is what this store owns. Whoever holds the liveness
    // evidence stamps runtime_status on the way out — see stampRuntimeStatus in
    // fleet-store-client.mjs, which does it on the main thread where the
    // evidence already lives.
    return baseAgent;
  }

  // ---- Task state management ----

  // Normalize the agent key at the single point where tasks enter the store, so a
  // task keyed by a friendly name cannot exist rather than being compensated for on
  // every read. getTaskByAgent used to carry a read-time fallback that re-queried by
  // friendly_name; that made the bad state representable AND handled forever.
  //
  // Fast path: a `fleet:`-prefixed key is already canonical and costs nothing. Any
  // other value is resolved through findAgent (which handles names and
  // lineage:phase). If it cannot be resolved we keep it verbatim -- an id cannot be
  // invented -- but we say so, because an unresolvable agent key is exactly the
  // state this is meant to prevent and it must not pass silently.
  normalizeTaskAgentKey(agentKey) {
    if (!agentKey || String(agentKey).startsWith('fleet:')) return agentKey;
    const resolved = this.findAgent(agentKey);
    if (resolved?.id) return resolved.id;
    console.warn(`[tasks] unresolvable agent key kept verbatim: ${String(agentKey).slice(0, 80)}`);
    return agentKey;
  }

  upsertTask(task) {
    const existing = task.id ? this.getTask(task.id) : null;
    const updatedAt = existing
      ? (task.updated_at && task.updated_at !== existing.updated_at ? task.updated_at : new Date().toISOString())
      : (task.updated_at || task.completed_at || task.last_checked || task.delegated_at || new Date().toISOString());
    this._upsertTask.run(
      task.id,
      this.normalizeTaskAgentKey(task.agent),
      task.description || null,
      task.message || null,
      task.delegated_by || null,
      task.delegated_at || null,
      task.status || 'pending',
      task.acknowledged ? 1 : 0,
      task.completed_at || null,
      task.last_checked || null,
      updatedAt,
      task.blockedBy ? JSON.stringify(task.blockedBy) : null,
      task.success_criteria ? JSON.stringify(task.success_criteria) : null,
      task.reported ? 1 : 0,
      task.synthetic ? 1 : 0,
      task.metadata ? JSON.stringify(task.metadata) : null
    );
    this._queueTaskDocChange({ type: 'update', task, actor: task.agent });
    this._queueTaskDelta({ type: 'upsert', task: this.getTask(task.id) });
  }

  getTask(id) {
    const row = this._getTask.get(id);
    return row ? this._hydrateTask(row) : null;
  }

  getTaskByAgent(agentId) {
    const rows = this.getActiveTasksByAgent(agentId);
    return rows.length > 0 ? rows[0] : null;
  }

  getActiveTasksByAgent(agentId) {
    const rows = this._getActiveTasksByAgent.all(agentId).map(r => this._hydrateTask(r));
    return rows.sort((a, b) => {
      const an = a.metadata?.native ? 1 : 0;
      const bn = b.metadata?.native ? 1 : 0;
      if (an !== bn) return bn - an;
      return (Date.parse(b.delegated_at || '') || 0) - (Date.parse(a.delegated_at || '') || 0);
    });
  }

  getActiveTasksByAgentLimited(agentId, limit = 20) {
    const n = Math.max(1, Math.min(Number.parseInt(String(limit), 10) || 20, 100));
    const rows = this._getActiveTasksByAgentLimited.all(agentId, n).map(r => this._hydrateTask(r));
    return rows.sort((a, b) => {
      const an = a.metadata?.native ? 1 : 0;
      const bn = b.metadata?.native ? 1 : 0;
      if (an !== bn) return bn - an;
      return (Date.parse(b.delegated_at || '') || 0) - (Date.parse(a.delegated_at || '') || 0);
    });
  }

  getActiveTaskCountByAgent(agentId) {
    return this._getActiveTaskCountByAgent.get(agentId).c;
  }

  isDelegatorForAgent(delegatorId, agentId) {
    if (!delegatorId || !agentId) return false;
    return this.getActiveTasksByAgent(agentId).some(task => task.delegated_by === delegatorId);
  }

  getActiveTasks() {
    return this._getAllActiveTasks.all().map(r => this._hydrateTask(r));
  }

  getActiveTaskCount() {
    return this._getActiveTaskCount.get().c;
  }

  getActiveTasksPage({ limit = 100, cursor = null } = {}) {
    const size = Math.max(1, Math.min(Number(limit) || 100, 200));
    let boundary = { delegatedAt: '9999-12-31T23:59:59.999Z', id: '\uffff' };
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (typeof decoded.delegatedAt !== 'string' || typeof decoded.id !== 'string') throw new Error('bad cursor');
        boundary = decoded;
      } catch {
        const error = new Error('invalid tasks cursor');
        error.code = 'INVALID_CURSOR';
        throw error;
      }
    }
    const rows = this._getActiveTasksPage.all({ ...boundary, limit: size + 1 });
    const hasMore = rows.length > size;
    const tasks = rows.slice(0, size).map(r => this._hydrateTask(r));
    const tail = tasks[tasks.length - 1];
    const nextCursor = hasMore && tail
      ? Buffer.from(JSON.stringify({ delegatedAt: tail.delegated_at || '', id: tail.id })).toString('base64url')
      : null;
    return { tasks, nextCursor };
  }

  getAllTasks() {
    return this._getAllTasks.all().map(r => this._hydrateTask(r));
  }

  removeTask(id) {
    const task = this.getTask(id);
    this._deleteTask.run(id);
    this._queueTaskDocChange({ type: 'delete', task, taskId: id, actor: task?.agent });
    this._queueTaskDelta({ type: 'remove', taskId: id });
  }

  _queueTaskDelta(change) {
    if (!change || !this._taskChanges) return;
    if (this._taskChanges.length >= this._maxQueuedTaskChanges) {
      this._taskChangesOverflow = true;
      return;
    }
    this._taskChanges.push(change);
  }

  consumeTaskChanges() {
    const changes = this._taskChanges || [];
    const overflow = !!this._taskChangesOverflow;
    this._taskChanges = [];
    this._taskChangesOverflow = false;
    const changed = [];
    const removed = [];
    for (const change of changes) {
      if (change.type === 'remove') removed.push(change.taskId);
      else if (change.type === 'upsert' && change.task) changed.push(change.task);
    }
    return { changed, removed, overflow };
  }

  getTaskDeliveryState(taskOrId, { recipientExposed = false } = {}) {
    const task = typeof taskOrId === 'string' ? this.getTask(taskOrId) : taskOrId;
    if (!task) return null;
    const eventRow = this._getDelegateEventForTask.get(task.id);
    const event = eventRow
      ? { ...eventRow, metadata: eventRow.metadata ? JSON.parse(eventRow.metadata) : null }
      : null;
    const unread = event ? this._getUnreadForEvent.get(event.id, task.agent) : null;
    const read = unread ? !!unread.read : false;
    const hasUnread = !!unread;
    return {
      task,
      event,
      unread,
      unreadPending: hasUnread && !read,
      exposed: !!recipientExposed || read || (event ? !hasUnread : false),
    };
  }

  retractTask(taskOrId, { recipientExposed = false, retractedBy = null } = {}) {
    const state = this.getTaskDeliveryState(taskOrId, { recipientExposed });
    if (!state) return null;
    const { task, event, unreadPending, exposed } = state;
    const retractedAt = new Date().toISOString();

    if (!exposed) {
      if (event && unreadPending) this._deleteUnreadForEvent.run(event.id, task.agent);
      if (event) {
        this.updateEventMetadata(event.id, {
          retracted: true,
          retracted_at: retractedAt,
          retracted_by: retractedBy,
          retracted_before_delivery: true,
        });
      }
      this.removeTask(task.id);
      return {
        task_id: task.id,
        mode: 'removed_unread',
        event_id: event?.id || null,
        unread_removed: !!(event && unreadPending),
        exposed: false,
      };
    }

    const metadata = {
      ...(task.metadata || {}),
      retracted: true,
      retracted_at: retractedAt,
      retracted_by: retractedBy,
      retracted_after_delivery: true,
    };
    this.upsertTask({
      ...task,
      status: 'retracted',
      completed_at: task.completed_at || retractedAt,
      metadata,
    });
    if (event) {
      this.updateEventMetadata(event.id, {
        retracted: true,
        retracted_at: retractedAt,
        retracted_by: retractedBy,
        retracted_after_delivery: true,
      });
    }
    return {
      task_id: task.id,
      mode: 'marked_retracted',
      event_id: event?.id || null,
      unread_removed: false,
      exposed: true,
    };
  }

  /**
   * Administratively close a task that nobody is going to do, recording WHY on
   * the row itself.
   *
   * Distinct from retractTask(): a retract un-sends a task the recipient never
   * saw, so it may remove the row. A retire is for a task that was delivered and
   * has simply outlived its agent — the row stays, carrying the reason, so a
   * bulk close is auditable afterwards. It writes no report document, sends no
   * chat, and wakes nobody.
   *
   * The unread delegate row is cleared too: `status='retracted'` already stops
   * decideTaskRenudges (isRenudgeableTaskStatus excludes it), but leaving the
   * unread behind would keep the item in the agent's inbox forever.
   */
  retireTask(taskOrId, { reason, retiredBy = null, at = new Date().toISOString() } = {}) {
    if (!reason) throw new Error('retireTask requires a reason');
    const task = typeof taskOrId === 'string' ? this.getTask(taskOrId) : taskOrId;
    if (!task) return null;
    if (task.status === 'done' || task.status === 'retracted') return null;

    const state = this.getTaskDeliveryState(task);
    const event = state?.event || null;
    this.db.transaction(() => {
      if (event && state.unread) this._deleteUnreadForEvent.run(event.id, task.agent);
      this.upsertTask({
        ...task,
        status: 'retracted',
        completed_at: task.completed_at || at,
        metadata: {
          ...(task.metadata || {}),
          retired: { reason, by: retiredBy, at },
        },
      });
    })();

    return { task_id: task.id, agent: task.agent, reason, retired_by: retiredBy, retired_at: at };
  }

  /**
   * Retire many tasks as ONE transaction.
   *
   * better-sqlite3 is synchronous, so a bulk retire blocks the server's event
   * loop for its whole duration — the same shape as the task-doc materializer's
   * old synchronous git wait that Skip felt as the app locking up. Measured on
   * this store: 500 retires cost 1113ms as individual transactions and 354ms as
   * one (3.1x), because the per-task version pays 500 commits instead of one.
   *
   * Callers should still send modest batches: one transaction makes each write
   * cheaper, it does not yield between them.
   */
  retireTasks(ids, { reason, retiredBy = null } = {}) {
    if (!reason) throw new Error('retireTasks requires a reason');
    const retired = [];
    const skipped = [];
    const at = new Date().toISOString();
    this.db.transaction(() => {
      for (const id of ids) {
        const task = this.getTask(id);
        if (!task) { skipped.push({ task_id: id, why: 'not found' }); continue; }
        if (task.status === 'done' || task.status === 'retracted') {
          skipped.push({ task_id: id, why: `already ${task.status}` });
          continue;
        }
        const result = this.retireTask(task, { reason, retiredBy, at });
        if (result) retired.push(result);
        else skipped.push({ task_id: id, why: 'not retirable' });
      }
    })();
    return { retired, skipped };
  }

  _hydrateTask(row) {
    return {
      ...row,
      blockedBy: row.blocked_by ? JSON.parse(row.blocked_by) : undefined,
      success_criteria: row.success_criteria ? JSON.parse(row.success_criteria) : undefined,
      acknowledged: !!row.acknowledged,
      reported: !!row.reported,
      synthetic: !!row.synthetic,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
    };
  }

  _queueTaskDocChange(change) {
    this._taskDocMaterializer?.queue(change);
  }

  flushTaskDocs() {
    return this._taskDocMaterializer?.flushNow();
  }

  // ---- Shared doc management ----

  upsertSharedDoc(doc) {
    const now = new Date().toISOString();
    this._upsertSharedDoc.run(
      doc.doc,
      doc.path || null,
      doc.title || null,
      doc.agent || null,
      doc.ephemeral ? 1 : 0,
      doc.shared_at || now,
      doc.updated_at || now
    );
  }

  // Rows as stored, with `ephemeral` still 0/1. The hydrator that turned it
  // into a boolean was only ever reachable from here, and both live readers
  // (the shared-docs-get socket verb and GET /api/shared-docs) put these rows
  // straight on the wire — hydrating would change a client-visible payload
  // from 0/1 to false/true, which nobody asked for.
  getSharedDocs() {
    return this._getAllSharedDocs.all();
  }

  getSharedDoc(name) {
    return this._getSharedDoc.get(name) || null;
  }

  // ---- Wiretap management ----

  addWiretap(agentId, filter, types) {
    // Filter is a string EXPRESSION (same grammar as chat/roster), with
    // directional `to:`/`from:` leaf prefixes — see evalExprDirectional.
    // parseFilter throws on malformed input so a typo'd tap fails loud.
    if (typeof filter !== 'string' || !filter.trim()) throw new Error('filter must be a non-empty string expression');
    parseFilter(filter); // validate — throws "filter parse error: …" on bad syntax
    if (types != null && !Array.isArray(types)) throw new Error('types must be an array');
    const validTypes = types && types.length > 0 ? types : null;
    const info = this._addWiretap.run(agentId, JSON.stringify(filter), validTypes ? JSON.stringify(validTypes) : null);
    this._wiretapCache = null;
    return { id: info.lastInsertRowid, agent_id: agentId, filter, types: validTypes };
  }

  getWiretaps() {
    if (!this._wiretapCache) {
      this._wiretapCache = this._getWiretaps.all().map(r => this._hydrateWiretap(r));
    }
    return this._wiretapCache;
  }

  getWiretapsByAgent(agentId) {
    return this._getWiretapsByAgent.all(agentId).map(r => this._hydrateWiretap(r));
  }

  removeWiretap(id) {
    this._deleteWiretap.run(id);
    this._wiretapCache = null;
  }

  removeWiretapsByAgent(agentId) {
    this._deleteWiretapsByAgent.run(agentId);
    this._wiretapCache = null;
  }

  addSubscription({ owner, query, notificationPolicy, createdBy, adapter, adapterId = null }) {
    const info = this._addSubscription.run(owner, query, notificationPolicy, new Date().toISOString(), createdBy, adapter, adapterId);
    return this.getSubscription(info.lastInsertRowid);
  }

  getSubscription(subscriptionId) {
    return this._getSubscription.get(subscriptionId) || null;
  }

  getSubscriptionsByOwner(owner) {
    return this._getSubscriptionsByOwner.all(owner);
  }

  getSubscriptionsByAdapter(adapter) {
    return this._getSubscriptionsByAdapter.all(adapter);
  }

  _upgradeLegacyDefaultSubscriptions() {
    const legacyRows = this.db.prepare(`
      SELECT subscription_id, owner, adapter_id
      FROM subscriptions
      WHERE query = 'to:my_labels'
        AND adapter = 'wiretap'
        AND created_by = owner
    `).all();
    let upgraded = 0;
    for (const row of legacyRows) {
      const query = `to:${row.owner}`;
      let adapterId = row.adapter_id;
      if (adapterId) {
        this._updateWiretapFilter.run(JSON.stringify(query), adapterId);
      } else {
        adapterId = this.addWiretap(row.owner, query, null).id;
      }
      this._updateSubscriptionQuery.run(query, adapterId, row.subscription_id);
      upgraded++;
    }
    if (upgraded) {
      this._wiretapCache = null;
      console.log(`[fleet-store] upgraded ${upgraded} legacy default subscription(s)`);
    }
  }

  ensureDefaultSubscription(agentId) {
    // A default subscription is the agent's own address, not every label it
    // currently has. In particular, status labels such as `awake` are shared
    // by most agents and turned the old `to:my_labels` default into a wiretap
    // for unrelated traffic.
    const query = `to:${agentId}`;
    const subscriptions = this._getSubscriptionsByOwner.all(agentId);
    const existing = subscriptions.find(row => row.query === query);
    if (existing) return existing;
    const legacy = subscriptions.find(row => row.query === 'to:my_labels' && row.adapter === 'wiretap' && row.created_by === agentId);
    if (legacy) {
      let adapterId = legacy.adapter_id;
      if (adapterId) {
        this._updateWiretapFilter.run(JSON.stringify(query), adapterId);
        this._wiretapCache = null;
      } else {
        adapterId = this.addWiretap(agentId, query, null).id;
      }
      this._updateSubscriptionQuery.run(query, adapterId, legacy.subscription_id);
      return this.getSubscription(legacy.subscription_id);
    }
    const tap = this.addWiretap(agentId, query, null);
    return this.addSubscription({ owner: agentId, query, notificationPolicy: 'immediate', createdBy: agentId, adapter: 'wiretap', adapterId: tap.id });
  }

  removeSubscription(subscriptionId) {
    return this._deleteSubscription.run(subscriptionId).changes > 0;
  }

  // Resolve wiretap matches: given a sender and recipient, return agent IDs that should be CC'd
  // Filter is a string expression with directional `to:`/`from:` prefixes:
  // "to:skip & from:math" fires on a message TO skip FROM math.
  resolveWiretaps(senderId, recipientId, eventType) {
    const taps = this.getWiretaps();
    if (taps.length === 0) return [];
    const matched = new Set();

    // Only the sender's and recipient's labels matter here. Look those two up
    // directly (indexed single-row) instead of hydrating ALL agents — this runs
    // on the main thread on EVERY event, and getAllAgents() over ~1300 agents
    // was ~230ms/event, the dominant per-event main-loop stall.
    const senderLabels = this._agentLabelsById(senderId);
    const recipientLabels = this._agentLabelsById(recipientId);

    for (const tap of taps) {
      if (tap.agent_id === senderId || tap.agent_id === recipientId) continue;
      // Type filter: if wiretap specifies types, skip events that don't match
      if (tap.types && tap.types.length > 0 && eventType && !tap.types.includes(eventType)) continue;
      if (!tap._ast) continue; // unparseable filter (logged at hydrate) — never match-all
      // Directional expression: matches per to:/from: leaf semantics.
      //
      // Only a `my_labels` filter ever reads the subscriber's labels, and
      // producing them means a full getAgent() + _hydrateAgent() — a whole agent
      // record loaded to read a label. Doing that per tap, per event, made this
      // the single largest CPU cost on the server (39% of busy time on live,
      // with ~2000 taps), and it grew with the number of agents that merely
      // exist. `_needsSubscriberLabels` is precomputed once when the tap is
      // hydrated, so filters that don't reference `my_labels` — effectively all
      // of them — now cost no agent load at all.
      const subscriberLabels = tap._needsSubscriberLabels ? this._agentLabelsById(tap.agent_id) : [];
      const matches = evalExprDirectional(tap._ast, { fromLabels: senderLabels, toLabels: recipientLabels, subscriberLabels });
      if (matches) matched.add(tap.agent_id);
    }
    return [...matched];
  }

  // Reads the in-memory agent registry, not the database. `resolveChatRecipients`
  // right above already resolves entirely against these indexes; this path sat
  // next to it and went to SQLite per tap instead — a full getAgent() +
  // _hydrateAgent() per subscription per event. The registry holds fully
  // hydrated agents (alive and dead) and is kept current by _syncAgentRegistry
  // on every agent change, so this adds no second invalidation path: it uses the
  // one that already exists.
  _agentLabelsById(agentId) {
    if (!agentId) return [];
    this._ensureAgentRegistryLoaded();
    const agent = this._agentRegistry.get(agentId);
    if (!agent) return [agentId];
    return labelsForAgent(agent);
  }

  _hydrateWiretap(row) {
    const filter = JSON.parse(row.filter); // stored as a JSON-encoded string expression
    // Precompute the AST once here (getWiretaps runs on every event); a row that
    // somehow fails to parse is logged and left with _ast=null so matchers skip
    // it rather than crashing event routing or matching everything.
    let ast = null;
    try { ast = parseFilter(filter); }
    catch (e) { console.warn(`[fleet-store] wiretap #${row.id} has unparseable filter ${JSON.stringify(filter)}: ${e.message}`); }
    const tap = { ...row, filter, types: row.types ? JSON.parse(row.types) : null };
    // _ast is an internal compiled form — non-enumerable so it never leaks into
    // JSON responses (GET /api/wiretaps, wiretap-list) but stays usable by matchers.
    Object.defineProperty(tap, '_ast', { value: ast, enumerable: false });
    // Precomputed with the AST for the same reason: resolveWiretaps consults it
    // per tap on every event and must not re-walk the tree to find out.
    Object.defineProperty(tap, '_needsSubscriberLabels', { value: astReadsSubscriberLabels(ast), enumerable: false });
    return tap;
  }

  // ---- QA system ----

  // ---- Fleet prefs (per user/fleet ID) ----

  setFleetPref(userId, key, value) {
    this.db.prepare('INSERT OR REPLACE INTO fleet_prefs (user_id, key, value) VALUES (?, ?, ?)').run(userId, key, JSON.stringify(value));
  }

  getFleetPref(userId, key) {
    const row = this.db.prepare('SELECT value FROM fleet_prefs WHERE user_id = ? AND key = ?').get(userId, key);
    return row ? JSON.parse(row.value) : undefined;
  }

  getAllFleetPrefs(userId) {
    const rows = this.db.prepare('SELECT key, value FROM fleet_prefs WHERE user_id = ?').all(userId);
    const out = {};
    for (const r of rows) out[r.key] = JSON.parse(r.value);
    return out;
  }

  setQaConfig(key, value) {
    this._setQaConfig.run(key, value);
  }

  getQaConfig(key) {
    const row = this._getQaConfig.get(key);
    return row ? row.value : null;
  }

  getQaAgentIds() {
    const raw = this.getQaConfig('qa_agent_ids');
    return raw ? JSON.parse(raw) : [];
  }

  setQaAgentIds(ids) {
    this.setQaConfig('qa_agent_ids', JSON.stringify(ids));
  }

  submitQaReport(taskId, agentId, taskType, fields) {
    // Supersede any previous reports for this task
    this._supersedeQaReports.run(taskId);
    const now = new Date().toISOString();
    const result = this._insertQaReport.run(taskId, agentId, taskType, JSON.stringify(fields), now);
    return { id: Number(result.lastInsertRowid), task_id: taskId, agent_id: agentId, task_type: taskType, fields, submitted_at: now };
  }

  getActiveQaReport(taskId) {
    const row = this._getActiveQaReport.get(taskId);
    if (!row) return null;
    return { ...row, fields: JSON.parse(row.fields) };
  }

  signQaReport(taskId, reportId, agentId, verdict, notes) {
    const now = new Date().toISOString();
    this._insertQaSignature.run(taskId, reportId, agentId, verdict, notes || null, now);
    return { task_id: taskId, report_id: reportId, agent_id: agentId, verdict, notes, signed_at: now };
  }

  getQaSignatures(reportId) {
    return this._getQaSignatures.all(reportId);
  }

  getQaSignaturesByTask(taskId) {
    return this._getQaSignaturesByTask.all(taskId);
  }

  getQaStatus(taskId) {
    const report = this.getActiveQaReport(taskId);
    if (!report) return { has_report: false, signatures: [], status: 'no_report' };
    const sigs = this.getQaSignatures(report.id);
    const qaIds = this.getQaAgentIds();
    const rejected = sigs.find(s => s.verdict === 'rejected');
    if (rejected) return { has_report: true, report, signatures: sigs, status: 'rejected', rejected_by: rejected.agent_id, notes: rejected.notes };
    const approvals = sigs.filter(s => s.verdict === 'approved');
    const allSigned = qaIds.length > 0 && qaIds.every(id => approvals.some(s => s.agent_id === id));
    if (allSigned) return { has_report: true, report, signatures: sigs, status: 'approved' };
    return { has_report: true, report, signatures: sigs, status: 'pending', approved_by: approvals.map(s => s.agent_id) };
  }

  // ---- Message/event queries ----


  getUnreadLimited(agentId, limit = 50) {
    const n = Math.max(1, Math.min(Number.parseInt(String(limit), 10) || 50, 200));
    return this._query(this._getUnreadLimited, agentId, n);
  }

  getUnreadCount(agentId) {
    return this._getUnreadCount.get(agentId).c;
  }

  getRecentMessagesTo(agentId, limit = 5) {
    const rows = this._query(this._getRecentMessagesTo, agentId, limit);
    rows.reverse(); // chronological
    return rows;
  }

  // Return agent IDs that used editor tools (Edit/Write/NotebookEdit) on files in
  // `buildFiles` (array of absolute paths) since `since` (ISO timestamp).
  // Used to notify agents who might be responsible for a mirror failure — only agents
  // whose edits postdate the last successful mirror can be at fault.
  recentDocAgents(buildFiles, since) {
    if (!buildFiles?.length || !since) return []
    try {
      const placeholders = buildFiles.map(() => '?').join(',')
      const rows = this.db.prepare(`
        SELECT DISTINCT from_id as id FROM events
        WHERE type = 'activity'
          AND timestamp > ?
          AND text IN ('Edit', 'Write', 'NotebookEdit')
          AND json_extract(metadata, '$.arg') IN (${placeholders})
          AND from_id IS NOT NULL AND from_id != 'fleet:skip'
      `).all(since, ...buildFiles)
      return rows.map(r => r.id)
    } catch {
      return []
    }
  }

  markRead(agentId) {
    // Return event IDs that were marked read (for read-receipt broadcast)
    const ids = this.db.prepare(`SELECT event_id FROM unread WHERE to_id = ? AND read = 0`).all(agentId).map(r => r.event_id);
    this._markRead.run(agentId);
    return ids;
  }

  markEventsRead(agentId, eventIds = []) {
    const ids = [...new Set((eventIds || []).map(id => Number(id)).filter(Number.isFinite))];
    if (!ids.length) return [];
    const markOne = this.db.transaction((rows) => {
      const marked = [];
      for (const eventId of rows) {
        const before = this._getUnreadForEvent.get(eventId, agentId);
        if (!before || before.read) continue;
        this._markEventRead.run(eventId, agentId);
        marked.push(eventId);
      }
      return marked;
    });
    return markOne(ids);
  }

  // Inbox acknowledgement is on the request path. Keep its heartbeat and
  // read-receipt updates in one transaction on the store connection.
  async acknowledgeInboxRead(agentId, eventIds = []) {
    const ids = [...new Set((eventIds || []).map(id => Number(id)).filter(Number.isFinite))];
    const ops = [{ stmtOrSql: this._updateAgentLastSeen, params: [new Date().toISOString(), agentId] }];
    for (const eventId of ids) {
      ops.push({ stmtOrSql: this._markEventRead, params: [eventId, agentId] });
    }
    const results = await this._wBatchAwait(ops);
    this._syncAgentRegistry(agentId);
    return ids.filter((_, index) => results[index + 1]?.changes > 0);
  }

  // Mark a single event as read for one recipient. Used by terminal-card
  // dismissal: clicking X on a terminal_card marks just THAT event read,
  // so it doesn't auto-pop on reload, but other unread chats for the
  // recipient are unaffected.
  markEventRead(eventId, agentId) {
    const result = this._markEventRead.run(eventId, agentId);
    return result.changes > 0;
  }

  markEventUnread(eventId, agentId) {
    this._insertUnread.run(eventId, agentId);
    const result = this.db.prepare('UPDATE unread SET read = 0 WHERE event_id = ? AND to_id = ?').run(eventId, agentId);
    return result.changes > 0;
  }

  claimTimerTerminal(eventId, { to, metadataPatch, unread = false } = {}) {
    const claim = this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE events
        SET metadata = json_patch(COALESCE(metadata, '{}'), ?)
        WHERE id = ?
          AND type = 'timer'
          AND json_extract(COALESCE(metadata, '{}'), '$.pending') = 1
      `).run(JSON.stringify(metadataPatch), eventId);
      if (result.changes === 0) return false;
      if (unread && to) {
        this._insertUnread.run(eventId, to);
        this.db.prepare('UPDATE unread SET read = 0 WHERE event_id = ? AND to_id = ?').run(eventId, to);
      }
      return true;
    });
    return claim();
  }

  updateEventMetadata(eventId, patch) {
    this._updateEventMetadata.run(JSON.stringify(patch), eventId);
  }

  // Overwrite metadata wholesale. NOT updateEventMetadata with a different
  // name: that one merges with json_patch, so a key the caller deliberately
  // dropped would survive, and a null value would delete a key rather than
  // store one. Callers here have already derived the complete object.
  replaceEventMetadata(eventId, metadata) {
    this._replaceEventMetadata.run(JSON.stringify(metadata), eventId);
  }

  replaceEventTextAndMetadata(eventId, newText, metadata) {
    this._replaceEventTextAndMetadata.run(newText, JSON.stringify(metadata), eventId);
  }

  // Has this recipient's copy of the event not been read yet? Absent row and
  // read row are both "nothing pending"; only an existing unread row counts.
  isUnreadPending(eventId, agentId) {
    const row = this._unreadPendingRow.get(eventId, agentId);
    return !!row && !row.read;
  }

  terminalChatDuplicateExists(timestamp, fromId, toId, textPrefix) {
    return !!this._terminalChatDuplicate.get(timestamp, fromId, toId, textPrefix);
  }

  // ---- Server → daemon outbox ----
  // Flat pass-throughs rather than handing the object out: the client is
  // generated from a method manifest, and an object cannot cross the boundary.
  // Only the surface that is actually called is exposed — the ledger's count()
  // and countForDaemon() had no callers and are deleted rather than proxied.

  serverDaemonOutboxEnqueue(daemonKey, message, options) {
    return this._serverDaemonOutbox.enqueue(daemonKey, message, options);
  }

  serverDaemonOutboxPendingForDaemon(daemonKey, limit) {
    return this._serverDaemonOutbox.pendingForDaemon(daemonKey, limit);
  }

  serverDaemonOutboxGet(id) {
    return this._serverDaemonOutbox.get(id);
  }

  serverDaemonOutboxAck(id) {
    this._serverDaemonOutbox.ack(id);
  }

  serverDaemonOutboxMarkAttempt(id) {
    this._serverDaemonOutbox.markAttempt(id);
  }

  // The error crosses as its message. An Error instance is not structured-
  // cloneable in a way that survives usefully, and the ledger only ever stores
  // String(error) anyway.
  serverDaemonOutboxMarkError(id, error) {
    this._serverDaemonOutbox.markError(id, error);
  }

  serverDaemonOutboxDeleteByDedupeKey(daemonKey, dedupeKey) {
    return this._serverDaemonOutbox.deleteByDedupeKey(daemonKey, dedupeKey);
  }

  daemonOutboxWasProcessed(outboxId) {
    return !!this._daemonOutboxProcessedGet.get(outboxId);
  }

  markDaemonOutboxProcessed(outboxId, type, processedAt) {
    this._daemonOutboxProcessedInsert.run(outboxId, type || 'unknown', processedAt);
  }

  updateEventText(eventId, newText) {
    this.db.prepare('UPDATE events SET text = ? WHERE id = ?').run(newText, eventId);
  }

  // Edit a message in place, retaining the prior text in metadata.amend_history
  // (the accountability trail — so an "amend" that's really a new message is visible).
  amendEventText(eventId, newText) {
    const row = this.db.prepare('SELECT text, metadata FROM events WHERE id = ?').get(eventId);
    if (!row) return false;
    let meta = {};
    if (row.metadata) { try { meta = JSON.parse(row.metadata); } catch { meta = {}; } }
    if (!Array.isArray(meta.amend_history)) meta.amend_history = [];
    meta.amend_history.push({ text: row.text, ts: new Date().toISOString() });
    this.db.prepare('UPDATE events SET text = ?, metadata = ? WHERE id = ?')
      .run(newText, JSON.stringify(meta), eventId);
    return true;
  }

  // Most recent chat message authored by `fromId` — the default amend target.
  getLatestChatFrom(fromId) {
    const row = this.db.prepare(
      `SELECT ${this._EVT} FROM events WHERE from_id = ? AND type = 'chat' ORDER BY id DESC LIMIT 1`
    ).get(fromId);
    if (!row) return null;
    const meta = row.metadata ? JSON.parse(row.metadata) : null;
    return { ...row, metadata: meta };
  }

  getEventById(eventId) {
    const row = this.db.prepare(`SELECT ${this._EVT} FROM events WHERE id = ?`).get(eventId);
    if (!row) return null;
    const meta = row.metadata ? JSON.parse(row.metadata) : null;
    return { ...row, from: row.from, to: row.to, metadata: meta };
  }

  listPendingTimerEvents() {
    const rows = this.db.prepare(`
      SELECT ${this._EVT}
      FROM events
      WHERE type = 'timer'
        AND json_extract(COALESCE(metadata, '{}'), '$.pending') = 1
      ORDER BY json_extract(metadata, '$.fire_at') ASC, id ASC
    `).all();
    return rows.map(row => {
      const meta = row.metadata ? JSON.parse(row.metadata) : null;
      return { ...row, from: row.from, to: row.to, metadata: meta };
    });
  }

  // `agents` is the exact set of fleet ids the normal chat history is filtered to.
  // Broad name-history or lineage expansion belongs only in explicit search.
  // `order` is the order rows come back in, done in SQL.
  //
  // The newest rows are always what's wanted, so the inner query is DESC either
  // way — that's what the (col, timestamp DESC) indexes are for. `order` only
  // decides how the already-selected page is sorted on the way out. Doing it
  // here means no caller reverses an array: the subscription's history walker
  // wants newest-first, the panel wants chronological, and both just ask.
  queryChatHistory({ before, agents, limit = 50, order = 'asc' } = {}) {
    const outer = order === 'desc' ? 'DESC' : 'ASC';
    let rows;
    const ids = Array.isArray(agents) ? agents : [];
    if (ids.length > 0) {
      const exactIds = [...new Set(ids)];
      const ph = exactIds.map(() => '?').join(',');
      const typePh = CHAT_HISTORY_EVENT_TYPES.map(() => '?').join(',');
      const E = this._EVT;
      // OR-across-two-columns can't use an index's sort order, so the naive
      // `WHERE from_id IN(…) OR to_id IN(…) ORDER BY ts DESC LIMIT n` makes SQLite
      // materialize + temp-sort EVERY matching row before the limit (125k+ for a
      // high-volume id like fleet:skip) — synchronously freezing the event loop on
      // a hot path. Instead pull n from each column's own (col, timestamp DESC)
      // index in sorted order, then merge: touches ~2n rows, not the whole history.
      // The global top-n by timestamp of (from ∪ to) is always within (top-n of
      // from) ∪ (top-n of to), so the result is identical. UNION (not UNION ALL)
      // dedupes rows where the id is both sender and recipient.
      if (before) {
        const sql = `SELECT * FROM (SELECT * FROM (
            SELECT * FROM (SELECT ${E} FROM events WHERE timestamp < ? AND type IN (${typePh}) AND from_id IN (${ph}) ORDER BY timestamp DESC LIMIT ?)
            UNION
            SELECT * FROM (SELECT ${E} FROM events WHERE timestamp < ? AND type IN (${typePh}) AND to_id IN (${ph}) ORDER BY timestamp DESC LIMIT ?)
          ) ORDER BY timestamp DESC LIMIT ?) ORDER BY timestamp ${outer}`;
        rows = this._query(this.db.prepare(sql),
          before, ...CHAT_HISTORY_EVENT_TYPES, ...exactIds, limit,
          before, ...CHAT_HISTORY_EVENT_TYPES, ...exactIds, limit,
          limit);
      } else {
        const sql = `SELECT * FROM (SELECT * FROM (
            SELECT * FROM (SELECT ${E} FROM events WHERE type IN (${typePh}) AND from_id IN (${ph}) ORDER BY timestamp DESC LIMIT ?)
            UNION
            SELECT * FROM (SELECT ${E} FROM events WHERE type IN (${typePh}) AND to_id IN (${ph}) ORDER BY timestamp DESC LIMIT ?)
          ) ORDER BY timestamp DESC LIMIT ?) ORDER BY timestamp ${outer}`;
        rows = this._query(this.db.prepare(sql),
          ...CHAT_HISTORY_EVENT_TYPES, ...exactIds, limit,
          ...CHAT_HISTORY_EVENT_TYPES, ...exactIds, limit,
          limit);
      }
    } else if (before) {
      rows = this._query(outer === 'DESC' ? this._queryEventsBeforeDesc : this._queryEventsBefore,
        before, ...CHAT_HISTORY_EVENT_TYPES, limit);
    } else {
      rows = this._query(outer === 'DESC' ? this._queryEventsLatestDesc : this._queryEventsLatest,
        ...CHAT_HISTORY_EVENT_TYPES, limit);
    }
    return rows;
  }

  // Give raw `events` rows the display fields a chat line needs: the aliases the
  // renderer reads, the read flag, and the from/to labels.
  //
  // Extracted so the filter-subscription path and buildChatHistoryResponse cannot
  // resolve rows differently. Two paths that shape the same row differently is
  // how live and history came to disagree in the first place; a chat panel fed
  // by a subscription must get rows indistinguishable from the ones the history
  // fetch gives it, or the same message renders two ways depending on how it
  // arrived.
  resolveChatRows(events, { serverOwnerId = null, serverOwnerName = null } = {}) {
    const rows = events.map(e => ({ ...e, event_type: e.event_type ?? e.type, from: e.from, to: e.to, agent: e.agent ?? e.agent_id }));

    const agentMap = { ...this.getAgentNameMap() };
    if (serverOwnerId || serverOwnerName) {
      agentMap.web = agentMap[serverOwnerId] || serverOwnerName || serverOwnerId || 'web';
    }

    const unreadIds = new Set();
    const eventIds = rows.map(e => e.id).filter(id => id != null);
    if (eventIds.length) {
      const placeholders = eventIds.map(() => '?').join(',');
      try {
        const unread = this.db.prepare(`SELECT event_id FROM unread WHERE read = 0 AND event_id IN (${placeholders})`).all(...eventIds);
        for (const r of unread) unreadIds.add(r.event_id);
      } catch (e) {
        console.error('[fleet] unread query failed:', e.message);
      }
    }

    return rows.map(e => ({
      ...e,
      read: !unreadIds.has(e.id),
      fromLabel: agentMap[e.from] || (e.from ? e.from.substring(0, 8) : ''),
      toLabel: agentMap[e.to] || agentMap[e.agent] || (e.to ? e.to.substring(0, 8) : ''),
    }));
  }

  buildChatHistoryResponse({ before = null, agents = [], limit = 50, serverOwnerId = null, serverOwnerName = null } = {}) {
    const cap = Math.min(parseInt(limit) || 50, 1000);
    let events = this.queryChatHistory({
      before,
      agents: Array.isArray(agents) ? agents : [],
      limit: cap + 1,
    });

    const hasMore = events.length > cap;
    if (hasMore) events.shift();
    // No text-prefix filtering here. queryChatHistory already selects only
    // conversation event types before LIMIT, so diagnostic telemetry cannot
    // consume the page and then vanish in the renderer.

    const resolved = this.resolveChatRows(events, { serverOwnerId, serverOwnerName });
    const nextCursor = hasMore && events.length > 0 ? events[0].timestamp : null;
    return { events: resolved, hasMore, nextCursor };
  }

  // Get events after a known rowid (for SSE catch-up)
  getEventsSince(afterId, limit = 100) {
    return this._query(this._queryEventsAfterRowid, afterId, limit);
  }

  // One page of the global event stream, optionally narrowed to a set of types.
  // `beforeId` pages backwards (newest-first selection, returned oldest-first);
  // otherwise it pages forwards from `afterId`.
  //
  // Rows come back UNHYDRATED — `metadata` is the stored JSON string, not a
  // parsed object. That is deliberate and it is not what getEventsSince does.
  // The four raw queries this replaces (the store-events socket verb and
  // GET /api/events) all returned the string, while the no-filter branch of
  // those same two endpoints falls through to getEventsSince and returns an
  // object. So one endpoint already answers with two different shapes for
  // `metadata` depending on its query parameters. Hydrating here would change
  // the wire payload for the ?type= and ?before= consumers — one of which is
  // Grafana — so the inconsistency is preserved rather than quietly fixed.
  queryEventsPage({ types = null, afterId = 0, beforeId = null, limit = 200 } = {}) {
    const typeList = Array.isArray(types) && types.length ? types : null;
    const typeClause = typeList ? `type IN (${typeList.map(() => '?').join(',')}) AND ` : '';
    if (beforeId) {
      const rows = this.db.prepare(
        `SELECT ${this._EVT} FROM events WHERE ${typeClause}id < ? ORDER BY id DESC LIMIT ?`
      ).all(...(typeList || []), beforeId, limit);
      rows.reverse();
      return rows;
    }
    return this.db.prepare(
      `SELECT ${this._EVT} FROM events WHERE ${typeClause}id > ? ORDER BY id ASC LIMIT ?`
    ).all(...(typeList || []), afterId, limit);
  }

  getLastEventId() {
    return this._lastRowid.get()?.max_id || 0;
  }

  // Fetch one agent's thread (events where it is sender OR recipient) as a
  // UNION of two indexed scans instead of `(from_id=? OR to_id=?)`. The OR
  // forces SQLite into a MULTI-INDEX-OR + temp-btree sort that measured ~10×
  // slower (890ms → 80ms for a wide-window, no-type-filter read). Each branch
  // hits idx_events_from / idx_events_to; UNION (not UNION ALL) dedupes the
  // from==to==agent row by full-row identity (id is unique). Handles the four
  // shapes the callers need: timestamp range, afterId, beforeId, plain.
  // Returns rows in the same order/orientation the old inline query did.
  queryAgentEvents({ agent, types = null, excludeTypes = null, sinceTs = null, untilTs = null, afterId = 0, beforeId = null, limit = 200 }) {
    const cols = 'id, type, timestamp, from_id as "from", to_id as "to", text, metadata, task_id, agent_id';
    const tail = [];
    const tailParams = [];
    if (types && types.length) { tail.push(`type IN (${types.map(() => '?').join(',')})`); tailParams.push(...types); }
    if (excludeTypes && excludeTypes.length) { tail.push(`type NOT IN (${excludeTypes.map(() => '?').join(',')})`); tailParams.push(...excludeTypes); }
    let order;
    // `id` is the deterministic tiebreaker on equal timestamps — without it the
    // page boundary at LIMIT is nondeterministic (the old OR query had this
    // latent bug; the UNION makes it visible, so fix it here).
    if (sinceTs || untilTs) {
      if (sinceTs) { tail.push('timestamp > ?'); tailParams.push(sinceTs); }
      if (untilTs) { tail.push('timestamp <= ?'); tailParams.push(untilTs); }
      order = 'timestamp ASC, id ASC';
    } else if (afterId) {
      tail.push('id > ?'); tailParams.push(afterId); order = 'id ASC';
    } else if (beforeId) {
      tail.push('id < ?'); tailParams.push(beforeId); order = 'id DESC';
    } else {
      order = 'timestamp ASC, id ASC';
    }
    const tailSql = tail.length ? ' AND ' + tail.join(' AND ') : '';
    const branch = (col) => `SELECT * FROM (SELECT ${cols} FROM events WHERE ${col} = ?${tailSql} ORDER BY ${order} LIMIT ?)`;
    const sql = `SELECT * FROM (${branch('from_id')} UNION ${branch('to_id')}) ORDER BY ${order} LIMIT ?`;
    const params = [agent, ...tailParams, limit, agent, ...tailParams, limit, limit];
    const rows = this.db.prepare(sql).all(...params);
    if (beforeId) rows.reverse();
    return rows;
  }

  // ---- Search ----

  search(query, { limit = 50, type, agent } = {}) {
    const ftsQuery = anyTermFtsQuery(query);
    const searchTable = type === 'activity' ? 'activity_events_fts' : 'events_fts';
    const clauses = [];
    const params = [];
    const candidateLimit = Math.min(Math.max(Number(limit || 50) * 100, 1000), 10000);

    if (type) { clauses.push('e.type = ?'); params.push(type); }
    else { clauses.push('e.type != ?'); params.push('notification_attempt'); }
    if (agent) {
      clauses.push('(e.from_id = ? OR e.to_id = ? OR e.agent_id = ?)');
      params.push(agent, agent, agent);
    }
    params.push(limit);

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const sql = `
      SELECT ${this._EVTE}, snippet(${searchTable}, 0, '<<', '>>', '...', 40) as snippet, f.fts_rank
      FROM (
        SELECT rowid, rank AS fts_rank
        FROM ${searchTable}
        WHERE ${searchTable} MATCH ?
        ORDER BY rank
        LIMIT ?
      ) f
      JOIN ${searchTable} ON ${searchTable}.rowid = f.rowid
      JOIN events e ON e.id = f.rowid
      ${where}
      LIMIT ?
    `;

    return rankUnifiedSearchRows(
      this.db.prepare(sql).all(ftsQuery, candidateLimit, ...params).map(r => ({
          ...r,
          source: 'fleet',
          metadata: r.metadata ? JSON.parse(r.metadata) : null,
          snippet: r.snippet?.replace(/<<(.*?)>>/g, '⟨⟨$1⟩⟩'),
          ftsRank: r.fts_rank ?? 0,
        })),
      { terms: ftsQueryTerms(query), query, explicitActivitySearch: type === 'activity' },
    ).slice(0, limit);
  }

  // ---- Session entry indexing (JSONL text for unified search) ----

  async insertSessionEntries(entries) {
    if (!entries?.length) return { inserted: 0 };
    const sql = `
      INSERT OR IGNORE INTO session_entries (agent_id, session_id, role, timestamp, text)
      VALUES (?, ?, ?, ?, ?)
    `;
    const ops = [];
    for (const e of entries) {
      if (!e.timestamp) continue;
      const text = e.text?.length > 5000 ? e.text.slice(0, 5000) : e.text;
      ops.push({ stmtOrSql: sql, params: [e.agent_id, e.session_id, e.role, e.timestamp, text] });
    }
    if (!ops.length) return { inserted: 0 };
    const results = await this._wBatchAwait(ops);
    return { inserted: results.reduce((sum, r) => sum + (r.changes || 0), 0) };
  }

  async backfillSessionEntries(projectsDir) {
    let dirs;
    try { dirs = fs.readdirSync(projectsDir); } catch { return { indexed: 0, skipped: 0 }; }

    const allFiles = [];
    let skipped = 0;
    for (const dir of dirs) {
      const dirPath = path.join(projectsDir, dir);
      let files;
      try { files = fs.readdirSync(dirPath); } catch { continue; }
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const sessionId = file.slice(0, -6);
        if (this._hasSessionEntries.get(sessionId)) {
          skipped++;
          continue;
        }
        allFiles.push({ filePath: path.join(dirPath, file), sessionId });
      }
    }

    const insertSessionSql = `
      INSERT OR IGNORE INTO session_entries (agent_id, session_id, role, timestamp, text)
      VALUES (?, ?, ?, ?, ?)
    `;
    let totalIndexed = 0;
    for (const { filePath, sessionId } of allFiles) {
      const agentId = 'unknown';
      let content;
      try { content = await fs.promises.readFile(filePath, 'utf8'); } catch { continue; }
      const entries = [];
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        let parsed;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (parsed.type !== 'user' && parsed.type !== 'assistant') continue;
        const ts = parsed.timestamp || parsed.message?.timestamp || parsed.snapshot?.timestamp || null;
        if (!ts) continue;
        const c = parsed.message?.content;
        let text = '';
        if (typeof c === 'string') text = c;
        else if (Array.isArray(c)) text = c.filter(x => x?.type === 'text').map(x => x.text).join('\n');
        if (!text || text.length < 3) continue;
        entries.push({ agentId, sessionId, role: parsed.type, timestamp: ts, text });
      }
      if (entries.length > 0) {
        await this._wBatchAwait(entries.map(e => {
          const t = e.text.length > 5000 ? e.text.slice(0, 5000) : e.text;
          return { stmtOrSql: insertSessionSql, params: [e.agentId, e.sessionId, e.role, e.timestamp, t] };
        }));
        totalIndexed++;
      }
      await new Promise(r => setImmediate(r));
    }
    return { indexed: totalIndexed, skipped: skipped + allFiles.length - totalIndexed };
  }

  // Unified search across fleet events (events_fts) and session JSONL text (session_entries_fts).
  // Resolve a typed name atom or lineage to fleet ids. Friendly names are
  // matched verbatim; lineage expansion comes from the stack table, never from
  // decomposing a name.
  resolveAgentQuery(fragment) {
    return this.resolveAgentSelector({ fragment });
  }

  resolveAgentSelector(selector) {
    selector = typeof selector === 'string' ? { fragment: selector } : (selector || {});
    const baseFragment = (selector.fragment || '').trim().toLowerCase();
    if (!baseFragment) return [];
    const lineage = this.getLineage(selector.fragment)
    if (lineage) {
      const stackRows = this.db.prepare(`
        SELECT fleet_id, MIN(stack_index) AS stack_index, MAX(entered_at) AS entered_at
        FROM lineage_stack_entries WHERE lineage_id = ?
        GROUP BY fleet_id
        ORDER BY CASE WHEN MAX(active) = 1 THEN 0 ELSE 1 END, stack_index, entered_at DESC
      `).all(lineage.id)
      const stackIds = stackRows.map(row => row.fleet_id)
      if (selector.position != null) {
        const idx = Math.max(0, Number(selector.position) - 1)
        return stackIds[idx] ? [stackIds[idx]] : []
      }
      if (selector.range) {
        const from = selector.range.from == null ? 0 : Math.max(0, Number(selector.range.from) - 1)
        const to = selector.range.to == null ? undefined : Math.max(from, Number(selector.range.to))
        return stackIds.slice(from, to)
      }
      return stackIds
    }
    const q = baseFragment;
    const idAliases = q.startsWith('fleet:') ? [q] : [q, `fleet:${q}`];
    const like = `%${q}%`;
    const rows = this.db.prepare(`
      WITH matches AS (
        SELECT id, coalesce(last_seen, registered_at, '') AS seen_at FROM agents
          WHERE lower(id) IN (${idAliases.map(() => '?').join(',')})
        UNION ALL
        SELECT id, coalesce(last_seen, registered_at, '') AS seen_at FROM agents
          WHERE friendly_name IS NOT NULL AND lower(friendly_name) LIKE ?
        UNION ALL
        SELECT fleet_id AS id, coalesce(to_ts, from_ts, '') AS seen_at FROM name_history
          WHERE friendly_name IS NOT NULL AND lower(friendly_name) LIKE ?
      )
      SELECT id FROM matches
      GROUP BY id
      ORDER BY max(seen_at) DESC, id ASC
    `).all(...idAliases, like, like);
    let ids = rows.map(r => r.id);
    if (selector.position != null) {
      const idx = Math.max(0, Number(selector.position) - 1);
      ids = ids[idx] ? [ids[idx]] : [];
    } else if (selector.range) {
      const from = selector.range.from == null ? 0 : Math.max(0, Number(selector.range.from) - 1);
      const to = selector.range.to == null ? undefined : Math.max(from, Number(selector.range.to));
      ids = ids.slice(from, to);
    }
    return ids;
  }

  searchAll(query, { limit = 50, agent, role, type, types, since, before, agentOnly, historyOnly, eventOnly, fromOnly } = {}) {
    const terms = ftsQueryTerms(query);
    const ftsQuery = anyTermFtsQuery(query);

    // Normalize agent to array for multi-ID lineage search
    const agentIds = Array.isArray(agent) ? agent : agent ? [agent] : [];
    const hasAgent = agentIds.length > 0;
    const agentPlaceholders = agentIds.map(() => '?').join(',');
    const historyMode = historyOnly ?? agentOnly ?? false;
    let eventTypes = Array.isArray(types) && types.length ? types : type ? [type] : null;
    const sessionRole = role === 'user' || role === 'assistant' ? role : null;
    if (role && !sessionRole) eventTypes = eventTypes || [role];
    const defaultEventTypes = ['chat', 'delegate', 'report', 'task_update', 'task_done'];
    const searchedEventTypes = eventTypes || (historyMode ? null : defaultEventTypes);
    const excludeNotificationAttempts = !eventTypes;
    const explicitActivitySearch = eventTypes?.includes('activity') || false;
    const includeEvents = !sessionRole;
    const includeSessions = !eventTypes || !!sessionRole;
    const candidateLimit = Math.min(Math.max(Number(limit || 50) * 100, 1000), 10000);

    function agentClause(fromCol, toCol, agentCol) {
      // `from:` semantics — restrict to messages the agent SENT (from_id only).
      if (fromOnly) {
        if (agentIds.length === 1) return { clause: `${fromCol} = ?`, params: [agentIds[0]] };
        return { clause: `${fromCol} IN (${agentPlaceholders})`, params: [...agentIds] };
      }
      if (agentIds.length === 1) {
        return { clause: `(${fromCol} = ? OR ${toCol} = ? OR ${agentCol} = ?)`, params: [agentIds[0], agentIds[0], agentIds[0]] };
      }
      return {
        clause: `(${fromCol} IN (${agentPlaceholders}) OR ${toCol} IN (${agentPlaceholders}) OR ${agentCol} IN (${agentPlaceholders}))`,
        params: [...agentIds, ...agentIds, ...agentIds]
      };
    }
    function eventRowMatches(row) {
      if (excludeNotificationAttempts && row.type === 'notification_attempt') return false;
      if (searchedEventTypes && !searchedEventTypes.includes(row.type)) return false;
      if (since && row.timestamp < since) return false;
      if (before && row.timestamp >= before) return false;
      if (hasAgent) {
        if (fromOnly) return agentIds.includes(row.from);
        return agentIds.includes(row.from) || agentIds.includes(row.to) || agentIds.includes(row.agentId);
      }
      return true;
    }
    function sessionRowMatches(row) {
      if (sessionRole && row.role !== sessionRole) return false;
      if (since && row.timestamp < since) return false;
      if (before && row.timestamp >= before) return false;
      if (hasAgent && !agentIds.includes(row.agentId)) return false;
      return true;
    }

    // 1. Fleet events
    let eventRows = [];
    if (includeEvents) {
      if (historyMode && hasAgent && eventOnly) {
        const rows = agentIds.flatMap(agentId => this.queryAgentEvents({
          agent: agentId,
          types: eventTypes,
          excludeTypes: excludeNotificationAttempts ? ['notification_attempt'] : null,
          sinceTs: since,
          untilTs: before,
          limit,
        }));
        eventRows = rows.map(r => ({
          source: 'fleet',
          id: r.id,
          type: r.type,
          timestamp: r.timestamp,
          from: r.from,
          to: r.to,
          text: r.text,
          metadata: r.metadata ? JSON.parse(r.metadata) : null,
          snippet: r.text?.slice(0, 120),
          ftsRank: 0,
        })).sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? '')).slice(0, limit);
      } else {
        const eClauses = [];
        const eParams = [];
        if (hasAgent) {
          const ac = agentClause('e.from_id', 'e.to_id', 'e.agent_id');
          eClauses.push(ac.clause);
          eParams.push(...ac.params);
        }
        if (searchedEventTypes) {
          eClauses.push(`e.type IN (${searchedEventTypes.map(() => '?').join(',')})`);
          eParams.push(...searchedEventTypes);
        } else if (excludeNotificationAttempts) {
          eClauses.push('e.type != ?');
          eParams.push('notification_attempt');
        }
        if (since) { eClauses.push('e.timestamp >= ?'); eParams.push(since); }
        if (before) { eClauses.push('e.timestamp < ?'); eParams.push(before); }
        eParams.push(historyMode ? limit : candidateLimit);
        const eventWhere = eClauses.length ? `WHERE ${eClauses.join(' AND ')}` : '';
        const searchTable = explicitActivitySearch ? 'activity_events_fts' : 'events_fts';
        const snippetCol = historyMode ? 'substr(e.text, 1, 120) as snippet' : `snippet(${searchTable}, 0, '<<', '>>', '...', 40) as snippet`;
        const hasEventPreFilter = !historyMode && eClauses.length > 0;
        const eventSql = historyMode ? `
        SELECT e.id, e.type, e.timestamp, e.from_id as "from", e.to_id as "to", e.text, e.metadata, e.agent_id,
               ${snippetCol}, 0 as fts_rank
        FROM events e
        ${eventWhere}
        ORDER BY e.timestamp DESC LIMIT ?
      ` : hasEventPreFilter ? `
        SELECT e.id, e.type, e.timestamp, e.from_id as "from", e.to_id as "to", e.text, e.metadata, e.agent_id,
               ${snippetCol}, ${searchTable}.rank as fts_rank
        FROM ${searchTable}
        JOIN events e ON e.id = ${searchTable}.rowid
        ${eventWhere ? `${eventWhere} AND` : 'WHERE'} ${searchTable} MATCH ?
        ORDER BY ${searchTable}.rank
        LIMIT ?
      ` : `
        SELECT e.id, e.type, e.timestamp, e.from_id as "from", e.to_id as "to", e.text, e.metadata, e.agent_id,
               ${snippetCol}, f.fts_rank
        FROM (
          SELECT rowid, rank AS fts_rank
          FROM ${searchTable}
          WHERE ${searchTable} MATCH ?
          ORDER BY rank
          LIMIT ?
        ) f
        JOIN ${searchTable} ON ${searchTable}.rowid = f.rowid
        JOIN events e ON e.id = f.rowid
        ${eventWhere}
        LIMIT ?
      `;
        const eventParams = historyMode
          ? eParams
          : hasEventPreFilter
            ? [...eParams.slice(0, -1), ftsQuery, candidateLimit]
            : [ftsQuery, candidateLimit, ...eParams];
        eventRows = this.db.prepare(eventSql).all(...eventParams).map(r => ({
          source: 'fleet',
          id: r.id,
          type: r.type,
          timestamp: r.timestamp,
          from: r.from,
          to: r.to,
          text: r.text,
          agentId: r.agent_id,
          metadata: r.metadata ? JSON.parse(r.metadata) : null,
          snippet: r.snippet?.replace(/<<(.*?)>>/g, '⟨⟨$1⟩⟩'),
          ftsRank: r.fts_rank ?? 0,
        })).filter(row => historyMode || eventRowMatches(row));
      }
    }

    if (eventOnly) {
      return historyMode
        ? eventRows.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? '')).slice(0, limit)
        : rankUnifiedSearchRows(eventRows, { terms, query, explicitActivitySearch }).slice(0, limit);
    }

    // 2. Session JSONL entries
    let sessionRows = [];
    if (includeSessions) {
      const sClauses = [];
      const sParams = [];
      if (hasAgent) {
        if (agentIds.length === 1) {
          sClauses.push('s.agent_id = ?');
          sParams.push(agentIds[0]);
        } else {
          sClauses.push(`s.agent_id IN (${agentPlaceholders})`);
          sParams.push(...agentIds);
        }
      }
      if (sessionRole) { sClauses.push('s.role = ?'); sParams.push(sessionRole); }
      if (since) { sClauses.push('s.timestamp >= ?'); sParams.push(since); }
      if (before) { sClauses.push('s.timestamp < ?'); sParams.push(before); }
      sParams.push(historyMode ? limit : candidateLimit);
      const sessionWhere = sClauses.length ? `WHERE ${sClauses.join(' AND ')}` : '';
      const sSnippetCol = historyMode ? 'substr(s.text, 1, 120) as snippet' : "snippet(session_entries_fts, 0, '<<', '>>', '...', 40) as snippet";
      const hasSessionPreFilter = !historyMode && sClauses.length > 0;
      const sessionSql = historyMode ? `
        SELECT s.id, s.agent_id, s.session_id, s.role, s.timestamp, s.text,
               ${sSnippetCol}, 0 as fts_rank
        FROM session_entries s
        ${sessionWhere}
        ORDER BY s.timestamp DESC LIMIT ?
      ` : hasSessionPreFilter ? `
        SELECT s.id, s.agent_id, s.session_id, s.role, s.timestamp, s.text,
               ${sSnippetCol}, session_entries_fts.rank as fts_rank
        FROM session_entries_fts
        JOIN session_entries s ON s.id = session_entries_fts.rowid
        ${sessionWhere ? `${sessionWhere} AND` : 'WHERE'} session_entries_fts MATCH ?
        ORDER BY session_entries_fts.rank
        LIMIT ?
      ` : `
        SELECT s.id, s.agent_id, s.session_id, s.role, s.timestamp, s.text,
               ${sSnippetCol}, f.fts_rank
        FROM (
          SELECT rowid, rank AS fts_rank
          FROM session_entries_fts
          WHERE session_entries_fts MATCH ?
          ORDER BY rank
          LIMIT ?
        ) f
        JOIN session_entries_fts ON session_entries_fts.rowid = f.rowid
        JOIN session_entries s ON s.id = f.rowid
        ${sessionWhere}
        LIMIT ?
      `;
      const sessionParams = historyMode
        ? sParams
        : hasSessionPreFilter
          ? [...sParams.slice(0, -1), ftsQuery, candidateLimit]
          : [ftsQuery, candidateLimit, ...sParams];
      sessionRows = this.db.prepare(sessionSql).all(...sessionParams).map(r => ({
        source: 'session',
        id: r.id,
        agentId: r.agent_id,
        sessionId: r.session_id,
        role: r.role,
        timestamp: r.timestamp,
        text: r.text,
        snippet: r.snippet?.replace(/<<(.*?)>>/g, '⟨⟨$1⟩⟩'),
        ftsRank: r.fts_rank ?? 0,
      })).filter(row => historyMode || sessionRowMatches(row));
    }

    if (historyMode) {
      return [...eventRows, ...sessionRows]
        .sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''))
        .slice(0, limit);
    }

    return rankUnifiedSearchRows([...eventRows, ...sessionRows], { terms, query, explicitActivitySearch }).slice(0, limit);
  }

  getSearchStats() {
    const eventTypes = this.db.prepare(`
      SELECT type, COUNT(*) AS count
      FROM events
      GROUP BY type
      ORDER BY count DESC, type ASC
    `).all();
    const totalEvents = eventTypes.reduce((sum, row) => sum + row.count, 0);
    const sessionEntries = this.db.prepare('SELECT COUNT(*) AS count FROM session_entries').get()?.count || 0;
    const sessionRoles = this.db.prepare(`
      SELECT role, COUNT(*) AS count
      FROM session_entries
      GROUP BY role
      ORDER BY count DESC, role ASC
    `).all();
    const ftsContentVersion = this.db.prepare("SELECT value FROM search_index_meta WHERE key = 'events_fts_content_version'").get()?.value || null;
    return {
      events: { total: totalEvents, byType: eventTypes },
      sessionEntries: { total: sessionEntries, byRole: sessionRoles },
      fts: { eventsContentVersion: ftsContentVersion },
    };
  }

  searchProjectAgents(projectOrCwd, { limit = 50, since = null, before = null, agentIds = null } = {}) {
    const raw = String(projectOrCwd || '').trim();
    if (!raw) return [];
    const cap = Math.min(Math.max(parseInt(limit) || 50, 1), 100);
    const explicitAgentIds = Array.isArray(agentIds) ? agentIds.filter(Boolean) : [];
    const isPath = raw.includes('/') || raw.startsWith('~');
    const normalized = raw.replace(/\/+$/, '');
    const params = [];
    let candidateRawSql;
    if (isPath) {
      candidateRawSql = `
        SELECT id AS agent_id, cwd, registered_at AS seat_created_at FROM agents WHERE rtrim(cwd, '/') = ?
      `;
      params.push(normalized);
    } else {
      candidateRawSql = `
        SELECT a.id AS agent_id, a.cwd, a.registered_at AS seat_created_at
        FROM agent_cwd_segments cs
        JOIN agents a ON a.id = cs.agent_id
        WHERE cs.segment = ? AND cs.source = 'agent'
      `;
      params.push(raw);
    }
    const sql = `
      WITH candidate_raw AS (
        ${candidateRawSql}
      ),
      candidate AS (
        SELECT agent_id, max(cwd) AS cwd, max(seat_created_at) AS seat_created_at
        FROM candidate_raw
        WHERE agent_id IS NOT NULL AND agent_id != ''
        GROUP BY agent_id
      )
      SELECT c.agent_id, c.cwd, c.seat_created_at,
             a.friendly_name, a.pretty_name, a.dead, a.last_seen, a.last_active, a.registered_at
      FROM candidate c
      LEFT JOIN agents a ON a.id = c.agent_id
      ${explicitAgentIds.length ? `WHERE c.agent_id IN (${explicitAgentIds.map(() => '?').join(',')})` : ''}
      ORDER BY coalesce(a.last_active, a.last_seen, c.seat_created_at, a.registered_at, '') DESC
      LIMIT ?
    `;
    const candidateCap = Math.min(Math.max(cap * 5, 50), 500);
    const rows = this.db.prepare(sql).all(...params, ...params, ...explicitAgentIds, candidateCap);

    const eventTimeClauses = [];
    const eventTimeParams = [];
    if (since) { eventTimeClauses.push('timestamp >= ?'); eventTimeParams.push(since); }
    if (before) { eventTimeClauses.push('timestamp < ?'); eventTimeParams.push(before); }
    const eventTimeWhere = eventTimeClauses.length ? `AND ${eventTimeClauses.join(' AND ')}` : '';
    const sessionTimeWhere = eventTimeClauses.length ? `AND ${eventTimeClauses.join(' AND ')}` : '';
    const eventSelect = `${this._EVTE}, 'fleet' AS source, NULL AS role, NULL AS session_id`;
    const eventByFrom = this.db.prepare(`
      SELECT ${eventSelect}
      FROM events e
      WHERE from_id = ? ${eventTimeWhere}
      ORDER BY timestamp DESC, id DESC
      LIMIT 1
    `);
    const eventByTo = this.db.prepare(`
      SELECT ${eventSelect}
      FROM events e
      WHERE to_id = ? ${eventTimeWhere}
      ORDER BY timestamp DESC, id DESC
      LIMIT 1
    `);
    const eventByAgent = this.db.prepare(`
      SELECT ${eventSelect}
      FROM events e
      WHERE agent_id = ? ${eventTimeWhere}
      ORDER BY timestamp DESC, id DESC
      LIMIT 1
    `);
    const sessionByAgent = this.db.prepare(`
      SELECT id, agent_id, timestamp, text, 'session' AS source, NULL AS type, NULL AS metadata,
             NULL AS from_id, NULL AS to_id, role, session_id
      FROM session_entries
      WHERE agent_id = ? ${sessionTimeWhere}
      ORDER BY timestamp DESC, id DESC
      LIMIT 1
    `);
    const latestFor = (agentId) => {
      const args = [agentId, ...eventTimeParams];
      const candidates = [
        eventByFrom.get(...args),
        eventByTo.get(...args),
        eventByAgent.get(...args),
        sessionByAgent.get(...args),
      ].filter(Boolean);
      candidates.sort((a, b) => {
        const tc = (b.timestamp || '').localeCompare(a.timestamp || '');
        return tc || ((b.id || 0) - (a.id || 0));
      });
      return candidates[0] || null;
    };

    return rows.map(r => {
      const latest = latestFor(r.agent_id);
      return {
        source: 'fleet',
        id: latest?.id || `project-agent:${r.agent_id}`,
        type: 'project_agent',
        timestamp: latest?.timestamp || r.last_active || r.last_seen || r.seat_created_at || r.registered_at || null,
        from: r.agent_id,
        to: null,
        agentId: r.agent_id,
        agentName: r.friendly_name || null,
        agentNameNow: r.friendly_name || null,
        text: latest?.text || '',
        snippet: (latest?.text || '').slice(0, 220),
        agent_id: r.agent_id,
        friendly_name: r.friendly_name || null,
        cwd: r.cwd || null,
        project: r.cwd ? path.basename(String(r.cwd).replace(/\/+$/, '')) : null,
        latest_relevant_at: latest?.timestamp || r.last_active || r.last_seen || r.seat_created_at || r.registered_at || null,
        latest_activity: {
          source: latest?.source || 'agent_seat',
          type: latest?.type || latest?.role || 'seat',
          event_id: latest?.source === 'fleet' ? latest.id : null,
          session_id: latest?.session_id || null,
          summary: (latest?.text || '').slice(0, 220),
        },
        status: {
          dead: !!r.dead,
          last_seen: r.last_seen || null,
          last_active: r.last_active || null,
        },
        thread: {
          agent: r.agent_id,
          query: `thread(agent: "${r.agent_id}")`,
        },
      }
    }).sort((a, b) => (b.latest_relevant_at || '').localeCompare(a.latest_relevant_at || '')).slice(0, cap);
  }

  projectAgentRows(projectOrCwd, agentIds, { limit = 50, since = null, before = null } = {}) {
    const wanted = new Set(Array.isArray(agentIds) ? agentIds.filter(Boolean) : []);
    if (!wanted.size) return [];
    return this.searchProjectAgents(projectOrCwd, {
      limit,
      since,
      before,
      agentIds: [...wanted],
    }).filter(row => wanted.has(row.agentId)).slice(0, limit);
  }

  projectAgentIds(projectOrCwd) {
    const raw = String(projectOrCwd || '').trim();
    if (!raw) return [];
    const isPath = raw.includes('/') || raw.startsWith('~');
    const normalized = raw.replace(/\/+$/, '');
    const params = [];
    let candidateRawSql;
    if (isPath) {
      candidateRawSql = `
        SELECT id AS agent_id FROM agents WHERE rtrim(cwd, '/') = ?
      `;
      params.push(normalized);
    } else {
      candidateRawSql = `
        SELECT a.id AS agent_id
        FROM agent_cwd_segments cs
        JOIN agents a ON a.id = cs.agent_id
        WHERE cs.segment = ? AND cs.source = 'agent'
      `;
      params.push(raw);
    }
    const sql = `
      WITH candidate_raw AS (
        ${candidateRawSql}
      )
      SELECT agent_id
      FROM candidate_raw
      WHERE agent_id IS NOT NULL AND agent_id != ''
    `;
    return this.db.prepare(sql).all(...params, ...params).map(r => r.agent_id);
  }

  // Get N chat events before/after a timestamp (for search context).
  getChatContext(timestamp, window = 3) {
    const cap = Math.min(window, 20);
    const beforeRows = this.db.prepare(`
      SELECT ${this._EVT} FROM events
      WHERE timestamp < ? AND type IN ('chat','delegate','task_done')
      ORDER BY timestamp DESC LIMIT ?
    `).all(timestamp, cap).reverse();
    const afterRows = this.db.prepare(`
      SELECT ${this._EVT} FROM events
      WHERE timestamp > ? AND type IN ('chat','delegate','task_done')
      ORDER BY timestamp ASC LIMIT ?
    `).all(timestamp, cap);
    return { before: beforeRows, after: afterRows };
  }

  // ---- State reconstruction (for state.json cache) ----

  /**
   * Reconstruct the full state object from SQLite tables.
   * This produces the same shape as loadState() from the JSON file.
   */
  reconstructState() {
    const agents = this.getAllAgents();
    const tasks = this.getAllTasks();

    // Build messages array from recent events (last 500 chat + lifecycle events)
    const recentEvents = this.db.prepare(`
      SELECT ${this._EVT} FROM events
      WHERE type IN ('chat', 'delegate', 'task_done', 'lifecycle', 'amend')
      ORDER BY timestamp DESC LIMIT 500
    `).all();

    const messages = recentEvents.reverse().map(e => {
      const msg = {
        to: e.to_id,
        from: e.from_id,
        text: e.text,
        timestamp: e.timestamp,
        read: true, // reconstructed messages are considered read
      };
      const meta = e.metadata ? JSON.parse(e.metadata) : null;
      if (e.type === 'delegate') {
        msg._evType = 'delegate';
        msg._description = e.text;
        msg._taskId = e.task_id;
        if (meta) {
          msg._fromLabel = meta.fromLabel;
          msg._toLabel = meta.toLabel;
          msg._criteria = meta.criteria || [];
          if (meta.message) msg._message = meta.message;
        }
      } else if (e.type === 'task_done') {
        msg._evType = 'task_done';
        msg._description = e.text;
        msg._taskId = e.task_id;
        msg._agent = e.agent_id;
      } else if (e.type === 'amend') {
        // Reference-event amend: carry metadata so the client can fold it into
        // its original (metadata.amends) and show the right version/source.
        msg.type = 'amend';
        if (meta) msg.metadata = meta;
      }
      return msg;
    });

    // Restore unread status
    const unreadRows = this.db.prepare('SELECT event_id FROM unread WHERE read = 0').all();
    const unreadIds = new Set(unreadRows.map(r => r.event_id));
    for (const e of recentEvents) {
      if (unreadIds.has(e.id)) {
        const msg = messages.find(m => m.timestamp === e.timestamp && m.from === e.from_id);
        if (msg) msg.read = false;
      }
    }

    return { agents, tasks, messages };
  }

  // ---- Listener management (for SSE) ----

  onEvent(fn) {
    this._listeners.push(fn);
    return () => {
      this._listeners = this._listeners.filter(f => f !== fn);
    };
  }

  // ---- Migration: import from state.json ----

  importFromStateJson(state) {
    const txn = this.db.transaction(() => {
      // Import agents
      for (const a of (state.agents || [])) {
        this.upsertAgent(a);
      }

      // Import tasks
      for (const t of (state.tasks || [])) {
        this.upsertTask(t);
      }

      // Import messages as events
      for (const m of (state.messages || [])) {
        const type = m._evType || 'chat';
        const meta = {};
        if (m._evType === 'delegate') {
          meta.fromLabel = m._fromLabel;
          meta.toLabel = m._toLabel;
          meta.criteria = m._criteria;
          if (m._message) meta.message = m._message;
        }
        if (m.attachments) meta.attachments = m.attachments;
        if (m._timer) meta.timer = true;
        if (m._raw) meta.raw = true;

        const result = this._insertEvent.run(
          type,
          m.timestamp || new Date().toISOString(),
          m.from || null,
          m.to || null,
          m.text || null,
          Object.keys(meta).length > 0 ? JSON.stringify(meta) : null,
          m._taskId || null,
          m._agent || null
        );

        // Track unread
        if (!m.read && m.to) {
          this._insertUnread.run(result.lastInsertRowid, m.to);
        }
      }
    });
    txn();
  }

  // ---- Identity transfer ----

  /**
   * Transfer active tasks from one agent to another (for compaction/respawn identity changes).
   * Returns the number of tasks transferred.
   */
  transferTasks(fromAgentId, toAgentId) {
    return this.db.prepare("UPDATE tasks SET agent = ? WHERE agent = ? AND status != 'done'")
      .run(toAgentId, fromAgentId).changes;
  }

  /**
   * Transfer unread messages from one agent to another.
   * Returns the number of unread entries transferred.
   */
  transferUnread(fromAgentId, toAgentId) {
    return this.db.prepare("UPDATE unread SET to_id = ? WHERE to_id = ? AND read = 0")
      .run(toAgentId, fromAgentId).changes;
  }

  /**
   * Find active tasks assigned to any of the given agent IDs.
   */
  getTasksByAgents(agentIds) {
    if (!agentIds.length) return [];
    const placeholders = agentIds.map(() => '?').join(',');
    return this.db.prepare(`SELECT * FROM tasks WHERE agent IN (${placeholders}) AND status != 'done' ORDER BY delegated_at DESC`)
      .all(...agentIds).map(r => this._hydrateTask(r));
  }

  // ---- Cleanup ----

  pruneDoneTasks(maxAgeMs = 86400000) {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    return this.db.prepare("DELETE FROM tasks WHERE status = 'done' AND completed_at < ?").run(cutoff).changes;
  }

  addSkillRead(agentId, skillKey) {
    this.db.prepare('INSERT OR IGNORE INTO skill_reads (agent_id, skill_key) VALUES (?, ?)').run(agentId, skillKey);
  }

  clearSkillReads(agentId) {
    this.db.prepare('DELETE FROM skill_reads WHERE agent_id = ?').run(agentId);
  }

  getSkillReads(agentId) {
    return new Set(
      this.db.prepare('SELECT skill_key FROM skill_reads WHERE agent_id = ?').all(agentId).map(r => r.skill_key)
    );
  }

  getAllSkillReadsByAgent() {
    const reads = new Map();
    const rows = this.db.prepare('SELECT agent_id, skill_key FROM skill_reads ORDER BY agent_id').all();
    for (const row of rows) {
      if (!reads.has(row.agent_id)) reads.set(row.agent_id, new Set());
      reads.get(row.agent_id).add(row.skill_key);
    }
    return reads;
  }

  // Store (or replace) a drill report card for an agent.
  addDrillCard(agentId, drillId, { gradient = null, pass = null, card = {} } = {}) {
    this.db.prepare(
      `INSERT INTO drill_cards (agent_id, drill_id, gradient, pass, card_json, graded_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(agent_id, drill_id) DO UPDATE SET
         gradient = excluded.gradient, pass = excluded.pass,
         card_json = excluded.card_json, graded_at = excluded.graded_at`
    ).run(agentId, drillId, gradient, pass == null ? null : (pass ? 1 : 0), JSON.stringify(card));
  }

  // All drill cards for an agent, newest first.
  getDrillCards(agentId) {
    return this.db.prepare(
      'SELECT drill_id, gradient, pass, card_json, graded_at FROM drill_cards WHERE agent_id = ? ORDER BY graded_at DESC'
    ).all(agentId).map(r => ({
      drill: r.drill_id, gradient: r.gradient,
      pass: r.pass == null ? null : !!r.pass,
      gradedAt: r.graded_at,
      card: (() => { try { return JSON.parse(r.card_json); } catch { return {}; } })(),
    }));
  }

  close() {
    this._closed = true;
    if (this._cwdSegmentBackfillImmediate) clearImmediate(this._cwdSegmentBackfillImmediate);
    this._cwdSegmentBackfillImmediate = null;
    this.db.close();
  }
}
