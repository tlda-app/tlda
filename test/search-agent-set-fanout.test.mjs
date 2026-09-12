// A history read over an agent SET must be one statement, not one per id.
//
// The filter grammar makes big sets ordinary rather than exotic: `project:tlda`
// resolves to every agent carrying that label — 435 of them on the live testing
// server on 2026-09-12 — and the per-id version made the read linear in that
// count. Measured there, same query and limit throughout: 1 id 351ms · 20 ids
// 543ms · 60 ids 3.8s · 150 ids 10.2s · 435 ids 37.5s, past the 30s request
// bound, which is the timeout a caller sees. It is the same defect as the
// 2026-09-06 incident where bare `tlda` expanded to 2,099 identities.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FleetStore } from '../server/lib/fleet-store.mjs';

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-search-fanout-'));
  const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false });
  try {
    return fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function insertEvent(store, event) {
  const info = store.db.prepare(`
    INSERT INTO events (type, timestamp, from_id, text, metadata, task_id, agent_id)
    VALUES (@type, @timestamp, @from, @text, @metadata, @taskId, @agentId)
  `).run({
    type: event.type,
    timestamp: event.timestamp,
    from: event.from || null,
    text: event.text || '',
    metadata: null,
    taskId: null,
    agentId: null,
  });
  for (const agentId of (Array.isArray(event.to) ? event.to : [event.to]).filter(Boolean)) {
    store.db.prepare(`
      INSERT OR IGNORE INTO recipients (event_id, agent_id, timestamp, read)
      VALUES (?, ?, ?, 0)
    `).run(info.lastInsertRowid, agentId, event.timestamp);
  }
}

const AGENTS = Array.from({ length: 60 }, (_, i) => `fleet:agent${String(i).padStart(3, '0')}`);

// One message per agent per round, so every agent has traffic spread across the
// whole window rather than clustered — a read of the newest N has to consider
// all of them, which is what makes the per-id version expensive.
function seed(store) {
  const base = Date.parse('2026-09-01T00:00:00.000Z');
  let n = 0;
  for (let round = 0; round < 20; round++) {
    for (const agent of AGENTS) {
      insertEvent(store, {
        type: 'chat',
        timestamp: new Date(base + (n++) * 1000).toISOString(),
        from: agent,
        to: 'fleet:hub',
        text: `message ${n} from ${agent}`,
      });
    }
  }
}

// The reference answer: what the per-id version produced — each agent's own
// newest `limit`, merged and cut. The set read must not change this.
function perAgentMerge(store, agentIds, limit) {
  return agentIds
    .flatMap(agent => store._queryAgentEventsForSearch({ agent, limit }))
    .sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? '') || (b.id - a.id))
    .slice(0, limit);
}

test('an agent-set history read returns the same rows as merging each agent separately', () => withStore(store => {
  seed(store);
  const limit = 25;
  const expected = perAgentMerge(store, AGENTS, limit);
  const actual = store._queryAgentEventsForSearch({ agent: AGENTS, limit });

  assert.equal(actual.length, limit, 'the set read fills the page');
  assert.deepEqual(actual.map(r => r.id), expected.map(r => r.id));
}));

test('an agent-set history read issues one statement however many ids it covers', () => withStore(store => {
  seed(store);

  // Only the agent-events read joins `recipients` as `r`, so counting that shape
  // isolates this query from everything else searchAll prepares.
  const realPrepare = store.db.prepare.bind(store.db);
  let agentReads = 0;
  store.db.prepare = (sql) => {
    if (typeof sql === 'string' && sql.includes('JOIN recipients r ON')) agentReads++;
    return realPrepare(sql);
  };
  try {
    store._queryAgentEventsForSearch({ agent: AGENTS, limit: 25 });
  } finally {
    store.db.prepare = realPrepare;
  }

  // The counter is what makes this able to fail: the per-id version produced one
  // read per agent, so this assertion saw 60 rather than 1.
  assert.equal(agentReads, 1, `expected one agent-events read for ${AGENTS.length} ids, got ${agentReads}`);
}));

test('a single-agent read is unchanged, and still keeps its equality predicate', () => withStore(store => {
  seed(store);
  const realPrepare = store.db.prepare.bind(store.db);
  let sentPredicate = null;
  store.db.prepare = (sql) => {
    if (typeof sql === 'string' && sql.includes('JOIN recipients r ON')) {
      sentPredicate = /from_id (= \?|IN \()/.exec(sql)?.[1] || null;
    }
    return realPrepare(sql);
  };
  try {
    const rows = store._queryAgentEventsForSearch({ agent: AGENTS[0], limit: 5 });
    assert.equal(rows.length, 5);
    assert.ok(rows.every(r => r.from === AGENTS[0]));
  } finally {
    store.db.prepare = realPrepare;
  }
  // The measured single-agent plan depends on `= ?`; `IN (?)` is a different
  // plan decision for SQLite and this read is the hot path for every thread().
  assert.equal(sentPredicate, '= ?');
}));

test('the set read still honours the filters that ride with it', () => withStore(store => {
  seed(store);
  const cutoff = new Date(Date.parse('2026-09-01T00:00:00.000Z') + 1000 * 1000).toISOString();
  const rows = store._queryAgentEventsForSearch({ agent: AGENTS, sinceTs: cutoff, limit: 40 });
  assert.ok(rows.length > 0, 'the bound admits some rows');
  assert.ok(rows.every(r => r.timestamp > cutoff), 'every row is inside the bound');

  const subset = AGENTS.slice(0, 3);
  const scoped = store._queryAgentEventsForSearch({ agent: subset, limit: 40 });
  assert.ok(scoped.length > 0);
  assert.ok(
    scoped.every(r => subset.includes(r.from) || r.recipients?.some(id => subset.includes(id))),
    'no row from outside the requested set',
  );
}));
