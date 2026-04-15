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
import fs from 'fs';
import path from 'path';
import os from 'os';

// Persistent DB under ~/.config/tlda/ (survives macOS reboots).
// Previously /tmp/fleet.db which got wiped on reboot — lost all agents/state.
// Excluded from Spotlight via a .metadata_never_index file next to the DB.
const DB_PATH = path.join(os.homedir(), '.config', 'tlda', 'fleet.db');
const FLEET_DIR = path.join(os.homedir(), '.fleet');

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

    // ---- Migrations (idempotent) ----
    // Add machine_id column to agents if missing (existing DBs predate it).
    const agentCols = this.db.prepare("PRAGMA table_info(agents)").all();
    if (!agentCols.some(c => c.name === 'machine_id')) {
      this.db.exec("ALTER TABLE agents ADD COLUMN machine_id TEXT");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_agents_machine ON agents(machine_id)");
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
    this._getAllAgents = this.db.prepare('SELECT * FROM agents ORDER BY last_seen DESC');
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
    this._addWiretap = this.db.prepare('INSERT INTO wiretaps (agent_id, filter) VALUES (?, ?)');
    this._getWiretaps = this.db.prepare('SELECT * FROM wiretaps');
    this._getWiretapsByAgent = this.db.prepare('SELECT * FROM wiretaps WHERE agent_id = ?');
    this._deleteWiretap = this.db.prepare('DELETE FROM wiretaps WHERE id = ?');
    this._deleteWiretapsByAgent = this.db.prepare('DELETE FROM wiretaps WHERE agent_id = ?');

    // Event queries for chat history
    const E = this._EVT;
    this._queryEventsBefore = this.db.prepare(`
      SELECT ${E} FROM events WHERE timestamp < ? ORDER BY timestamp DESC LIMIT ?
    `);
    this._queryEventsBeforeAgent = this.db.prepare(`
      SELECT ${E} FROM events WHERE timestamp < ? AND (from_id = ? OR to_id = ?)
      ORDER BY timestamp DESC LIMIT ?
    `);
    this._queryEventsLatest = this.db.prepare(`
      SELECT ${E} FROM events ORDER BY timestamp DESC LIMIT ?
    `);
    this._queryEventsLatestAgent = this.db.prepare(`
      SELECT ${E} FROM events WHERE from_id = ? OR to_id = ?
      ORDER BY timestamp DESC LIMIT ?
    `);
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
      // Search by session_id
      row = this.db.prepare('SELECT * FROM agents WHERE session_id = ?').get(query);
    }
    return row ? this._hydrateAgent(row) : null;
  }

  getAllAgents() {
    return this._getAllAgents.all().map(r => this._hydrateAgent(r));
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
    const metadata = row.metadata ? JSON.parse(row.metadata) : {};
    metadata.status = { state, tool: tool || null, ts: ts || new Date().toISOString() };
    this.db.prepare('UPDATE agents SET metadata = ?, last_seen = ? WHERE id = ?')
      .run(JSON.stringify(metadata), new Date().toISOString(), id);
  }

  updateAgentMeta(id, patch) {
    // Merge patch into agent metadata JSON blob — no schema migration needed
    const row = this._getAgent.get(id);
    if (!row) return;
    const metadata = row.metadata ? JSON.parse(row.metadata) : {};
    Object.assign(metadata, patch);
    this.db.prepare('UPDATE agents SET metadata = ? WHERE id = ?')
      .run(JSON.stringify(metadata), id);
  }

  _hydrateAgent(row) {
    return {
      ...row,
      session_ids: row.session_ids ? JSON.parse(row.session_ids) : [],
      labels: row.labels ? JSON.parse(row.labels) : [],
      dead: !!row.dead,
      human: !!row.human,
      is_manager: !!row.is_manager,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
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

  addWiretap(agentId, filter) {
    const info = this._addWiretap.run(agentId, JSON.stringify(filter));
    return { id: info.lastInsertRowid, agent_id: agentId, filter };
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
  resolveWiretaps(senderId, recipientId) {
    const taps = this.getWiretaps();
    if (taps.length === 0) return [];
    const agents = this.getAllAgents();
    const matched = new Set();

    // Build label sets for sender and recipient
    const senderLabels = this._agentLabels(senderId, agents);
    const recipientLabels = this._agentLabels(recipientId, agents);

    for (const tap of taps) {
      if (tap.agent_id === senderId || tap.agent_id === recipientId) continue;
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
    return { ...row, filter: JSON.parse(row.filter) };
  }

  // ---- QA system ----

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

  getEventById(eventId) {
    const row = this.db.prepare(`SELECT ${this._EVT} FROM events WHERE id = ?`).get(eventId);
    if (!row) return null;
    const meta = row.metadata ? JSON.parse(row.metadata) : null;
    return { ...row, from: row.from, to: row.to, metadata: meta };
  }

  queryChatHistory({ before, agent, limit = 50 } = {}) {
    let rows;
    if (before && agent) {
      rows = this._query(this._queryEventsBeforeAgent, before, agent, agent, limit);
    } else if (before) {
      rows = this._query(this._queryEventsBefore, before, limit);
    } else if (agent) {
      rows = this._query(this._queryEventsLatestAgent, agent, agent, limit);
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
      WHERE type IN ('chat', 'delegate', 'task_done', 'lifecycle')
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

  close() {
    this.db.close();
  }
}
