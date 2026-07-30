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
    text: 'Current MCP names proposal: annoying name cleanup; rename high-frequency real tools search_logs to search, get_thread to thread, task_list to tasks, fleet_table to roster.',
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
    text: 'Current MCP names proposal: update task_list to tasks, hand off old search_logs to search, and reassign get_thread to chief thread.',
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

  const defaultResults = store.searchAll('get_thread', { limit: 10 });
  assert.equal(defaultResults.length, 1);
  assert.equal(defaultResults[0].type, 'chat');

  const activityResults = store.searchAll('get_thread', { type: 'activity', limit: 10 });
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

test('filtered event search is a non-empty subset of unfiltered matching events', () => withStore(store => {
  const rows = [
    ['fleet:skip', 'fleet:apps', 'timer alpha from skip'],
    ['fleet:apps', 'fleet:skip', 'timer beta to skip'],
    ['fleet:noise', 'fleet:apps', 'timer gamma to apps'],
    ['fleet:skip', 'fleet:noise', 'timer delta from skip'],
  ];
  rows.forEach(([from, to, text], i) => insertEvent(store, {
    type: 'chat',
    timestamp: `2026-07-19T00:00:0${i}.000Z`,
    from,
    to,
    text,
  }));

  const unfiltered = store.searchAll('timer', { limit: 20, eventOnly: true });
  const unfilteredKeys = new Set(unfiltered.map(row => row.id));
  const fromSkip = store.searchAll('timer', { agent: 'fleet:skip', fromOnly: true, limit: 20, eventOnly: true });
  const involvingApps = store.searchAll('timer', { agent: 'fleet:apps', limit: 20, eventOnly: true });

  assert.equal(unfiltered.length, 4);
  assert.equal(fromSkip.length, 2);
  assert.ok(fromSkip.every(row => row.from === 'fleet:skip' && unfilteredKeys.has(row.id)));
  assert.equal(involvingApps.length, 3);
  assert.ok(involvingApps.every(row => (row.from === 'fleet:apps' || row.to === 'fleet:apps' || row.agentId === 'fleet:apps') && unfilteredKeys.has(row.id)));
}));

test('from-filtered event search finds a known sender even when global candidates are saturated', () => withStore(store => {
  for (let i = 0; i < 1200; i++) {
    insertEvent(store, {
      type: 'chat',
      timestamp: `2026-07-20T00:${String(i % 60).padStart(2, '0')}:00.000Z`,
      from: `fleet:noise-${i}`,
      to: 'fleet:observer',
      text: `timer noise event ${i}`,
    });
  }
  insertEvent(store, {
    type: 'chat',
    timestamp: '2026-07-21T00:00:00.000Z',
    from: 'fleet:skip',
    to: 'fleet:apps',
    text: 'timer should wake for predictable events',
  });

  const unfiltered = store.searchAll('timer', { limit: 10 });
  const filtered = store.searchAll('timer', { agent: 'fleet:skip', fromOnly: true, limit: 10 });

  assert.ok(unfiltered.length > 0, 'unfiltered search should have matches');
  assert.equal(filtered.length, 1, 'from-filter must not silently empty after global candidate limiting');
  assert.equal(filtered[0].from, 'fleet:skip');
  assert.match(filtered[0].text, /predictable events/);
}));

test('to-filtered and agent-filtered event search apply filters before the FTS candidate limit', () => withStore(store => {
  for (let i = 0; i < 1200; i++) {
    insertEvent(store, {
      type: 'chat',
      timestamp: `2026-07-20T01:${String(i % 60).padStart(2, '0')}:00.000Z`,
      from: `fleet:noise-${i}`,
      to: 'fleet:observer',
      text: `timer distractor ${i}`,
    });
  }
  insertEvent(store, {
    type: 'chat',
    timestamp: '2026-07-21T01:00:00.000Z',
    from: 'fleet:skip',
    to: 'fleet:apps',
    text: 'timer belongs in the apps thread',
  });

  const toFiltered = store.searchAll('timer', { agent: 'fleet:apps', limit: 10 });
  const agentFiltered = store.searchAll('timer', { agent: 'fleet:skip', limit: 10 });

  assert.equal(toFiltered.length, 1);
  assert.equal(toFiltered[0].to, 'fleet:apps');
  assert.equal(agentFiltered.length, 1);
  assert.equal(agentFiltered[0].from, 'fleet:skip');
}));

test('filtered session search applies agent and role before the FTS candidate limit', () => withStore(store => {
  for (let i = 0; i < 1200; i++) {
    insertSessionEntry(store, {
      agentId: `fleet:noise-${i}`,
      sessionId: `session-noise-${i}`,
      role: 'assistant',
      timestamp: `2026-07-20T02:${String(i % 60).padStart(2, '0')}:00.000Z`,
      text: `timer session distractor ${i}`,
    });
  }
  insertSessionEntry(store, {
    agentId: 'fleet:skip',
    sessionId: 'session-skip',
    role: 'user',
    timestamp: '2026-07-21T02:00:00.000Z',
    text: 'timer is in Skip user history',
  });

  const results = store.searchAll('timer', { agent: 'fleet:skip', role: 'user', limit: 10 });

  assert.equal(results.length, 1);
  assert.equal(results[0].source, 'session');
  assert.equal(results[0].agentId, 'fleet:skip');
  assert.equal(results[0].role, 'user');
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
  assert.equal(stats.fts.eventsContentVersion, 'primary-events-plus-activity-diagnostics-v3');
}));

test('startup leaves obsolete notification cleanup off the blocking boot path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-fleet-notification-attempt-migration-'));
  const dbPath = join(dir, 'fleet.db');
  let store = new FleetStore(dbPath, { taskDoc: false });
  try {
    insertEvent(store, {
      type: 'chat',
      timestamp: '2026-07-29T12:00:00.000Z',
      from: 'fleet:skip',
      to: 'fleet:agent',
      text: 'preserved searchable conversation',
    });
    insertEvent(store, {
      type: 'notification_attempt',
      timestamp: '2026-07-29T12:00:01.000Z',
      from: 'fleet:tlda',
      to: 'fleet:agent',
      text: 'obsolete-delivery-ledger-token',
    });
    store.close();

    store = new FleetStore(dbPath, { taskDoc: false });
    assert.equal(store.db.prepare(
      "SELECT COUNT(*) AS count FROM events WHERE type = 'notification_attempt'"
    ).get().count, 1);
    assert.equal((await store.searchAll('obsolete-delivery-ledger-token', { limit: 10 })).length, 0);
    assert.equal((await store.searchAll('preserved searchable conversation', { limit: 10 }))[0]?.type, 'chat');
    assert.equal((await store.getSearchStats()).fts.eventsContentVersion, 'primary-events-plus-activity-diagnostics-v3');
    store.db.prepare("INSERT INTO events_fts(events_fts) VALUES ('integrity-check')").run();
    store.db.prepare("INSERT INTO activity_events_fts(activity_events_fts) VALUES ('integrity-check')").run();
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

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
