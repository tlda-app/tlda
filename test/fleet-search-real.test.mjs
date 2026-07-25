import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FleetStore } from '../server/lib/fleet-store.mjs';

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-fleet-search-'));
  const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false });
  try {
    return fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function insertEvent(store, event) {
  store.db.prepare(`
    INSERT INTO events (type, timestamp, from_id, to_id, text, metadata, task_id, agent_id)
    VALUES (@type, @timestamp, @from, @to, @text, @metadata, @taskId, @agentId)
  `).run({
    type: event.type,
    timestamp: event.timestamp,
    from: event.from || null,
    to: event.to || null,
    text: event.text || '',
    metadata: event.metadata ? JSON.stringify(event.metadata) : null,
    taskId: event.taskId || null,
    agentId: event.agentId || null,
  });
}

function insertSessionEntry(store, entry) {
  store.db.prepare(`
    INSERT INTO session_entries (agent_id, session_id, role, timestamp, text)
    VALUES (@agentId, @sessionId, @role, @timestamp, @text)
  `).run(entry);
}

test('default search returns naming chat for original failing query ahead of activity echoes', () => withStore(store => {
  insertEvent(store, {
    type: 'chat',
    timestamp: '2026-07-13T10:12:30.000Z',
    from: 'fleet:librarian',
    to: 'fleet:chief',
    text: 'Current MCP names proposal: rename high-frequency real tools search_logs to search, get_thread to thread, task_list to tasks, fleet_table to roster.',
  });
  insertEvent(store, {
    type: 'activity',
    timestamp: '2026-07-25T06:43:59.000Z',
    from: 'fleet:worker',
    to: 'fleet:worker',
    text: 'tool call',
    metadata: {
      tool: 'tlda/get_thread',
      prettyResult: 'MCP tool rename annoying name update task reassign hand off task to chief',
    },
  });

  const results = store.searchAll('MCP tool rename annoying name', { limit: 10 });
  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'chat');
  assert.match(results[0].text, /Current MCP names proposal/);
}));

test('default search returns old naming chat before newer activity for handoff query', () => withStore(store => {
  insertEvent(store, {
    type: 'chat',
    timestamp: '2026-07-13T10:12:30.000Z',
    from: 'fleet:librarian',
    to: 'fleet:chief',
    text: 'Current MCP names proposal: update task_list to tasks, hand off old search_logs to search, and reassign get_thread to thread.',
  });
  insertEvent(store, {
    type: 'activity',
    timestamp: '2026-07-25T06:43:59.000Z',
    from: 'fleet:worker',
    to: 'fleet:worker',
    text: 'tool call',
    metadata: {
      tool: 'tlda/get_thread',
      prettyResult: 'update task reassign hand off task to chief',
    },
  });

  const results = store.searchAll('update task reassign hand off task to chief', { limit: 10 });
  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'chat');
  assert.match(results[0].text, /Current MCP names proposal/);
}));

test('activity diagnostics are searchable explicitly without indexing prettyResult', () => withStore(store => {
  insertEvent(store, {
    type: 'activity',
    timestamp: '2026-07-25T06:43:59.000Z',
    from: 'fleet:worker',
    to: 'fleet:worker',
    text: 'tool call',
    metadata: {
      tool: 'tlda/get_thread',
      description: 'Read naming thread',
      prettyResult: 'buried unique-token-from-thread-copy',
    },
  });

  const toolResults = store.searchAll('get_thread', { type: 'activity', limit: 10 });
  assert.equal(toolResults.length, 1);
  assert.equal(toolResults[0].type, 'activity');

  const prettyResultOnly = store.searchAll('unique-token-from-thread-copy', { type: 'activity', limit: 10 });
  assert.equal(prettyResultOnly.length, 0);
}));

test('legacy event search uses the same split corpus', () => withStore(store => {
  insertEvent(store, {
    type: 'chat',
    timestamp: '2026-07-13T10:12:30.000Z',
    from: 'fleet:librarian',
    to: 'fleet:chief',
    text: 'MCP naming proposal mentions get_thread.',
  });
  insertEvent(store, {
    type: 'activity',
    timestamp: '2026-07-25T06:43:59.000Z',
    from: 'fleet:worker',
    to: 'fleet:worker',
    text: 'tool call',
    metadata: {
      tool: 'tlda/get_thread',
      prettyResult: 'MCP naming proposal copied from a thread read',
    },
  });

  const defaultResults = store.search('get_thread', { limit: 10 });
  assert.equal(defaultResults.length, 1);
  assert.equal(defaultResults[0].type, 'chat');

  const activityResults = store.search('get_thread', { type: 'activity', limit: 10 });
  assert.equal(activityResults.length, 1);
  assert.equal(activityResults[0].type, 'activity');
}));

