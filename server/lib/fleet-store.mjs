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
import { Worker } from 'node:worker_threads';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { createLiveStore } from '../../shared/live-store.ts';
import { PSEUDO_LABELS, parseFilter, evalExpr, evalExprDirectional, labelsForAgent } from '../../shared/fleet-labels.mjs';
import { baseName, nameForPhase, phaseFromName, ALL_PHASES, prettyNameForFriendlyName } from '../../shared/lineage-name.mjs';
import { literalFtsQuery } from '../../shared/fts-query.mjs';
import { createTaskDocMaterializer } from './task-doc-materializer.mjs';

// Persistent DB under ~/.config/tlda/ (survives macOS reboots).
// Previously /tmp/fleet.db which got wiped on reboot — lost all agents/state.
// Excluded from Spotlight via a .metadata_never_index file next to the DB.
const DB_PATH = path.join(os.homedir(), '.config', 'tlda', 'fleet.db');
const FLEET_DIR = path.join(os.homedir(), '.fleet');
const WIRETAP_EVENT_TYPES = new Set(['chat', 'delegate', 'task_done']);

function compareAgentsForRoster(a, b) {
  const ts = (x) => x ? new Date(x).getTime() || 0 : 0;
  const seenDelta = ts(b.last_seen) - ts(a.last_seen);
  if (seenDelta !== 0) return seenDelta;
  return ts(b.last_active) - ts(a.last_active);
}

function astLiteral(ast) {
  return ast && ast.t === 'lit' ? ast.v : null;
}

