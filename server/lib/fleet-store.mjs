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

import { PSEUDO_LABELS } from '../../shared/fleet-labels.mjs';
import { baseName, nameForPhase, phaseFromName } from '../../shared/lineage-name.mjs';

// Persistent DB under ~/.config/tlda/ (survives macOS reboots).
// Previously /tmp/fleet.db which got wiped on reboot — lost all agents/state.
// Excluded from Spotlight via a .metadata_never_index file next to the DB.
const DB_PATH = path.join(os.homedir(), '.config', 'tlda', 'fleet.db');
const FLEET_DIR = path.join(os.homedir(), '.fleet');

// Virtual labels emitted by the DNF chat-routing resolver based on liveness
// state. A friendly_name or label that equals one of these would silently
// shadow the routing category. Single source of truth: shared/fleet-labels.mjs
// (statusLabels), re-exported here for the name-collision checks.
export { PSEUDO_LABELS };

export class FleetStore {
  constructor(dbPath) {
    dbPath = dbPath || DB_PATH;
    // Ensure directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = DELETE');
    this.db.pragma('synchronous = OFF');
    this._createTables();
    this._prepareStatements();
    this._listeners = []; // SSE broadcast callbacks
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
      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
        text,
        content='events',
        content_rowid='id',
        tokenize='unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
        INSERT INTO events_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
        INSERT INTO events_fts(events_fts, rowid, text) VALUES('delete', old.id, old.text);
      END;

      -- Materialized agent state (cache, rebuilt from events)
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        friendly_name TEXT,
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
        machine_id TEXT               -- which fleet-daemon machine owns this agent (NULL = unknown)
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
        blocked_by TEXT,              -- JSON array of task IDs
        success_criteria TEXT,        -- JSON array
        reported INTEGER DEFAULT 0,
        synthetic INTEGER DEFAULT 0,
        metadata TEXT                 -- JSON blob for extra fields
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent, status);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

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
      CREATE INDEX IF NOT EXISTS idx_session_entries_agent ON session_entries(agent_id, timestamp DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS session_entries_fts USING fts5(
        text,
        content='session_entries',
        content_rowid='id',
        tokenize='unicode61'
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
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_agents_machine ON agents(machine_id)");

    // Add lineage columns to agents if missing
    if (!agentCols.some(c => c.name === 'lineage_id')) {
      this.db.exec("ALTER TABLE agents ADD COLUMN lineage_id TEXT");
    }
    if (!agentCols.some(c => c.name === 'phase')) {
      this.db.exec("ALTER TABLE agents ADD COLUMN phase TEXT");
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
      INSERT INTO agents (id, friendly_name, tmux_session, session_id, session_ids, cwd, labels, registered_at, last_seen, dead, human, is_manager, metadata, machine_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        friendly_name = COALESCE(excluded.friendly_name, agents.friendly_name),
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
        metadata = COALESCE(excluded.metadata, agents.metadata),
        machine_id = COALESCE(excluded.machine_id, agents.machine_id)
    `);

    this._getAgent = this.db.prepare('SELECT * FROM agents WHERE id = ?');
    this._getAgentsByMachine = this.db.prepare('SELECT * FROM agents WHERE machine_id = ? AND dead = 0');
    this._getAgentByName = this.db.prepare('SELECT * FROM agents WHERE friendly_name = ?');
    this._getAllAgents = this.db.prepare(`
      SELECT a.*,
        (SELECT MAX(e.timestamp) FROM events e WHERE e.from_id = a.id OR e.to_id = a.id) AS last_active
      FROM agents a ORDER BY a.last_seen DESC
    `);
    this._deleteAgent = this.db.prepare('DELETE FROM agents WHERE id = ?');
    this._updateAgentLastSeen = this.db.prepare('UPDATE agents SET last_seen = ?, dead = 0 WHERE id = ?');
    this._markAgentDead = this.db.prepare('UPDATE agents SET dead = 1 WHERE id = ?');

    // Task queries
    this._upsertTask = this.db.prepare(`
      INSERT INTO tasks (id, agent, description, message, delegated_by, delegated_at, status, acknowledged, completed_at, last_checked, blocked_by, success_criteria, reported, synthetic, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        agent = excluded.agent,
        description = excluded.description,
        message = COALESCE(excluded.message, tasks.message),
        delegated_by = COALESCE(excluded.delegated_by, tasks.delegated_by),
        status = excluded.status,
        acknowledged = excluded.acknowledged,
        completed_at = excluded.completed_at,
        last_checked = excluded.last_checked,
        blocked_by = excluded.blocked_by,
        success_criteria = COALESCE(excluded.success_criteria, tasks.success_criteria),
        reported = excluded.reported,
        synthetic = excluded.synthetic,
        metadata = COALESCE(excluded.metadata, tasks.metadata)
    `);

    this._getTask = this.db.prepare('SELECT * FROM tasks WHERE id = ?');
    this._getTaskByAgent = this.db.prepare("SELECT * FROM tasks WHERE agent = ? AND status != 'done' ORDER BY delegated_at DESC LIMIT 1");
    this._getAllActiveTasks = this.db.prepare("SELECT * FROM tasks WHERE status != 'done' ORDER BY delegated_at DESC");
    this._getAllTasks = this.db.prepare('SELECT * FROM tasks ORDER BY delegated_at DESC');
    this._deleteTask = this.db.prepare('DELETE FROM tasks WHERE id = ?');

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

    // Event queries for chat history
    const E = this._EVT;
    this._queryEventsBefore = this.db.prepare(`
      SELECT ${E} FROM events WHERE timestamp < ? ORDER BY timestamp DESC LIMIT ?
    `);
    this._queryEventsLatest = this.db.prepare(`
      SELECT ${E} FROM events ORDER BY timestamp DESC LIMIT ?
    `);
    // Agent-scoped history matches a *set* of fleet ids (a lineage's incarnations),
    // so the SQL has variable arity and is built per-call in queryChatHistory()
    // rather than prepared here. See relatedFleetIds().
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
  share(event) {
    const ts = event.timestamp || new Date().toISOString();
    const meta = event.metadata ? JSON.stringify(event.metadata) : null;

    const _t0 = Date.now();
    const result = this._insertEvent.run(
      event.type,
      ts,
      event.from || null,
      event.to || null,
      event.text || null,
      meta,
      event.taskId || null,
      event.agentId || null
    );

    const _dt = Date.now() - _t0; if (_dt > 100) process.stderr.write(`[share-slow] ${_dt}ms type=${event.type}\n`);
    const eventId = result.lastInsertRowid;

    // Track unread if this is a message to someone
    if (event.unread !== false && event.to && event.type === 'chat') {
      this._insertUnread.run(eventId, event.to);
      // Also mark unread for CC recipients
      const cc = event.metadata?.cc;
      if (cc && Array.isArray(cc)) {
        for (const ccId of cc) {
          this._insertUnread.run(eventId, ccId);
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

    // Resolve wiretaps for ALL event types (not just chat)
    if (inserted.from_id && inserted.to_id) {
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
    for (const fn of this._listeners) {
      try { fn(inserted); } catch {}
    }

    return inserted;
  }

  // ---- Convenience write methods (all call share() internally) ----

  chat(from, to, text, metadata, timestamp) {
    return this.share({ type: 'chat', from, to, text, metadata, unread: true, timestamp });
  }

  delegate(from, to, taskId, description, metadata) {
    return this.share({
      type: 'delegate', from, to, text: description,
      taskId, metadata, unread: false, // lifecycle cards are informational
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

  registerEvent(agentId, metadata) {
    return this.share({
      type: 'register', agentId, text: `agent registered`,
      metadata,
    });
  }

  lifecycle(type, agentId, text, metadata) {
    return this.share({
      type: 'lifecycle', agentId, text: `${type}: ${text}`,
      metadata: { ...metadata, subtype: type },
    });
  }

  // ---- Agent state management ----

  upsertAgent(agent) {
    try {
      this._upsertAgent.run(
        agent.id,
        agent.friendly_name || null,
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
        agent.machine_id || null
      );
    } catch (e) {
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || e.message?.includes('UNIQUE constraint failed')) {
        throw new Error(`Name "${agent.friendly_name}" is already taken by another live agent`);
      }
      throw e;
    }
  }

  // Agents associated with a particular fleet-daemon machine. Used by the
  // server when sending a `daemon-welcome` message and when routing RPCs.
  getAgentsByMachine(machineId) {
    if (!machineId) return [];
    return this._getAgentsByMachine.all(machineId).map(r => this._hydrateAgent(r));
  }

  getAgent(id) {
    const row = this._getAgent.get(id);
    return row ? this._hydrateAgent(row) : null;
  }

  findAgent(query) {
    if (!query) return null;

    // Lineage:phase addressing (e.g. "writing-A:dawn", "writing-A:dusk")
    const colonIdx = query.indexOf(':');
    if (colonIdx > 0 && !query.startsWith('fleet:')) {
      const lineageName = query.slice(0, colonIdx);
      const phase = query.slice(colonIdx + 1);
      if (['dawn', 'day', 'dusk'].includes(phase)) {
        return this.findAgentByLineagePhase(lineageName, phase);
      }
    }

    let row = this._getAgent.get(query);
    if (!row) {
      // Name lookup — assert uniqueness among live agents
      const nameRows = this.db.prepare('SELECT * FROM agents WHERE friendly_name = ? AND dead = 0').all(query);
      if (nameRows.length > 1) {
        throw new Error(`Name collision: ${nameRows.length} live agents named "${query}": ${nameRows.map(r => r.id).join(', ')}`);
      }
      row = nameRows[0] || this._getAgentByName.get(query);
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

  getAllAgents() {
    return this._getAllAgents.all().map(r => this._hydrateAgent(r));
  }

  // Single gate for naming/labeling. Returns [] if all `names` are available.
  //
  // Rules (DNF chat routing treats friendly_names and labels equivalently):
  //   1. No name may equal a pseudo-label (awake/hibernating/human/human-away)
  //      — would silently shadow the routing category.
  //   2. No name may equal another live agent's friendly_name — would fan out
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
    const nameToId = new Map();
    const labelToIds = new Map();
    for (const r of rows) {
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

  getAliveAgents() {
    return this.getAllAgents().filter(a => !a.dead);
  }

  removeAgent(id) {
    this._deleteAgent.run(id);
  }

  updateHeartbeat(id) {
    const _t0 = Date.now();
    this._updateAgentLastSeen.run(new Date().toISOString(), id);
    const _dt = Date.now() - _t0; if (_dt > 100) process.stderr.write(`[hb-slow] ${_dt}ms id=${id}\n`);
  }

  markDead(id) {
    this._markAgentDead.run(id);
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
  }

  // Liveness oracle: optional function (agentId) => boolean.
  // Installed by the server. Returns true if the agent's claude process is
  // running on its machine right now (as reported by that machine's daemon).
  // No oracle installed → no agent reports awake (all hibernating). The
  // daemon's first liveness sweep populates the oracle within seconds of
  // connect, so this is only the cold-start transient.
  setLivenessOracle(fn) { this._isLiveOracle = fn }

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
      "SELECT * FROM agents WHERE lineage_id = ? AND friendly_name IS NOT NULL AND dead = 0"
    ).all(lineageId).map(r => this._hydrateAgent(r));
  }

  // The day (manager) member — the one whose name is "<base>:day".
  getLineageDay(lineageId) {
    const base = this._lineageBase(lineageId);
    if (!base) return null;
    const row = this.db.prepare(
      "SELECT * FROM agents WHERE lineage_id = ? AND friendly_name = ? AND dead = 0"
    ).get(lineageId, nameForPhase(base, 'day'));
    return row ? this._hydrateAgent(row) : null;
  }

  // Assign an agent into a lineage at a phase. Phase isn't stored — it's the
  // name: the agent is renamed to "<base>" (dawn) / "<base>:day" / "<base>:dusk".
  assignPhase(agentId, lineageId, phase) {
    const now = Date.now();
    const base = this._lineageBase(lineageId);
    this.db.transaction(() => {
      this.db.prepare('UPDATE agents SET lineage_id = ?, friendly_name = ? WHERE id = ?')
        .run(lineageId, base ? nameForPhase(base, phase) : null, agentId);
      this.db.prepare(
        'INSERT INTO lineage_phase_log (lineage_id, fleet_id, phase, entered_at) VALUES (?, ?, ?, ?)'
      ).run(lineageId, agentId, phase, now);
    })();
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
  }

  // Move an agent to a different phase within its lineage = rename it.
  transitionPhase(agentId, newPhase) {
    const now = Date.now();
    this.db.transaction(() => {
      const agent = this._getAgent.get(agentId);
      if (!agent || !agent.lineage_id) return;
      const base = this._lineageBase(agent.lineage_id);
      this.db.prepare(
        'UPDATE lineage_phase_log SET exited_at = ? WHERE fleet_id = ? AND exited_at IS NULL'
      ).run(now, agentId);
      this.db.prepare('UPDATE agents SET friendly_name = ? WHERE id = ?')
        .run(base ? nameForPhase(base, newPhase) : null, agentId);
      this.db.prepare(
        'INSERT INTO lineage_phase_log (lineage_id, fleet_id, phase, entered_at) VALUES (?, ?, ?, ?)'
      ).run(agent.lineage_id, agentId, newPhase, now);
    })();
  }

  // One rotation of the lineage's name-triple. The incoming agent takes the
  // dawn name (bare base); the existing holders each shift up a rung —
  // dawn → "<base>:day", day → "<base>:dusk", and the old dusk loses its name
  // (set NULL) and drops out of the triple while staying in the lineage as
  // nameless history (reachable only by id). Nothing is marked dead. Direct
  // handoff applies this once; the briefing handoff applies it twice.
  rotateLineageIn(lineageId, incomingAgentId) {
    const now = Date.now();
    const base = this._lineageBase(lineageId);
    if (!base) return;
    const dawnName = nameForPhase(base, 'dawn');
    const dayName = nameForPhase(base, 'day');
    const duskName = nameForPhase(base, 'dusk');
    // Find the current holder of a given name within this lineage.
    const holder = (name) => this.db.prepare(
      'SELECT id FROM agents WHERE lineage_id = ? AND friendly_name = ? AND dead = 0'
    ).get(lineageId, name)?.id || null;
    const rename = (id, name) => this.db.prepare('UPDATE agents SET friendly_name = ? WHERE id = ?').run(name, id);
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
    // name before it's reused: dusk name → null, day → dusk, dawn → day, in → dawn.
    const duskId = holder(duskName);
    const dayId = holder(dayName);
    const dawnId = holder(dawnName);
    this.db.transaction(() => {
      if (duskId && duskId !== incomingAgentId) {
        exitLog(duskId);
        rename(duskId, null); // ages out: name rotates off, stays in lineage as nameless history
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
      this.db.prepare('UPDATE agents SET lineage_id = ?, friendly_name = ? WHERE id = ?')
        .run(lineageId, dawnName, incomingAgentId);
      enterLog(incomingAgentId, 'dawn');
    })();
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
      'SELECT * FROM agents WHERE lineage_id = ? AND friendly_name = ? AND dead = 0'
    ).get(lineage.id, nameForPhase(lineage.friendly_name, phase));
    return row ? this._hydrateAgent(row) : null;
  }

  _hydrateAgent(row) {
    const lastActive = row.last_active || null
    const isAwake = !row.dead && !row.human && this._isLiveOracle
      ? !!this._isLiveOracle(row.id)
      : false
    let status
    if (row.dead) {
      status = 'dead'
    } else if (row.human) {
      const seenAgo = row.last_seen ? Date.now() - new Date(row.last_seen).getTime() : Infinity
      status = seenAgo < 90_000 ? 'human' : 'human-away'
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
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      last_active: lastActive,
      status,
      lineage_id: row.lineage_id || null,
      // No `phase` field — phase is encoded in friendly_name and parsed on the
      // client. lineage_name (the base) is still exposed for lineage search.
      lineage_name: row.lineage_id ? (this.db.prepare('SELECT friendly_name FROM lineages WHERE id = ?').get(row.lineage_id)?.friendly_name || null) : null,
    };
  }

  // ---- Task state management ----

  upsertTask(task) {
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
      task.blockedBy ? JSON.stringify(task.blockedBy) : null,
      task.success_criteria ? JSON.stringify(task.success_criteria) : null,
      task.reported ? 1 : 0,
      task.synthetic ? 1 : 0,
      task.metadata ? JSON.stringify(task.metadata) : null
    );
  }

  getTask(id) {
    const row = this._getTask.get(id);
    return row ? this._hydrateTask(row) : null;
  }

  getTaskByAgent(agentId) {
    let row = this._getTaskByAgent.get(agentId);
    if (!row) {
      // Fallback: check if agent has a friendly name, search tasks by that too
      // (handles tasks stored with friendly_name before the fix)
      const agent = this.getAgent(agentId);
      if (agent?.friendly_name) {
        row = this._getTaskByAgent.get(agent.friendly_name);
      }
    }
    return row ? this._hydrateTask(row) : null;
  }

  getActiveTasks() {
    return this._getAllActiveTasks.all().map(r => this._hydrateTask(r));
  }

  getAllTasks() {
    return this._getAllTasks.all().map(r => this._hydrateTask(r));
  }

  removeTask(id) {
    this._deleteTask.run(id);
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
    const info = this._addWiretap.run(agentId, JSON.stringify(filter), types ? JSON.stringify(types) : null);
    return { id: info.lastInsertRowid, agent_id: agentId, filter, types: types || null };
  }

  getWiretaps() {
    return this._getWiretaps.all().map(r => this._hydrateWiretap(r));
  }

  getWiretapsByAgent(agentId) {
    return this._getWiretapsByAgent.all(agentId).map(r => this._hydrateWiretap(r));
  }

  removeWiretap(id) {
    this._deleteWiretap.run(id);
  }

  removeWiretapsByAgent(agentId) {
    this._deleteWiretapsByAgent.run(agentId);
  }

  // Resolve wiretap matches: given a sender and recipient, return agent IDs that should be CC'd
  // Filter is DNF of [role, label] tuples: [[["to","skip"],["from","math"]]] = to:skip AND from:math
  resolveWiretaps(senderId, recipientId, eventType) {
    const taps = this.getWiretaps();
    if (taps.length === 0) return [];
    const agents = this.getAllAgents();
    const matched = new Set();

    // Build label sets for sender and recipient
    const senderLabels = this._agentLabels(senderId, agents);
    const recipientLabels = this._agentLabels(recipientId, agents);

    for (const tap of taps) {
      if (tap.agent_id === senderId || tap.agent_id === recipientId) continue;
      // Type filter: if wiretap specifies types, skip events that don't match
      if (tap.types && tap.types.length > 0 && eventType && !tap.types.includes(eventType)) continue;
      // DNF: any clause matches → wiretap fires
      const matches = tap.filter.some(clause =>
        clause.every(([role, label]) => {
          if (role === 'from') return senderLabels.includes(label);
          if (role === 'to') return recipientLabels.includes(label);
          return false;
        })
      );
      if (matches) matched.add(tap.agent_id);
    }
    return [...matched];
  }

  _agentLabels(agentId, agents) {
    const agent = agents.find(a => a.id === agentId);
    if (!agent) return [agentId];
    return [...(agent.labels || []), agent.friendly_name, agent.id].filter(Boolean);
  }

  _hydrateWiretap(row) {
    return { ...row, filter: JSON.parse(row.filter), types: row.types ? JSON.parse(row.types) : null };
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

  // The set of fleet ids whose events belong to the same logical agent as
  // `fleetId`. A lineage's history is spread across one fleet id per phase
  // incarnation; lineage_phase_log is the authoritative link and retains
  // retired-phase ids (whose agent row may have lineage_id = NULL by now),
  // so we recover the lineage from the log when the current row has none.
  relatedFleetIds(fleetId) {
    let lineageId = this._getAgent.get(fleetId)?.lineage_id;
    if (!lineageId) {
      lineageId = this.db
        .prepare('SELECT lineage_id FROM lineage_phase_log WHERE fleet_id = ? LIMIT 1')
        .get(fleetId)?.lineage_id;
    }
    if (!lineageId) return [fleetId];
    return [...new Set([fleetId, ...this.getLineageFleetIds(lineageId)])];
  }

  // `agents` is the set of fleet ids the chat is filtered to (resolved on the
  // client by the same logic the live display uses — friendly names, lineage
  // names, and `name:phase` colon labels). Each id is expanded to its lineage's
  // full incarnation set via relatedFleetIds(), so history for a lineage agent
  // returns the union across all its phase/respawn ids — matching what live shows.
  queryChatHistory({ before, agents, limit = 50 } = {}) {
    let rows;
    const ids = Array.isArray(agents) ? agents : [];
    if (ids.length > 0) {
      const expanded = [...new Set(ids.flatMap(id => this.relatedFleetIds(id)))];
      const ph = expanded.map(() => '?').join(',');
      const E = this._EVT;
      if (before) {
        const sql = `SELECT ${E} FROM events WHERE timestamp < ? AND (from_id IN (${ph}) OR to_id IN (${ph})) ORDER BY timestamp DESC LIMIT ?`;
        rows = this._query(this.db.prepare(sql), before, ...expanded, ...expanded, limit);
      } else {
        const sql = `SELECT ${E} FROM events WHERE from_id IN (${ph}) OR to_id IN (${ph}) ORDER BY timestamp DESC LIMIT ?`;
        rows = this._query(this.db.prepare(sql), ...expanded, ...expanded, limit);
      }
    } else if (before) {
      rows = this._query(this._queryEventsBefore, before, limit);
    } else {
      rows = this._query(this._queryEventsLatest, limit);
    }
    rows.reverse(); // chronological
    return rows;
  }

  // Get events after a known rowid (for SSE catch-up)
  getEventsSince(afterId, limit = 100) {
    return this._query(this._queryEventsAfterRowid, afterId, limit);
  }

  getLastEventId() {
    return this._lastRowid.get()?.max_id || 0;
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

  insertSessionEntries(entries) {
    if (!entries?.length) return;
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO session_entries (agent_id, session_id, role, timestamp, text)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.db.transaction(() => {
      for (const e of entries) {
        if (!e.timestamp) continue;
        const text = e.text?.length > 5000 ? e.text.slice(0, 5000) : e.text;
        stmt.run(e.agent_id, e.session_id, e.role, e.timestamp, text);
      }
    })();
  }

  async backfillSessionEntries(projectsDir) {
    const indexed = new Set(
      this.db.prepare('SELECT DISTINCT session_id FROM session_entries').all().map(r => r.session_id)
    );
    let dirs;
    try { dirs = fs.readdirSync(projectsDir); } catch { return { indexed: 0, skipped: 0 }; }

    const agentMap = {};
    for (const row of this.db.prepare('SELECT id, session_id, session_ids FROM agents').all()) {
      if (row.session_id) agentMap[row.session_id] = row.id;
      try { for (const sid of JSON.parse(row.session_ids || '[]')) agentMap[sid] = row.id; } catch (e) { console.warn(`[fleet-store] bad session_ids JSON for agent ${row.id}: ${e.message}`) }
    }

    const allFiles = [];
    for (const dir of dirs) {
      const dirPath = path.join(projectsDir, dir);
      let files;
      try { files = fs.readdirSync(dirPath); } catch { continue; }
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const sessionId = file.slice(0, -6);
        if (indexed.has(sessionId)) continue;
        allFiles.push({ filePath: path.join(dirPath, file), sessionId });
      }
    }

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO session_entries (agent_id, session_id, role, timestamp, text)
      VALUES (?, ?, ?, ?, ?)
    `);
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
        this.db.transaction(() => {
          for (const e of entries) {
            const t = e.text.length > 5000 ? e.text.slice(0, 5000) : e.text;
            stmt.run(e.agentId, e.sessionId, e.role, e.timestamp, t);
          }
        })();
        totalIndexed++;
      }
      await new Promise(r => setImmediate(r));
    }
    return { indexed: totalIndexed, skipped: allFiles.length - totalIndexed };
  }

  // Unified search across fleet events (events_fts) and session JSONL text (session_entries_fts).
  searchAll(query, { limit = 50, agent, role, since, before, agentOnly } = {}) {
    const ftsQuery = query.replace(/"/g, '""');
    const runQuery = (sql, params) => {
      try { return this.db.prepare(sql).all(...params); } catch { return []; }
    };

    // Normalize agent to array for multi-ID lineage search
    const agentIds = Array.isArray(agent) ? agent : agent ? [agent] : [];
    const hasAgent = agentIds.length > 0;
    const agentPlaceholders = agentIds.map(() => '?').join(',');

    function agentClause(fromCol, toCol, agentCol) {
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
    if (agentOnly && hasAgent) {
      const ac = agentClause('e.from_id', 'e.to_id', 'e.agent_id');
      eClauses = [ac.clause];
      eParams = [...ac.params];
    } else {
      eClauses = ['events_fts MATCH ?'];
      eParams = [ftsQuery];
      if (hasAgent) { const ac = agentClause('e.from_id', 'e.to_id', 'e.agent_id'); eClauses.push(ac.clause); eParams.push(...ac.params); }
    }
    if (since) { eClauses.push('e.timestamp >= ?'); eParams.push(since); }
    if (before) { eClauses.push('e.timestamp < ?'); eParams.push(before); }
    eParams.push(limit);
    const ftsJoin = (agentOnly && hasAgent) ? '' : 'events_fts f JOIN';
    const ftsOn = (agentOnly && hasAgent) ? '' : 'ON e.id = f.rowid';
    const snippetCol = (agentOnly && hasAgent) ? 'substr(e.text, 1, 120) as snippet' : "snippet(events_fts, 0, '<<', '>>', '...', 40) as snippet";
    const eventRows = runQuery(`
      SELECT e.id, e.type, e.timestamp, e.from_id as "from", e.to_id as "to", e.text, e.metadata,
             ${snippetCol}
      FROM ${ftsJoin} events e ${ftsOn}
      WHERE ${eClauses.join(' AND ')}
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

    // 2. Session JSONL entries
    let sClauses, sParams;
    if (agentOnly && hasAgent) {
      if (agentIds.length === 1) {
        sClauses = ['s.agent_id = ?'];
        sParams = [agentIds[0]];
      } else {
        sClauses = [`s.agent_id IN (${agentPlaceholders})`];
        sParams = [...agentIds];
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
    const sFtsJoin = (agentOnly && agent) ? '' : 'session_entries_fts f JOIN';
    const sFtsOn = (agentOnly && agent) ? '' : 'ON s.id = f.rowid';
    const sSnippetCol = (agentOnly && agent) ? 'substr(s.text, 1, 120) as snippet' : "snippet(session_entries_fts, 0, '<<', '>>', '...', 40) as snippet";
    const sessionRows = runQuery(`
      SELECT s.id, s.agent_id, s.session_id, s.role, s.timestamp, s.text,
             ${sSnippetCol}
      FROM ${sFtsJoin} session_entries s ${sFtsOn}
      WHERE ${sClauses.join(' AND ')}
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

  close() {
    this.db.close();
  }
}