test('fleet chat outranks matching session JSONL in global search', () => withStore(store => {
  insertEvent(store, {
    type: 'chat',
    timestamp: '2026-07-13T10:12:30.000Z',
    from: 'fleet:librarian',
    to: 'fleet:chief',
    text: 'MCP naming proposal: search_logs to search and get_thread to thread.',
  });
  insertSessionEntry(store, {
    agentId: 'fleet:worker',
    sessionId: 'session-1',
    role: 'assistant',
    timestamp: '2026-07-25T06:43:59.000Z',
    text: 'MCP naming proposal: search_logs to search and get_thread to thread.',
  });

  const results = store.searchAll('MCP naming search_logs thread', { limit: 10 });
  assert.equal(results.length, 2);
  assert.equal(results[0].source, 'fleet');
  assert.equal(results[0].type, 'chat');
}));

test('search stats report corpus scale and index version', () => withStore(store => {
  insertEvent(store, {
    type: 'chat',
    timestamp: '2026-07-13T10:12:30.000Z',
    from: 'fleet:librarian',
    to: 'fleet:chief',
    text: 'MCP naming proposal.',
  });
  insertEvent(store, {
    type: 'activity',
    timestamp: '2026-07-25T06:43:59.000Z',
    from: 'fleet:worker',
    to: 'fleet:worker',
    text: 'tool call',
    metadata: { tool: 'tlda/get_thread' },
  });
  insertSessionEntry(store, {
    agentId: 'fleet:worker',
    sessionId: 'session-1',
    role: 'assistant',
    timestamp: '2026-07-25T06:43:59.000Z',
    text: 'Did the search work.',
  });

  const stats = store.getSearchStats();
  assert.equal(stats.events.total, 2);
  assert.deepEqual(Object.fromEntries(stats.events.byType.map(row => [row.type, row.count])), {
    activity: 1,
    chat: 1,
  });
  assert.equal(stats.sessionEntries.total, 1);
  assert.equal(stats.fts.eventsContentVersion, 'primary-events-plus-activity-diagnostics-v2');
}));

test('search query plans do not sort the full matched event set', () => withStore(store => {
  const eventPlan = store.db.prepare(`EXPLAIN QUERY PLAN
    SELECT e.id, e.type, e.timestamp, e.from_id as "from", e.to_id as "to", e.text, e.metadata, e.agent_id,
           snippet(events_fts, 0, '<<', '>>', '...', 40) as snippet, f.fts_rank
    FROM (
      SELECT rowid, rank AS fts_rank
      FROM events_fts
      WHERE events_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    ) f
    JOIN events_fts ON events_fts.rowid = f.rowid
    JOIN events e ON e.id = f.rowid
    LIMIT ?
  `).all('"the" OR "daemon"', 5000, 50).map(row => row.detail);

  const activityPlan = store.db.prepare(`EXPLAIN QUERY PLAN
    SELECT e.id, e.type, e.timestamp, e.from_id as "from", e.to_id as "to", e.text, e.metadata, e.agent_id,
           snippet(activity_events_fts, 0, '<<', '>>', '...', 40) as snippet, f.fts_rank
    FROM (
      SELECT rowid, rank AS fts_rank
      FROM activity_events_fts
      WHERE activity_events_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    ) f
    JOIN activity_events_fts ON activity_events_fts.rowid = f.rowid
    JOIN events e ON e.id = f.rowid
    LIMIT ?
  `).all('"daemon"', 5000, 50).map(row => row.detail);

  for (const plan of [eventPlan, activityPlan]) {
    assert.equal(plan.some(detail => detail.includes('USE TEMP B-TREE')), false, plan.join('\n'));
    assert.equal(plan.some(detail => detail.includes('SEARCH e USING INTEGER PRIMARY KEY')), true, plan.join('\n'));
    assert.equal(plan.some(detail => detail.includes('idx_events_type')), false, plan.join('\n'));
  }
}));