function serializePrettyName(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
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

// Virtual labels emitted by the DNF chat-routing resolver based on liveness
// state. A friendly_name or label that equals one of these would silently
// shadow the routing category. Single source of truth: shared/fleet-labels.mjs
// (statusLabels), re-exported here for the name-collision checks.
export { PSEUDO_LABELS };

export class FleetStore {
  constructor(dbPath, options = {}) {
    dbPath = dbPath || DB_PATH;
    // Ensure directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

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
            }
            return r;
          };
        }
        return stmt;
      };
    }
    // WAL (set here + by the writer worker; it's a persistent property of the
    // file): lets THIS main connection READ concurrently while the worker holds
    // the write lock during a slow FTS merge. NORMAL is durable across an app
    // crash — only a power loss can lose the last txn, never corrupts.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this._createTables();
    this._prepareStatements();
    this._initAgentRegistry();
    this._wiretapCache = null;
    this._backfillNameHistory();
    this._listeners = []; // SSE broadcast callbacks
    this._taskDocMaterializer = options.taskDoc === true && process.env.TLDA_TASK_DOC_DISABLE !== '1'
      ? createTaskDocMaterializer({ fleetStore: this, ...(options.taskDocOptions || {}) })
      : null;

    // The writer worker owns the connection that writes the high-frequency
    // `events` rows (every activity card / chat). better-sqlite3 is synchronous,
    // so a ~1.5s FTS-merge on an events INSERT would freeze THIS thread's event
    // loop — dropping fleet chat/health — if it ran here. On the worker it never
    // touches the loop. (Lower-frequency agent/lineage writes still run
    // synchronously on this connection; making the worker the SOLE writer for
    // those too is a flagged follow-up.)
    this._writeSeq = 0;
    this._writeWaiters = new Map();
    this._worker = new Worker(new URL('./db-writer.worker.mjs', import.meta.url), { workerData: { dbPath } });
    this._worker.on('message', (m) => {
      if (m && m.ready) return;
      if (m.id == null) { if (m.error) console.error('[db-writer] fire-and-forget failed:', m.error, m.sql); return; }
      const w = this._writeWaiters.get(m.id);
      if (!w) return;
      this._writeWaiters.delete(m.id);
      m.error ? w.reject(new Error(m.error)) : w.resolve(m.result);
    });
    this._worker.on('error', (e) => console.error('[db-writer] worker crashed:', e));
  }

  // Fire-and-forget write on the worker (no result awaited). Accepts a prepared
  // statement (its `.source` SQL is reused) or a raw SQL string.
  _w(stmtOrSql, params) {
    const sql = typeof stmtOrSql === 'string' ? stmtOrSql : stmtOrSql.source;
    this._worker.postMessage({ kind: 'run', sql, params });
  }

  // Await a write on the worker, resolving to { lastInsertRowid, changes }.
  // Used where the caller needs the row id (share) or the constraint error.
  _wAwait(stmtOrSql, params) {
    const sql = typeof stmtOrSql === 'string' ? stmtOrSql : stmtOrSql.source;
    const id = ++this._writeSeq;
    return new Promise((resolve, reject) => {
      this._writeWaiters.set(id, { resolve, reject });
      this._worker.postMessage({ id, kind: 'run', sql, params });
    });
  }

  _wBatchAwait(ops) {
    const id = ++this._writeSeq;
    return new Promise((resolve, reject) => {
      this._writeWaiters.set(id, { resolve, reject });
      this._worker.postMessage({
        id,
        kind: 'batch',
        ops: ops.map(op => ({
          sql: typeof op.stmtOrSql === 'string' ? op.stmtOrSql : op.stmtOrSql.source,
          params: op.params || [],
        })),
      });
    });
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
      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
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
          CASE
            WHEN new.type = 'activity' THEN trim(
              coalesce(new.text, '') || ' ' ||
              coalesce(json_extract(new.metadata, '$.tool'), '') || ' ' ||
              coalesce(json_extract(new.metadata, '$.description'), '') || ' ' ||
              coalesce(json_extract(new.metadata, '$.input.description'), '') || ' ' ||
              coalesce(json_extract(new.metadata, '$.arg'), '') || ' ' ||
              coalesce(json_extract(new.metadata, '$.input.command'), '') || ' ' ||
              coalesce(json_extract(new.metadata, '$.prettyResult'), '')
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
              coalesce(json_extract(old.metadata, '$.input.command'), '') || ' ' ||
              coalesce(json_extract(old.metadata, '$.prettyResult'), '')
            )
            ELSE old.text
          END
        );
      END;
      CREATE TRIGGER events_au AFTER UPDATE OF type, text, metadata ON events BEGIN
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
              coalesce(json_extract(old.metadata, '$.input.command'), '') || ' ' ||
              coalesce(json_extract(old.metadata, '$.prettyResult'), '')
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
              coalesce(json_extract(new.metadata, '$.input.command'), '') || ' ' ||
              coalesce(json_extract(new.metadata, '$.prettyResult'), '')
            )
            ELSE new.text
          END
        );
      END;

      -- Materialized agent state (cache, rebuilt from events)
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        friendly_name TEXT,
        pretty_name TEXT,              -- JSON string/array or plain string, display-only
        tmux_session TEXT,
        session_id TEXT,
        session_ids TEXT,             -- JSON array
        cwd TEXT,
        labels TEXT,                  -- JSON array
        registered_at TEXT,
        last_seen TEXT,
        dead INTEGER DEFAULT 0,
        human INTEGER DEFAULT 0,
        is_manager INTEGER DEFAULT 0,
        metadata TEXT,                -- JSON blob for extra fields
        machine_id TEXT,              -- which fleet-daemon machine owns this agent (NULL = unknown)
        env_name TEXT,                -- daemon config lane on that machine
        daemon_key TEXT,              -- scoped daemon registry key that owns this agent/session
        resume_id TEXT                -- durable harness resume handle (codex rollout id, claude session id, ...)
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
    // Add machine_id column to agents if missing (existing DBs predate it).
    const agentCols = this.db.prepare("PRAGMA table_info(agents)").all();
    if (!agentCols.some(c => c.name === 'machine_id')) {
      this.db.exec("ALTER TABLE agents ADD COLUMN machine_id TEXT");
    }
    if (!agentCols.some(c => c.name === 'env_name')) {
      this.db.exec("ALTER TABLE agents ADD COLUMN env_name TEXT");
    }
    if (!agentCols.some(c => c.name === 'daemon_key')) {
      this.db.exec("ALTER TABLE agents ADD COLUMN daemon_key TEXT");
    }
    if (!agentCols.some(c => c.name === 'resume_id')) {
      this.db.exec("ALTER TABLE agents ADD COLUMN resume_id TEXT");
    }
    if (!agentCols.some(c => c.name === 'pretty_name')) {
      this.db.exec("ALTER TABLE agents ADD COLUMN pretty_name TEXT");
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agents_missing_pretty_name
      ON agents(friendly_name)
      WHERE friendly_name IS NOT NULL
        AND friendly_name != ''
        AND (pretty_name IS NULL OR pretty_name = '')
    `);
    this.db.exec(`
      UPDATE agents
      SET daemon_key = machine_id || ':' || env_name
      WHERE daemon_key IS NULL
        AND machine_id IS NOT NULL AND machine_id != ''
        AND env_name IS NOT NULL AND env_name != ''
    `);
    const backfillPrettyNameRows = this.db.prepare(`
      SELECT id, friendly_name FROM agents
      WHERE friendly_name IS NOT NULL
        AND friendly_name != ''
        AND (pretty_name IS NULL OR pretty_name = '')
    `).all();
    if (backfillPrettyNameRows.length) {
      const setPrettyName = this.db.prepare('UPDATE agents SET pretty_name = ? WHERE id = ?');
      this.db.transaction((rows) => {
        for (const row of rows) {
          setPrettyName.run(serializePrettyName(prettyNameForFriendlyName(row.friendly_name)), row.id);
        }
      })(backfillPrettyNameRows);
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_agents_machine_env ON agents(machine_id, env_name)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_agents_daemon_key ON agents(daemon_key)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_daemon_registry_status ON daemon_registry(status, machine_id, env_name)");

    const taskCols = this.db.prepare("PRAGMA table_info(tasks)").all();
    if (!taskCols.some(c => c.name === 'updated_at')) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN updated_at TEXT");
      this.db.exec("UPDATE tasks SET updated_at = COALESCE(completed_at, last_checked, delegated_at) WHERE updated_at IS NULL");
    }

    // Add lineage columns to agents if missing
    if (!agentCols.some(c => c.name === 'lineage_id')) {
      this.db.exec("ALTER TABLE agents ADD COLUMN lineage_id TEXT");
    }
    if (!agentCols.some(c => c.name === 'phase')) {
      this.db.exec("ALTER TABLE agents ADD COLUMN phase TEXT");
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

      CREATE TABLE IF NOT EXISTS lineage_phase_log (
        lineage_id TEXT,
        fleet_id TEXT,
        phase TEXT,
        entered_at INTEGER,
        exited_at INTEGER,
        PRIMARY KEY (lineage_id, fleet_id, entered_at)
      );

      CREATE INDEX IF NOT EXISTS idx_lineage_phase_log_lineage ON lineage_phase_log(lineage_id);
      CREATE INDEX IF NOT EXISTS idx_lineage_phase_log_fleet ON lineage_phase_log(fleet_id);
      CREATE INDEX IF NOT EXISTS idx_agents_lineage ON agents(lineage_id);
    `);

    // Dedupe + enforce unique friendly_name among live agents.
    // Step 1: resolve existing duplicates — keep the most-recently-seen, mark the rest dead.
    const dupes = this.db.prepare(`
      SELECT friendly_name, COUNT(*) AS cnt FROM agents
      WHERE dead = 0 AND friendly_name IS NOT NULL
      GROUP BY friendly_name HAVING cnt > 1
    `).all();
    if (dupes.length > 0) {
      this.db.transaction(() => {
        for (const { friendly_name } of dupes) {
          const rows = this.db.prepare(
            'SELECT id, last_seen FROM agents WHERE friendly_name = ? AND dead = 0 ORDER BY last_seen DESC'
          ).all(friendly_name);
          // Keep the first (most recent), mark the rest dead
          for (let i = 1; i < rows.length; i++) {
            this.db.prepare('UPDATE agents SET dead = 1 WHERE id = ?').run(rows[i].id);
          }
        }
      })();
      console.log(`[fleet-store] deduplicated friendly_names: ${dupes.map(d => d.friendly_name).join(', ')}`);
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
                coalesce(json_extract(new.metadata, '$.input.command'), '') || ' ' ||
                coalesce(json_extract(new.metadata, '$.prettyResult'), '')
              )
              ELSE new.text
            END
          );
        END;
        CREATE TRIGGER events_ad AFTER DELETE ON events BEGIN
          INSERT INTO events_fts(events_fts, rowid, text) VALUES('delete', old.id, old.text);
        END;
        CREATE TRIGGER events_au AFTER UPDATE ON events BEGIN
          INSERT INTO events_fts(events_fts, rowid, text) VALUES('delete', old.id, old.text);
          INSERT INTO events_fts(rowid, text) VALUES (
            new.id,
            CASE
              WHEN new.type = 'activity' THEN trim(
                coalesce(new.text, '') || ' ' ||
                coalesce(json_extract(new.metadata, '$.tool'), '') || ' ' ||
                coalesce(json_extract(new.metadata, '$.description'), '') || ' ' ||
                coalesce(json_extract(new.metadata, '$.input.description'), '') || ' ' ||
                coalesce(json_extract(new.metadata, '$.arg'), '') || ' ' ||
                coalesce(json_extract(new.metadata, '$.input.command'), '') || ' ' ||
                coalesce(json_extract(new.metadata, '$.prettyResult'), '')
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

    // Backfill events_fts for existing events (one-time; trigger handles new inserts).
    // Use FTS5 rebuild to populate the index from the content table.
    // Cheap existence check, NOT COUNT(*): FTS5 has no maintained row count, so
    // COUNT(*) scans the whole index — O(events), ~seconds on a large DB, every
    // startup. We only need to know whether the index is EMPTY (one-time backfill).
    const ftsHasRows = this.db.prepare("SELECT 1 FROM events_fts LIMIT 1").get();
    if (!ftsHasRows) {
      this.db.exec("INSERT INTO events_fts(events_fts) VALUES ('rebuild')");
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
    //   SELECT * FROM agents WHERE machine_id=? AND dead=0    → idx_agents_machine_alive
    //   SELECT * FROM agents WHERE dead=0 AND id!=?           → idx_agents_alive
    //   SELECT * FROM agents WHERE friendly_name=?            → (already covered by idx_agents_live_name for dead=0)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agents_last_seen ON agents(last_seen DESC);
      CREATE INDEX IF NOT EXISTS idx_agents_alive ON agents(dead, last_seen DESC);
      CREATE INDEX IF NOT EXISTS idx_agents_machine_env_alive ON agents(machine_id, env_name, dead);
      CREATE INDEX IF NOT EXISTS idx_agents_friendly_name ON agents(friendly_name);
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

      -- friendly_name changed (incl. →NULL when aging out, or NULL→ on resurrect):
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
    // nothing. Runs on the writer worker, off the main loop.
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

    this._getUnread = this.db.prepare(`
      SELECT ${this._EVTE} FROM events e
      JOIN unread u ON u.event_id = e.id
      WHERE u.to_id = ? AND u.read = 0
      ORDER BY e.timestamp ASC
    `);

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
      INSERT INTO agents (id, friendly_name, pretty_name, tmux_session, session_id, session_ids, cwd, labels, registered_at, last_seen, dead, human, is_manager, metadata, machine_id, env_name, daemon_key, resume_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        friendly_name = COALESCE(excluded.friendly_name, agents.friendly_name),
        pretty_name = COALESCE(excluded.pretty_name, agents.pretty_name),
        tmux_session = COALESCE(excluded.tmux_session, agents.tmux_session),
        session_id = COALESCE(excluded.session_id, agents.session_id),
        session_ids = COALESCE(excluded.session_ids, agents.session_ids),
        cwd = COALESCE(excluded.cwd, agents.cwd),
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
        END,
        machine_id = COALESCE(excluded.machine_id, agents.machine_id),
        env_name = COALESCE(excluded.env_name, agents.env_name),
        daemon_key = COALESCE(excluded.daemon_key, agents.daemon_key),
        resume_id = COALESCE(excluded.resume_id, agents.resume_id)
    `);

    const AGENT_SELECT = 'agents.*, lineages.friendly_name AS lineage_name';
    const AGENT_JOIN = 'FROM agents LEFT JOIN lineages ON lineages.id = agents.lineage_id';
    this._getAgent = this.db.prepare(`SELECT ${AGENT_SELECT} ${AGENT_JOIN} WHERE agents.id = ?`);
    this._getAgentsByDaemonKey = this.db.prepare(`SELECT ${AGENT_SELECT} ${AGENT_JOIN} WHERE agents.daemon_key = ? AND agents.dead = 0`);
    this._getAgentByName = this.db.prepare(`SELECT ${AGENT_SELECT} ${AGENT_JOIN} WHERE agents.friendly_name = ?`);
    this._getLiveAgentsByFriendlyName = this.db.prepare(`SELECT ${AGENT_SELECT} ${AGENT_JOIN} WHERE agents.dead = 0 AND agents.friendly_name = ?`);
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

    // Name provenance: span covering an instant (newest qualifying span wins).
    this._nameAtStmt = this.db.prepare(`
      SELECT friendly_name FROM name_history
      WHERE fleet_id = ? AND from_ts <= ? AND (to_ts IS NULL OR to_ts > ?)
      ORDER BY from_ts DESC LIMIT 1
    `);
    this._nameEarliestStmt = this.db.prepare(`
      SELECT friendly_name, from_ts FROM name_history WHERE fleet_id = ?
      ORDER BY from_ts ASC LIMIT 1
    `);
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
    this._getAliveAgents = this.db.prepare(`SELECT ${AGENT_SELECT} ${AGENT_JOIN} WHERE agents.dead = 0 ORDER BY agents.last_seen DESC`);
    this._getAliveAgentsPage = this.db.prepare(`
      SELECT ${AGENT_SELECT} ${AGENT_JOIN}
      WHERE agents.dead = 0
        AND (agents.last_seen < @lastSeen OR (agents.last_seen = @lastSeen AND agents.id < @id))
      ORDER BY agents.last_seen DESC, agents.id DESC
      LIMIT @limit
    `);
    // id→friendly_name only — for labeling chat history without hydrating all
    // ~1300 agents (parsing labels/metadata/session JSON per row).
    this._getAgentNames = this.db.prepare(`SELECT id, friendly_name FROM agents`);
    this._deleteAgent = this.db.prepare('DELETE FROM agents WHERE id = ?');
    this._updateAgentLastSeen = this.db.prepare('UPDATE agents SET last_seen = ?, dead = 0 WHERE id = ?');
    this._markAgentDead = this.db.prepare('UPDATE agents SET dead = 1 WHERE id = ?');

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
    this._getTaskByAgent = this.db.prepare("SELECT * FROM tasks WHERE agent = ? AND status NOT IN ('done', 'retracted') ORDER BY delegated_at DESC LIMIT 1");
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
    this._upsertSharedDoc = this.db.prepare(`
      INSERT INTO shared_docs (doc, path, title, agent, ephemeral, shared_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(doc) DO UPDATE SET
        path = COALESCE(excluded.path, shared_docs.path),
        title = COALESCE(excluded.title, shared_docs.title),
        agent = COALESCE(excluded.agent, shared_docs.agent),
        ephemeral = excluded.ephemeral,
        shared_at = COALESCE(shared_docs.shared_at, excluded.shared_at),
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
    this._getSubscription = this.db.prepare('SELECT * FROM subscriptions WHERE subscription_id = ?');
    this._deleteSubscription = this.db.prepare('DELETE FROM subscriptions WHERE subscription_id = ?');

    // Event queries for chat history
    const E = this._EVT;
    this._queryEventsBefore = this.db.prepare(`
      SELECT ${E} FROM events WHERE timestamp < ? ORDER BY timestamp DESC LIMIT ?
    `);
    this._queryEventsLatest = this.db.prepare(`
      SELECT ${E} FROM events ORDER BY timestamp DESC LIMIT ?
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
    const meta = event.metadata ? JSON.stringify(event.metadata) : null;

    // The events INSERT runs on the writer worker: a slow FTS merge here never
    // freezes the main event loop. We await it because we need the real row id.
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

    // Maintain agents.last_active incrementally (writer worker, ordered after
    // the insert) so getAllAgents never scans events.
    if (event.from || event.to) {
      this._w(this._updateAgentLastActive, [ts, ts, event.from || null, event.to || null]);
    }

    // Track unread before returning so callers that immediately retract can
    // operate on a real mailbox row instead of racing the writer worker.
    if (event.unread !== false && event.to && (event.type === 'chat' || event.type === 'delegate')) {
      await this._wAwait(this._insertUnread, [eventId, event.to]);
      // Also mark unread for CC recipients
      const cc = event.metadata?.cc;
      if (cc && Array.isArray(cc)) {
        for (const ccId of cc) {
          await this._wAwait(this._insertUnread, [eventId, ccId]);
        }
      }
    }

    const inserted = {
      id: Number(eventId),
      type: event.type,
      timestamp: ts,
      from_id: event.from || null,
      to_id: event.to || null,
      text: event.text || null,
      metadata: event.metadata || null,
      task_id: event.taskId || null,
      agent_id: event.agentId || null,
      read: false,
    };

    // Wiretap subscriptions are user-visible message notifications. Activity
    // and delivery bookkeeping are high-volume telemetry; routing them through
    // every subscriber creates notification storms and event-loop lag.
    if (WIRETAP_EVENT_TYPES.has(inserted.type) && inserted.from_id && inserted.to_id) {
      const wiretapAgents = this.resolveWiretaps(inserted.from_id, inserted.to_id, inserted.type)
      if (wiretapAgents.length > 0) {
        // metadata can arrive as an unparsed JSON string (e.g. daemon_warning
        // events); setting a property on a string primitive throws. Coerce to a
        // plain object first.
        let meta = inserted.metadata
        if (typeof meta === 'string') {
          try { meta = JSON.parse(meta) } catch { meta = {} }
        }
        if (!meta || typeof meta !== 'object') meta = {}
        meta.wiretap_cc = wiretapAgents
        inserted.metadata = meta
      }
    }

    // Notify listeners (SSE broadcast)
    if (notify) {
      for (const fn of this._listeners) {
        try { fn(inserted); } catch {}
      }
    }

    return inserted;
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

  async share(event) {
    return this._insertEventRecord(event, { notify: true });
  }

  // ---- Convenience write methods (all call share() internally) ----

  chat(from, to, text, metadata, timestamp) {
    return this.share({ type: 'chat', from, to, text, metadata, unread: true, timestamp });
  }

  delegate(from, to, taskId, description, metadata) {
    return this.share({
      type: 'delegate', from, to, text: description,
      taskId, metadata, unread: true, // a delegate wakes its recipient (counts as awake)
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
    const rows = this._getAllAgents.all().map(r => this._hydrateAgent(r));
    const ids = new Set(rows.map(a => a.id));
    const aliveIds = new Set(rows.filter(a => !a.dead).map(a => a.id));
    this._agentRegistry.bulk(s => {
      for (const a of rows) s.upsert(a);
      for (const a of s.all()) {
        if (!ids.has(a.id)) s.remove(a.id);
      }
    });
    this._aliveAgentRegistry.bulk(s => {
      for (const a of rows) {
        if (a.dead) s.remove(a.id);
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
    if (agent.dead) this._aliveAgentRegistry.remove(id);
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

  upsertAgent(agent) {
    try {
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
      const daemonKey = agent.daemon_key || (agent.machine_id && agent.env_name ? `${agent.machine_id}:${agent.env_name}` : null);
      this._upsertAgent.run(
        agent.id,
        agent.friendly_name || null,
        serializePrettyName(agent.pretty_name),
        agent.tmux_session || null,
        agent.session_id || null,
        agent.session_ids ? JSON.stringify(agent.session_ids) : null,
        agent.cwd || null,
        agent.labels ? JSON.stringify(agent.labels) : null,
        agent.registered_at || null,
        agent.last_seen || new Date().toISOString(),
        agent.dead ? 1 : 0,
        agent.human ? 1 : 0,
        agent.is_manager ? 1 : 0,
        agent.metadata ? JSON.stringify(agent.metadata) : null,
        agent.machine_id || null,
        agent.env_name || null,
        daemonKey,
        agent.resume_id || null
      );
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
    return this._getAgentsByDaemonKey.all(daemonKey).map(r => this._hydrateAgent(r));
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
    return row ? this._hydrateAgent(row) : null;
  }

  // ---- Name provenance ----

  // The friendly_name this agent held at instant `ts` (ISO string). Returns the
  // span covering [from_ts, to_ts); a NULL friendly_name (nameless span) yields
  // null. If `ts` predates all history, falls back to the earliest known name.
  // If the agent has no history at all, falls back to its current friendly_name.
  // The ID is always the durable handle — callers pair this name WITH the id.
  nameAt(fleetId, ts) {
    if (!fleetId) return null;
    if (ts) {
      const span = this._nameAtStmt.get(fleetId, ts, ts);
      if (span) return span.friendly_name; // may be null (nameless span)
      // No covering span. Two cases:
      const earliest = this._nameEarliestStmt.get(fleetId);
      if (earliest) {
        // (a) ts predates all recorded history → nearest earlier-known name.
        if (ts < earliest.from_ts) return earliest.friendly_name;
        // (b) ts is past the last span → the agent is currently nameless
        //     (aged out). Genuinely no name then; the id stays reachable.
        return null;
      }
    }
    // No history at all for this agent → current cache.
    const a = this._getAgent.get(fleetId);
    return a ? a.friendly_name : null;
  }

  // Full span list for an agent, oldest first. Used for the thread-header
  // provenance trail (e.g. "conc4 → concentration → (current)").
  nameHistory(fleetId) {
    if (!fleetId) return [];
    return this._nameHistoryStmt.all(fleetId);
  }

  // One-time seed so existing agents (registered before the triggers existed)
  // resolve correctly. Idempotent: skipped once the table has any rows. Seeds
  // from two sources, richest first:
  //   1. lineage_phase_log — every phase an agent held maps to nameForPhase(base,
  //      phase) over [entered_at, exited_at); the open phase becomes the current
  //      span. This recovers dawn/day/dusk/night rotation history.
  //   2. current friendly_name — for every named agent with no span yet, open a
  //      span from registered_at so nameAt() at least returns the current name.
  // Pre-history events (before from_ts) fall back to the earliest known name.
  _backfillNameHistory() {
    const has = this.db.prepare('SELECT 1 FROM name_history LIMIT 1').get();
    if (has) return;
    const msToIso = (ms) => (ms ? new Date(Number(ms)).toISOString() : null);
    const lineageBase = new Map();
    const baseOf = (lid) => {
      if (!lid) return null;
      if (!lineageBase.has(lid)) {
        const row = this.db.prepare('SELECT friendly_name FROM lineages WHERE id = ?').get(lid);
        lineageBase.set(lid, row?.friendly_name || null);
      }
      return lineageBase.get(lid);
    };
    const insert = this.db.prepare(
      'INSERT INTO name_history (fleet_id, friendly_name, from_ts, to_ts) VALUES (?, ?, ?, ?)'
    );
    const seeded = new Set(); // fleet_ids that got at least one span
    let spans = 0;
    // Humans don't rotate through lineage phases; any phase-log rows for a human
    // are test noise. Excluding them keeps a human's own old messages tagged with
    // their stable name (e.g. "skip"), not a spurious "skip:day".
    const humanIds = new Set(
      this.db.prepare('SELECT id FROM agents WHERE human = 1').all().map(r => r.id)
    );
    this.db.transaction(() => {
      // 1. Phase-log replay (skip humans).
      const phaseRows = this.db.prepare(
        'SELECT lineage_id, fleet_id, phase, entered_at, exited_at FROM lineage_phase_log ORDER BY entered_at'
      ).all();
      for (const r of phaseRows) {
        if (humanIds.has(r.fleet_id)) continue;
        const base = baseOf(r.lineage_id);
        if (!base) continue;
        const from = msToIso(r.entered_at);
        if (!from) continue;
        const nm = r.phase ? nameForPhase(base, r.phase) : null;
        insert.run(r.fleet_id, nm, from, msToIso(r.exited_at));
        seeded.add(r.fleet_id);
        spans++;
      }
      // 2. Reconcile every agent's open span against its CURRENT friendly_name.
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

    // Lineage:phase addressing (e.g. "writing-A:dawn", "writing-A:dusk")
    const colonIdx = query.indexOf(':');
    if (colonIdx > 0 && !query.startsWith('fleet:')) {
      const lineageName = query.slice(0, colonIdx);
      const phase = query.slice(colonIdx + 1);
      if (ALL_PHASES.includes(phase)) {
        return this.findAgentByLineagePhase(lineageName, phase);
      }
    }

    let row = this._getAgent.get(query);
    if (!row) {
      // Name lookup — liveness-aware, NEVER throws (Skip's spec S1 / G.22 /
      // F.16, scratch/registration-rules.md). Among non-dead agents holding
      // this name, prefer the actually-live holder (daemon oracle), else the
      // most-recently-active. A dead/corrupted namesake must never shadow the
      // live holder — that shadowing was the wake bug. The old code THREW on a
      // >1 collision, which killed the wake outright; resolving deterministically
      // to the live holder is the fix. Falls back to any row (incl. dead) only
      // when no live agent holds the name, so resurrect-by-name still resolves.
      const nameRows = this.db.prepare('SELECT * FROM agents WHERE friendly_name = ? AND dead = 0').all(query);
      row = nameRows.length > 0 ? this._pickLiveHolder(nameRows) : this._getAgentByName.get(query);
    }
    if (!row) {
      // A bare lineage name normally matches its dawn member directly (that
      // member's name IS the base). Fall back to the day member if the dawn
      // slot is currently empty.
      const lineage = this.getLineage(query);
      if (lineage) {
        const day = this.getLineageDay(lineage.id);
        if (day) return day;
      }
    }
    if (!row) {
      // Search by session_id
      row = this.db.prepare('SELECT * FROM agents WHERE session_id = ?').get(query);
    }
    return row ? this._hydrateAgent(row) : null;
  }

  // Among non-dead rows that share a friendly name, pick the live-holder-wins /
  // most-recently-active one (Skip's spec G.22 / F.16). An actually-live holder
  // (daemon liveness oracle) beats a hibernating one; within a liveness tier the
  // most recent last_seen wins; last_active and finally row order break further
  // ties. This is the S1 resolver: wake reaches the live agent by liveness, not
  // by an arbitrary name-grep. Deterministic and total — never throws (the old
  // collision throw broke waking the live holder whenever a dead/corrupted
  // namesake was still marked alive). Takes raw rows; caller hydrates the result.
  _pickLiveHolder(rows) {
    if (rows.length === 1) return rows[0];
    const ts = (v) => {
      if (v == null) return 0;
      const n = new Date(v).getTime();
      return Number.isFinite(n) ? n : 0;
    };
    const awake = (r) => (this._isLiveOracle ? !!this._isLiveOracle(r.id) : false);
    return rows.slice().sort((a, b) => {
      const liveDelta = (awake(b) ? 1 : 0) - (awake(a) ? 1 : 0);
      if (liveDelta !== 0) return liveDelta;
      const seenDelta = ts(b.last_seen) - ts(a.last_seen);
      if (seenDelta !== 0) return seenDelta;
      return ts(b.last_active) - ts(a.last_active);
    })[0];
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
      SELECT COALESCE(machine_id, '(none)') AS machine_id, COUNT(*) AS count
      FROM agents
      WHERE dead = 0
      GROUP BY COALESCE(machine_id, '(none)')
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
    return rows.map(row => this._hydrateAgent(row));
  }

  getLiveAgentsByFriendlyName(friendlyName) {
    if (!friendlyName) return [];
    return this._getLiveAgentsByFriendlyName.all(String(friendlyName)).map(row => this._hydrateAgent(row));
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
    const page = rows.slice(0, size).map(row => this._hydrateAgent(row));
    const tail = page[page.length - 1];
    const nextCursor = hasMore && tail
      ? Buffer.from(JSON.stringify({ lastSeen: tail.last_seen, id: tail.id })).toString('base64url')
      : null;
    return { agents: page, nextCursor };
  }

  removeAgent(id) {
    this._deleteAgent.run(id);
    this._bustAgentsCache();
    this._syncAgentRegistry(id);
  }

  updateHeartbeat(id) {
    const _t0 = Date.now();
    this._updateAgentLastSeen.run(new Date().toISOString(), id);
    this._syncAgentRegistry(id);
    const _dt = Date.now() - _t0; if (_dt > 100) process.stderr.write(`[hb-slow] ${_dt}ms id=${id}\n`);
  }

  markDead(id) {
    this._markAgentDead.run(id);
    this._bustAgentsCache();
    this._syncAgentRegistry(id);
  }

  async renameAgentFriendlyName(id, friendlyName, { actorId = null, reason = 'rename' } = {}) {
    const agent = this._getAgent.get(id);
    if (!agent) throw new Error('agent not found');
    const oldName = agent.friendly_name || null;
    const newName = friendlyName || null;
    this.db.transaction(() => {
      this.db.prepare('UPDATE agents SET friendly_name = ?, pretty_name = ? WHERE id = ?')
        .run(newName, serializePrettyName(prettyNameForFriendlyName(newName)), id);
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

  // Liveness oracle: optional function (agentId) => boolean.
  // Installed by the server. Returns true if the server currently believes the
  // agent is live, based on login, activity, thinking/status, and explicit wake
  // probes.
  // No oracle installed → no agent reports awake (all hibernating). The
  // server installs the oracle during normal boot, so this is only a cold-start
  // transient.
  setLivenessOracle(fn) {
    this._isLiveOracle = fn;
    this._bustAgentsCache();
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

  // The lineage's base name — the bare (dawn) name its triple is built on.
  _lineageBase(lineageId) {
    return this.db.prepare('SELECT friendly_name FROM lineages WHERE id = ?').get(lineageId)?.friendly_name || null;
  }

  // The live, named members of a lineage. Phase is read off each name on the
  // client; rotated-off members have a NULL name and are excluded here.
  getLineageRoster(lineageId) {
    return this.db.prepare(
      "SELECT agents.*, lineages.friendly_name AS lineage_name FROM agents LEFT JOIN lineages ON lineages.id = agents.lineage_id WHERE agents.lineage_id = ? AND agents.friendly_name IS NOT NULL AND agents.dead = 0"
    ).all(lineageId).map(r => this._hydrateAgent(r));
  }

  // The day (manager) member — the one whose name is "<base>:day".
  getLineageDay(lineageId) {
    const base = this._lineageBase(lineageId);
    if (!base) return null;
    const row = this.db.prepare(
      "SELECT agents.*, lineages.friendly_name AS lineage_name FROM agents LEFT JOIN lineages ON lineages.id = agents.lineage_id WHERE agents.lineage_id = ? AND agents.friendly_name = ? AND agents.dead = 0"
    ).get(lineageId, nameForPhase(base, 'day'));
    return row ? this._hydrateAgent(row) : null;
  }

  // Assign an agent into a lineage at a phase. Phase isn't stored — it's the
  // name: the agent is renamed to "<base>" (dawn) / "<base>:day" / "<base>:dusk".
  assignPhase(agentId, lineageId, phase) {
    const now = Date.now();
    const base = this._lineageBase(lineageId);
    // No base name = nothing to name the agent. Attach it to the lineage but
    // leave its existing name alone rather than NULLing it — a NULL name on a
    // live agent is exactly the nameless phantom row we must never create.
    if (!base) {
      this.db.transaction(() => {
        this.db.prepare('UPDATE agents SET lineage_id = ? WHERE id = ?').run(lineageId, agentId);
        this.db.prepare(
          'INSERT INTO lineage_phase_log (lineage_id, fleet_id, phase, entered_at) VALUES (?, ?, ?, ?)'
        ).run(lineageId, agentId, phase, now);
      })();
      this._bustAgentsCache();
      this._syncAgentRegistry(agentId);
      return;
    }
    this.db.transaction(() => {
      const nextName = nameForPhase(base, phase);
      this.db.prepare('UPDATE agents SET lineage_id = ?, friendly_name = ?, pretty_name = ? WHERE id = ?')
        .run(lineageId, nextName, serializePrettyName(prettyNameForFriendlyName(nextName)), agentId);
      this.db.prepare(
        'INSERT INTO lineage_phase_log (lineage_id, fleet_id, phase, entered_at) VALUES (?, ?, ?, ?)'
      ).run(lineageId, agentId, phase, now);
    })();
    this._bustAgentsCache();
    this._syncAgentRegistry(agentId);
  }

  retireFromLineage(agentId) {
    const now = Date.now();
    this.db.transaction(() => {
      const agent = this._getAgent.get(agentId);
      if (!agent || !agent.lineage_id) return;
      this.db.prepare(
        'UPDATE lineage_phase_log SET exited_at = ? WHERE fleet_id = ? AND exited_at IS NULL'
      ).run(now, agentId);
      this.db.prepare('UPDATE agents SET lineage_id = NULL WHERE id = ?')
        .run(agentId);
    })();
    this._bustAgentsCache();
    this._syncAgentRegistry(agentId);
  }

  // Resurrect a dead agent. If it was rotated out of a lineage — i.e. it is
  // still attached to a lineage but lost its slot name (friendly_name NULL) when
  // it aged out — bring it back as a zombie: in the lineage, out of rotation,
  // named "<base>:zombie". A plain dead agent (no lineage, or still named) just
  // comes back as-is. Returns { ok, zombie, name? }.
  resurrectAsZombie(agentId) {
    const result = this.db.transaction(() => {
      const agent = this._getAgent.get(agentId);
      if (!agent) return { ok: false, reason: 'not found' };
      this.db.prepare('UPDATE agents SET dead = 0 WHERE id = ?').run(agentId);
      if (!agent.lineage_id || agent.friendly_name) return { ok: true, zombie: false };
      const base = this._lineageBase(agent.lineage_id);
      if (!base) return { ok: true, zombie: false };
      const zombieName = nameForPhase(base, 'zombie');
      // Global friendly_name uniqueness: if a live agent OUTSIDE this agent
      // already holds zombieName, bail rather than mint a cross-lineage duplicate.
      const nameHeldByOther = this.db.prepare(
        'SELECT id FROM agents WHERE friendly_name = ? AND dead = 0 AND id != ?'
      ).get(zombieName, agentId);
      if (nameHeldByOther) return { ok: false, reason: 'zombie name held by another live agent' };
      const now = Date.now();
      // At most one zombie per lineage: raising this one ages out any existing
      // live zombie (name off, marked dead), freeing the name for this agent.
      const existing = this.db.prepare(
        'SELECT id FROM agents WHERE lineage_id = ? AND friendly_name = ? AND dead = 0 AND id != ?'
      ).all(agent.lineage_id, zombieName, agentId);
      for (const z of existing) {
        this.db.prepare('UPDATE lineage_phase_log SET exited_at = ? WHERE fleet_id = ? AND exited_at IS NULL').run(now, z.id);
        this.db.prepare('UPDATE agents SET friendly_name = NULL, pretty_name = NULL, dead = 1 WHERE id = ?').run(z.id);
      }
      this.db.prepare('UPDATE agents SET friendly_name = ?, pretty_name = ? WHERE id = ?')
        .run(zombieName, serializePrettyName(prettyNameForFriendlyName(zombieName)), agentId);
      const prev = this.db.prepare(
        'SELECT MAX(entered_at) AS m FROM lineage_phase_log WHERE lineage_id = ? AND fleet_id = ?'
      ).get(agent.lineage_id, agentId);
      const ts = Math.max(now, (prev?.m || 0) + 1);
      this.db.prepare(
        'INSERT INTO lineage_phase_log (lineage_id, fleet_id, phase, entered_at) VALUES (?, ?, ?, ?)'
      ).run(agent.lineage_id, agentId, 'zombie', ts);
      return { ok: true, zombie: true, name: zombieName };
    })();
    this._bustAgentsCache();
    this._reloadAgentRegistry();
    return result;
  }

  // Move an agent to a different phase within its lineage = rename it.
  transitionPhase(agentId, newPhase) {
    const now = Date.now();
    this.db.transaction(() => {
      const agent = this._getAgent.get(agentId);
      if (!agent || !agent.lineage_id) return;
      const base = this._lineageBase(agent.lineage_id);
      // No base name = nothing to rename to. Bail rather than NULLing the name,
      // which would leave an alive-but-nameless phantom row off any lineage.
      if (!base) return;
      const nextName = nameForPhase(base, newPhase);
      // Global friendly_name uniqueness (the "two chiefs" bug): a name may
      // belong to at most one non-dead agent. If a live agent OUTSIDE this
      // lineage already holds nextName, bail rather than mint a duplicate —
      // same safety stance as the "bail rather than NULL" guard above. The
      // per-lineage free happens in the rotation paths; this is the global
      // backstop the lineage paths were missing.
      const nameHeldByOther = this.db.prepare(
        'SELECT id FROM agents WHERE friendly_name = ? AND dead = 0 AND id != ?'
      ).get(nextName, agentId);
      if (nameHeldByOther) return;
      this.db.prepare(
        'UPDATE lineage_phase_log SET exited_at = ? WHERE fleet_id = ? AND exited_at IS NULL'
      ).run(now, agentId);
      this.db.prepare('UPDATE agents SET friendly_name = ?, pretty_name = ? WHERE id = ?')
        .run(nextName, serializePrettyName(prettyNameForFriendlyName(nextName)), agentId);
      this.db.prepare(
        'INSERT INTO lineage_phase_log (lineage_id, fleet_id, phase, entered_at) VALUES (?, ?, ?, ?)'
      ).run(agent.lineage_id, agentId, newPhase, now);
    })();
    this._bustAgentsCache();
    this._syncAgentRegistry(agentId);
  }

  // One rotation of the lineage's name-chain. The incoming agent takes the
  // dawn name (bare base); the existing holders each shift up a rung —
  // dawn → "<base>:day", day → "<base>:dusk", dusk → "<base>:night", and the
  // old night ages OUT OF EXISTENCE: its name rotates off (NULL) and it is
  // marked dead, so it drops off the live roster (all roster queries filter
  // dead = 0) — no nameless phantom row. Its name is preserved in name_history,
  // and it can be brought back later as a zombie (out of rotation) via
  // resurrect. Zombie is NOT assigned here — that phase is reserved for manual
  // resurrection. Direct handoff applies this once; briefing applies it twice.
  rotateLineageIn(lineageId, incomingAgentId) {
    const now = Date.now();
    const base = this._lineageBase(lineageId);
    if (!base) return;
    const dawnName = nameForPhase(base, 'dawn');
    const dayName = nameForPhase(base, 'day');
    const duskName = nameForPhase(base, 'dusk');
    const nightName = nameForPhase(base, 'night');
    // Find the current holder of a given name within this lineage.
    const holder = (name) => this.db.prepare(
      'SELECT id FROM agents WHERE lineage_id = ? AND friendly_name = ? AND dead = 0'
    ).get(lineageId, name)?.id || null;
    const rename = (id, name) => this.db.prepare('UPDATE agents SET friendly_name = ?, pretty_name = ? WHERE id = ?')
      .run(name, serializePrettyName(prettyNameForFriendlyName(name)), id);
    // Ages out of existence: name rotates off (NULL) AND the agent is marked
    // dead, so it drops off the live roster (no nameless phantom row). The name
    // lives on in name_history; resurrect can bring it back as a zombie.
    const retire = (id) => this.db.prepare('UPDATE agents SET friendly_name = NULL, pretty_name = NULL, dead = 1 WHERE id = ?').run(id);
    const exitLog = (id) => this.db.prepare(
      'UPDATE lineage_phase_log SET exited_at = ? WHERE fleet_id = ? AND exited_at IS NULL'
    ).run(now, id);
    const enterLog = (id, phase) => {
      // PK is (lineage_id, fleet_id, entered_at); ms-resolution Date.now() can
      // collide with a prior entry for the same agent under rapid rotation, so
      // force the timestamp strictly past this agent's last entry in the lineage.
      const prev = this.db.prepare(
        'SELECT MAX(entered_at) AS m FROM lineage_phase_log WHERE lineage_id = ? AND fleet_id = ?'
      ).get(lineageId, id);
      const ts = Math.max(now, (prev?.m || 0) + 1);
      this.db.prepare(
        'INSERT INTO lineage_phase_log (lineage_id, fleet_id, phase, entered_at) VALUES (?, ?, ?, ?)'
      ).run(lineageId, id, phase, ts);
    };
    // Resolve holders BEFORE any rename, then apply in an order that frees each
    // name before it's reused: night → retired, dusk → night, day → dusk,
    // dawn → day, in → dawn.
    // Global friendly_name uniqueness: the incoming agent will take dawnName
    // (the bare base). Bail if another live agent outside this agent already
    // holds it — same guard as transitionPhase.
    const dawnNameHeldByOther = this.db.prepare(
      'SELECT id FROM agents WHERE friendly_name = ? AND dead = 0 AND id != ?'
    ).get(dawnName, incomingAgentId);
    if (dawnNameHeldByOther) return;
    const nightId = holder(nightName);
    const duskId = holder(duskName);
    const dayId = holder(dayName);
    const dawnId = holder(dawnName);
    this.db.transaction(() => {
      if (nightId && nightId !== incomingAgentId) {
        exitLog(nightId);
        retire(nightId); // ages out of existence: marked dead, drops off the roster
      }
      if (duskId && duskId !== incomingAgentId) {
        exitLog(duskId);
        rename(duskId, nightName);
        enterLog(duskId, 'night');
      }
      if (dayId && dayId !== incomingAgentId) {
        exitLog(dayId);
        rename(dayId, duskName);
        enterLog(dayId, 'dusk');
      }
      if (dawnId && dawnId !== incomingAgentId) {
        exitLog(dawnId);
        rename(dawnId, dayName);
        enterLog(dawnId, 'day');
      }
      // Incoming enters at dawn (the worker), taking the bare base name and
      // leaving whatever lineage/name it held before.
      exitLog(incomingAgentId);
      this.db.prepare('UPDATE agents SET lineage_id = ?, friendly_name = ?, pretty_name = ? WHERE id = ?')
        .run(lineageId, dawnName, serializePrettyName(prettyNameForFriendlyName(dawnName)), incomingAgentId);
      enterLog(incomingAgentId, 'dawn');
    })();
    this._bustAgentsCache();
    this._reloadAgentRegistry();
  }

  // Free a phase slot so a new agent can be placed there, instead of erroring on
  // "occupied." The current occupant ages one rung toward night, cascading — each
  // occupied rung from the target down pushes its holder into the rung below, and
  // whoever would fall off night ages OUT OF EXISTENCE (name rotates off to NULL
  // AND marked dead, so it drops off the live roster — no nameless phantom row;
  // name preserved in name_history). No-op if the slot is already free. This is
  // the "free the names you need, then place" half of a handoff rotation.
  makeRoomForPhase(lineageId, phase) {
    const base = this._lineageBase(lineageId);
    if (!base) return;
    const ORDER = ['dawn', 'day', 'dusk', 'night'];
    const startIdx = ORDER.indexOf(phase);
    if (startIdx < 0) return;
    const now = Date.now();
    const holder = (name) => this.db.prepare(
      'SELECT id FROM agents WHERE lineage_id = ? AND friendly_name = ? AND dead = 0'
    ).get(lineageId, name)?.id || null;
    const exitLog = (id) => this.db.prepare(
      'UPDATE lineage_phase_log SET exited_at = ? WHERE fleet_id = ? AND exited_at IS NULL'
    ).run(now, id);
    const enterLog = (id, ph) => {
      const prev = this.db.prepare(
        'SELECT MAX(entered_at) AS m FROM lineage_phase_log WHERE lineage_id = ? AND fleet_id = ?'
      ).get(lineageId, id);
      const ts = Math.max(now, (prev?.m || 0) + 1);
      this.db.prepare(
        'INSERT INTO lineage_phase_log (lineage_id, fleet_id, phase, entered_at) VALUES (?, ?, ?, ?)'
      ).run(lineageId, id, ph, ts);
    };
    // Global friendly_name uniqueness: before rotating, verify no target name
    // is held by a live agent outside its current holder (cross-lineage guard).
    for (let i = ORDER.length - 1; i >= startIdx; i--) {
      const id = holder(nameForPhase(base, ORDER[i]));
      if (!id) continue;
      if (i < ORDER.length - 1) {
        const downName = nameForPhase(base, ORDER[i + 1]);
        const nameHeldByOther = this.db.prepare(
          'SELECT id FROM agents WHERE friendly_name = ? AND dead = 0 AND id != ?'
        ).get(downName, id);
        if (nameHeldByOther) return;
      }
    }
    this.db.transaction(() => {
      // Walk bottom-up (night → target): each occupied rung's holder moves into
      // the rung below (already vacated this pass), and the night holder ages out
      // of existence (name → NULL, marked dead, drops off the live roster).
      for (let i = ORDER.length - 1; i >= startIdx; i--) {
        const id = holder(nameForPhase(base, ORDER[i]));
        if (!id) continue;
        exitLog(id);
        if (i === ORDER.length - 1) {
          this.db.prepare('UPDATE agents SET friendly_name = NULL, pretty_name = NULL, dead = 1 WHERE id = ?').run(id);
        } else {
          const downPh = ORDER[i + 1];
          const downName = nameForPhase(base, downPh);
          this.db.prepare('UPDATE agents SET friendly_name = ?, pretty_name = ? WHERE id = ?')
            .run(downName, serializePrettyName(prettyNameForFriendlyName(downName)), id);
          enterLog(id, downPh);
        }
      }
    })();
    this._bustAgentsCache();
    this._reloadAgentRegistry();
  }

  getLineageHistory(lineageId) {
    return this.db.prepare(
      'SELECT * FROM lineage_phase_log WHERE lineage_id = ? ORDER BY entered_at'
    ).all(lineageId);
  }

  getLineageFleetIds(lineageId) {
    const rows = this.db.prepare(
      'SELECT DISTINCT fleet_id FROM lineage_phase_log WHERE lineage_id = ?'
    ).all(lineageId);
    return rows.map(r => r.fleet_id);
  }

  findAgentByLineagePhase(lineageName, phase) {
    const lineage = this.getLineage(lineageName);
    if (!lineage) return null;
    // Phase is the name: "<base>" (dawn) / "<base>:day" / "<base>:dusk".
    const row = this.db.prepare(
      'SELECT agents.*, lineages.friendly_name AS lineage_name FROM agents LEFT JOIN lineages ON lineages.id = agents.lineage_id WHERE agents.lineage_id = ? AND agents.friendly_name = ? AND agents.dead = 0'
    ).get(lineage.id, nameForPhase(lineage.friendly_name, phase));
    return row ? this._hydrateAgent(row) : null;
  }

  _hydrateAgent(row) {
    const lastActive = row.last_active || null
    const metadata = row.metadata ? JSON.parse(row.metadata) : null
    const isAwake = !row.dead && !row.human && this._isLiveOracle
      ? !!this._isLiveOracle(row.id)
      : false
    let status
    if (row.dead) {
      status = 'dead'
    } else if (row.human) {
      const seenAgo = row.last_seen ? Date.now() - new Date(row.last_seen).getTime() : Infinity
      status = seenAgo < 90_000 ? 'human' : 'human-away'
    } else if (metadata?.shell) {
      // A reserved identity with no live process yet — a "shell" created at
      // spawn time so the agent is addressable (dead=0, in the not-dead registry)
      // before it inhabits. It is NOT awake; the agent's own login clears the
      // shell flag (the claim) and flips it to awake.
      status = 'shell'
    } else {
      status = isAwake ? 'awake' : 'hibernating'
    }
    return {
      ...row,
      session_ids: row.session_ids ? JSON.parse(row.session_ids) : [],
      labels: row.labels ? JSON.parse(row.labels) : [],
      dead: !!row.dead,
      human: !!row.human,
      is_manager: !!row.is_manager,
      metadata,
      pretty_name: parsePrettyName(row.pretty_name),
      last_active: lastActive,
      status,
      lineage_id: row.lineage_id || null,
      // No `phase` field — phase is encoded in friendly_name and parsed on the
      // client. lineage_name (the base) is still exposed for lineage search.
      lineage_name: row.lineage_name || null,
    };
  }

  // ---- Task state management ----

  upsertTask(task) {
    const existing = task.id ? this.getTask(task.id) : null;
    const updatedAt = existing
      ? (task.updated_at && task.updated_at !== existing.updated_at ? task.updated_at : new Date().toISOString())
      : (task.updated_at || task.completed_at || task.last_checked || task.delegated_at || new Date().toISOString());
    this._upsertTask.run(
      task.id,
      task.agent,
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
    if (rows.length > 0) return rows[0];
    {
      // Fallback: check if agent has a friendly name, search tasks by that too
      // (handles tasks stored with friendly_name before the fix)
      const agent = this.getAgent(agentId);
      if (agent?.friendly_name) {
        const fallbackRows = this.getActiveTasksByAgent(agent.friendly_name);
        if (fallbackRows.length > 0) return fallbackRows[0];
      }
    }
    return null;
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

  getSharedDocs() {
    return this._getAllSharedDocs.all().map(r => this._hydrateSharedDoc(r));
  }

  getSharedDoc(name) {
    const row = this._getSharedDoc.get(name);
    return row ? this._hydrateSharedDoc(row) : null;
  }

  _hydrateSharedDoc(row) {
    return {
      ...row,
      ephemeral: !!row.ephemeral,
    };
  }

  // ---- Wiretap management ----

  addWiretap(agentId, filter, types) {
    // Filter is a string EXPRESSION (same grammar as chat/fleet_table), with
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

  ensureDefaultSubscription(agentId) {
    const query = 'to:my_labels';
    const existing = this._getSubscriptionsByOwner.all(agentId).find(row => row.query === query);
    if (existing) return existing;
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
      const subscriberLabels = this._agentLabelsById(tap.agent_id);
      const matches = evalExprDirectional(tap._ast, { fromLabels: senderLabels, toLabels: recipientLabels, subscriberLabels });
      if (matches) matched.add(tap.agent_id);
    }
    return [...matched];
  }

  _agentLabelsById(agentId) {
    if (!agentId) return [];
    const agent = this.getAgent(agentId);
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

  getUnread(agentId) {
    return this._query(this._getUnread, agentId);
  }

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

  // Mark a single event as read for one recipient. Used by terminal-card
  // dismissal: clicking X on a terminal_card marks just THAT event read,
  // so it doesn't auto-pop on reload, but other unread chats for the
  // recipient are unaffected.
  markEventRead(eventId, agentId) {
    const result = this._markEventRead.run(eventId, agentId);
    return result.changes > 0;
  }

  updateEventMetadata(eventId, patch) {
    this._updateEventMetadata.run(JSON.stringify(patch), eventId);
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

  // `agents` is the exact set of fleet ids the normal chat history is filtered to.
  // Broad name-history or lineage expansion belongs only in explicit search.
  queryChatHistory({ before, agents, limit = 50 } = {}) {
    let rows;
    const ids = Array.isArray(agents) ? agents : [];
    if (ids.length > 0) {
      const exactIds = [...new Set(ids)];
      const ph = exactIds.map(() => '?').join(',');
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
        const sql = `SELECT * FROM (
            SELECT * FROM (SELECT ${E} FROM events WHERE timestamp < ? AND from_id IN (${ph}) ORDER BY timestamp DESC LIMIT ?)
            UNION
            SELECT * FROM (SELECT ${E} FROM events WHERE timestamp < ? AND to_id IN (${ph}) ORDER BY timestamp DESC LIMIT ?)
          ) ORDER BY timestamp DESC LIMIT ?`;
        rows = this._query(this.db.prepare(sql), before, ...exactIds, limit, before, ...exactIds, limit, limit);
      } else {
        const sql = `SELECT * FROM (
            SELECT * FROM (SELECT ${E} FROM events WHERE from_id IN (${ph}) ORDER BY timestamp DESC LIMIT ?)
            UNION
            SELECT * FROM (SELECT ${E} FROM events WHERE to_id IN (${ph}) ORDER BY timestamp DESC LIMIT ?)
          ) ORDER BY timestamp DESC LIMIT ?`;
        rows = this._query(this.db.prepare(sql), ...exactIds, limit, ...exactIds, limit, limit);
      }
    } else if (before) {
      rows = this._query(this._queryEventsBefore, before, limit);
    } else {
      rows = this._query(this._queryEventsLatest, limit);
    }
    rows.reverse(); // chronological
    return rows;
  }

  buildChatHistoryResponse({ before = null, agents = [], limit = 50, serverOwnerId = null, serverOwnerName = null } = {}) {
    const cap = Math.min(parseInt(limit) || 50, 1000);
    let events = this.queryChatHistory({
      before,
      agents: Array.isArray(agents) ? agents : [],
      limit: cap + 1,
    }).map(e => ({ ...e, event_type: e.type, from: e.from, to: e.to, agent: e.agent_id }));

    const hasMore = events.length > cap;
    if (hasMore) events.shift();
    events = events.filter(e => {
      const t = e.text || '';
      return !t.startsWith('<channel') && !t.startsWith('<task-notification') && !t.startsWith('<system-reminder');
    });

    const agentMap = { ...this.getAgentNameMap() };
    if (serverOwnerId || serverOwnerName) {
      agentMap.web = agentMap[serverOwnerId] || serverOwnerName || serverOwnerId || 'web';
    }

    const unreadIds = new Set();
    const eventIds = events.map(e => e.id).filter(id => id != null);
    if (eventIds.length) {
      const placeholders = eventIds.map(() => '?').join(',');
      try {
        const rows = this.db.prepare(`SELECT event_id FROM unread WHERE read = 0 AND event_id IN (${placeholders})`).all(...eventIds);
        for (const r of rows) unreadIds.add(r.event_id);
      } catch (e) {
        console.error('[fleet] unread query failed:', e.message);
      }
    }

    const resolved = events.map(e => ({
      ...e,
      read: !unreadIds.has(e.id),
      fromLabel: agentMap[e.from] || (e.from ? e.from.substring(0, 8) : ''),
      toLabel: agentMap[e.to] || agentMap[e.agent] || (e.to ? e.to.substring(0, 8) : ''),
    }));
    const nextCursor = hasMore && events.length > 0 ? events[0].timestamp : null;
    return { events: resolved, hasMore, nextCursor };
  }

  // Get events after a known rowid (for SSE catch-up)
  getEventsSince(afterId, limit = 100) {
    return this._query(this._queryEventsAfterRowid, afterId, limit);
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
  queryAgentEvents({ agent, types = null, sinceTs = null, untilTs = null, afterId = 0, beforeId = null, limit = 200 }) {
    const cols = 'id, type, timestamp, from_id as "from", to_id as "to", text, metadata, task_id, agent_id';
    const tail = [];
    const tailParams = [];
    if (types && types.length) { tail.push(`type IN (${types.map(() => '?').join(',')})`); tailParams.push(...types); }
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
    const ftsQuery = query.replace(/"/g, '""');
    const clauses = ['events_fts MATCH ?'];
    const params = [ftsQuery];

    if (type) { clauses.push('e.type = ?'); params.push(type); }
    if (agent) {
      clauses.push('(e.from_id = ? OR e.to_id = ? OR e.agent_id = ?)');
      params.push(agent, agent, agent);
    }
    params.push(limit);

    const sql = `
      SELECT ${this._EVTE}, snippet(events_fts, 0, '<<', '>>', '...', 40) as snippet
      FROM events_fts f JOIN events e ON e.id = f.rowid
      WHERE ${clauses.join(' AND ')}
      ORDER BY e.timestamp DESC LIMIT ?
    `;

    try {
      return this.db.prepare(sql).all(...params).map(r => ({
        ...r,
        metadata: r.metadata ? JSON.parse(r.metadata) : null,
        snippet: r.snippet?.replace(/<<(.*?)>>/g, '⟨⟨$1⟩⟩'),
      }));
    } catch {
      return [];
    }
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

    const agentMap = {};
    for (const row of this.db.prepare('SELECT id, session_id, session_ids FROM agents').all()) {
      if (row.session_id) agentMap[row.session_id] = row.id;
      try { for (const sid of JSON.parse(row.session_ids || '[]')) agentMap[sid] = row.id; } catch (e) { console.warn(`[fleet-store] bad session_ids JSON for agent ${row.id}: ${e.message}`) }
    }

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
      const agentId = agentMap[sessionId] || 'unknown';
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
  // Resolve a typed agent-name fragment to the set of fleet ids it refers to.
  // Pure substring over the agent's SEARCHABLE name, where a bare (dawn) name is
  // treated as if it carried an explicit ":dawn" suffix — so `bear` matches the
  // whole family (bear, bear:day, …), `bear:` pins to just that family, `bear:dawn`
  // reaches the otherwise-bare dawn incarnation, and `:dawn` matches every dawn.
  // Matches against the current friendly_name AND every name an agent ever held
  // (name_history), so a name an agent USED to hold still finds it. Distinct ids.
  resolveAgentQuery(fragment) {
    return this.resolveAgentSelector({ fragment });
  }

  resolveAgentSelector(selector) {
    selector = typeof selector === 'string' ? { fragment: selector } : (selector || {});
    const baseFragment = (selector.fragment || '').trim().toLowerCase();
    if (!baseFragment) return [];
    const phase = selector.phase && selector.phase !== 'bare' ? selector.phase : null;
    const q = phase ? `${baseFragment}:${phase}` : baseFragment;
    if (!q) return [];
    const like = `%${q}%`;
    // A bare name (no ':') gets a virtual ":dawn" so substring is uniform.
    const synth = "CASE WHEN instr(friendly_name, ':') > 0 THEN lower(friendly_name) ELSE lower(friendly_name) || ':dawn' END";
    const rows = this.db.prepare(`
      WITH matches AS (
        SELECT id, coalesce(last_seen, registered_at, '') AS seen_at FROM agents
          WHERE friendly_name IS NOT NULL AND (${synth}) LIKE ?
        UNION ALL
        SELECT fleet_id AS id, coalesce(to_ts, from_ts, '') AS seen_at FROM name_history
          WHERE friendly_name IS NOT NULL AND (${synth}) LIKE ?
      )
      SELECT id FROM matches
      GROUP BY id
      ORDER BY max(seen_at) DESC, id ASC
    `).all(like, like);
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

  searchAll(query, { limit = 50, agent, role, since, before, agentOnly, historyOnly, eventOnly, fromOnly } = {}) {
    const ftsQuery = literalFtsQuery(query);
    const runQuery = (sql, params) => {
      try { return this.db.prepare(sql).all(...params); } catch { return []; }
    };

    // Normalize agent to array for multi-ID lineage search
    const agentIds = Array.isArray(agent) ? agent : agent ? [agent] : [];
    const hasAgent = agentIds.length > 0;
    const agentPlaceholders = agentIds.map(() => '?').join(',');
    const historyMode = historyOnly ?? agentOnly ?? false;

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

    // 1. Fleet events
    let eClauses, eParams;
    if (historyMode) {
      eClauses = [];
      eParams = [];
      if (hasAgent) {
        const ac = agentClause('e.from_id', 'e.to_id', 'e.agent_id');
        eClauses.push(ac.clause);
        eParams.push(...ac.params);
      }
    } else {
      eClauses = ['events_fts MATCH ?'];
      eParams = [ftsQuery];
      if (hasAgent) { const ac = agentClause('e.from_id', 'e.to_id', 'e.agent_id'); eClauses.push(ac.clause); eParams.push(...ac.params); }
    }
    if (since) { eClauses.push('e.timestamp >= ?'); eParams.push(since); }
    if (before) { eClauses.push('e.timestamp < ?'); eParams.push(before); }
    eParams.push(limit);
    const eventWhere = eClauses.length ? `WHERE ${eClauses.join(' AND ')}` : '';
    const ftsJoin = historyMode ? '' : 'events_fts f JOIN';
    const ftsOn = historyMode ? '' : 'ON e.id = f.rowid';
    const snippetCol = historyMode ? 'substr(e.text, 1, 120) as snippet' : "snippet(events_fts, 0, '<<', '>>', '...', 40) as snippet";
    const eventRows = runQuery(`
      SELECT e.id, e.type, e.timestamp, e.from_id as "from", e.to_id as "to", e.text, e.metadata,
             ${snippetCol}
      FROM ${ftsJoin} events e ${ftsOn}
      ${eventWhere}
      ORDER BY e.timestamp DESC LIMIT ?
    `, eParams).map(r => ({
      source: 'fleet',
      id: r.id,
      type: r.type,
      timestamp: r.timestamp,
      from: r.from,
      to: r.to,
      text: r.text,
      metadata: r.metadata ? JSON.parse(r.metadata) : null,
      snippet: r.snippet?.replace(/<<(.*?)>>/g, '⟨⟨$1⟩⟩'),
    }));

    if (eventOnly) {
      return eventRows.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? '')).slice(0, limit);
    }

    // 2. Session JSONL entries
    let sClauses, sParams;
    if (historyMode) {
      sClauses = [];
      sParams = [];
      if (hasAgent) {
        if (agentIds.length === 1) {
          sClauses.push('s.agent_id = ?');
          sParams.push(agentIds[0]);
        } else {
          sClauses.push(`s.agent_id IN (${agentPlaceholders})`);
          sParams.push(...agentIds);
        }
      }
    } else {
      sClauses = ['session_entries_fts MATCH ?'];
      sParams = [ftsQuery];
      if (hasAgent) {
        if (agentIds.length === 1) { sClauses.push('s.agent_id = ?'); sParams.push(agentIds[0]); }
        else { sClauses.push(`s.agent_id IN (${agentPlaceholders})`); sParams.push(...agentIds); }
      }
    }
    if (role && (role === 'user' || role === 'assistant')) { sClauses.push('s.role = ?'); sParams.push(role); }
    if (since) { sClauses.push('s.timestamp >= ?'); sParams.push(since); }
    if (before) { sClauses.push('s.timestamp < ?'); sParams.push(before); }
    sParams.push(limit);
    const sessionWhere = sClauses.length ? `WHERE ${sClauses.join(' AND ')}` : '';
    const sFtsJoin = historyMode ? '' : 'session_entries_fts f JOIN';
    const sFtsOn = historyMode ? '' : 'ON s.id = f.rowid';
    const sSnippetCol = historyMode ? 'substr(s.text, 1, 120) as snippet' : "snippet(session_entries_fts, 0, '<<', '>>', '...', 40) as snippet";
    const sessionRows = runQuery(`
      SELECT s.id, s.agent_id, s.session_id, s.role, s.timestamp, s.text,
             ${sSnippetCol}
      FROM ${sFtsJoin} session_entries s ${sFtsOn}
      ${sessionWhere}
      ORDER BY s.timestamp DESC LIMIT ?
    `, sParams).map(r => ({
      source: 'session',
      id: r.id,
      agentId: r.agent_id,
      sessionId: r.session_id,
      role: r.role,
      timestamp: r.timestamp,
      text: r.text,
      snippet: r.snippet?.replace(/<<(.*?)>>/g, '⟨⟨$1⟩⟩'),
    }));

    return [...eventRows, ...sessionRows]
      .sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''))
      .slice(0, limit);
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
    this._worker?.terminate?.();
    this.db.close();
  }
}
