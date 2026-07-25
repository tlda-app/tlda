import assert from 'node:assert/strict';
import test from 'node:test';

import { createFilterSubscriptions, filterKey } from '../server/lib/filter-subscriptions.mjs';

const CHIEF = { id: 'fleet:b6d7cc18', friendly_name: 'chief2', labels: [] };
const TODD = { id: 'fleet:t0dd', friendly_name: 'todd', labels: [] };
const SKIP = 'fleet:skip';

const agents = () => [CHIEF, TODD];
const chat = (from, to) => ({ type: 'chat', from, to, text: 'hi' });

test('equal filters share one key regardless of term or clause order', () => {
  assert.equal(
    filterKey([[['from', 'a'], ['to', 'b']]]),
    filterKey([[['to', 'b'], ['from', 'a']]])
  );
  assert.equal(
    filterKey([[['from', 'a']], [['to', 'a']]]),
    filterKey([[['to', 'a']], [['from', 'a']]])
  );
  assert.notEqual(filterKey([[['from', 'a']]]), filterKey([[['from', 'b']]]));
});

test('an event is evaluated once per distinct filter, not once per subscription', () => {
  const subs = createFilterSubscriptions({ getAgents: agents });
  const filter = [[['from', 'chief2']]];
  // Nineteen panels in ONE tab, one filter — Skip's actual shape.
  const tab = { id: 'tab' };
  for (let i = 0; i < 19; i++) subs.subscribe(tab, `panel-${i}`, filter, { humanId: SKIP });

  const matched = subs.match(chat(CHIEF.id, SKIP));
  assert.equal(matched.length, 19, 'every subscription should receive it');
  assert.equal(matched.evaluations, 1, 'but the filter should be evaluated once');
  assert.deepEqual(subs.stats(), { distinctFilters: 1, subscriptions: 19, connections: 1 });
});

test('the name resolves here even though a browser roster would have missed it', () => {
  // This is the defect the move exists to remove: the same call with agents: []
  // returns no match. On the server the roster is authoritative, so it cannot.
  const subs = createFilterSubscriptions({ getAgents: agents });
  const conn = {};
  subs.subscribe(conn, 'p', [[['from', 'chief2']]], { humanId: SKIP });
  assert.equal(subs.match(chat(CHIEF.id, SKIP)).length, 1);

  const starved = createFilterSubscriptions({ getAgents: () => [] });
  starved.subscribe({}, 'p', [[['from', 'chief2']]], { humanId: SKIP });
  assert.equal(starved.match(chat(CHIEF.id, SKIP)).length, 0);
});

test('non-matching traffic is delivered to nobody', () => {
  const subs = createFilterSubscriptions({ getAgents: agents });
  subs.subscribe({}, 'p', [[['from', 'chief2']]], { humanId: SKIP });
  assert.equal(subs.match(chat(TODD.id, SKIP)).length, 0);
});

test('direction is preserved through the registry', () => {
  const subs = createFilterSubscriptions({ getAgents: agents });
  subs.subscribe({}, 'p', [[['to', 'chief2']]], { humanId: SKIP });
  assert.equal(subs.match(chat(CHIEF.id, SKIP)).length, 0, 'to: must not match a message FROM');
  assert.equal(subs.match(chat(SKIP, CHIEF.id)).length, 1, 'to: must match a message TO');
});

test('dm: is scoped per subscriber, and two humans on one filter cost two evaluations', () => {
  const subs = createFilterSubscriptions({ getAgents: agents });
  const filter = [[['dm', 'chief2']]];
  subs.subscribe({ a: 1 }, 'skip-panel', filter, { humanId: SKIP });
  subs.subscribe({ b: 1 }, 'other-panel', filter, { humanId: 'fleet:dmitry' });

  const matched = subs.match(chat(CHIEF.id, SKIP));
  assert.deepEqual(matched.map((m) => m.subId), ['skip-panel'],
    "a DM to Skip must not be delivered to another human's dm panel");
  assert.equal(matched.evaluations, 2, 'one evaluation per distinct (filter, human)');
});

test('a closed connection drops every subscription it held', () => {
  const subs = createFilterSubscriptions({ getAgents: agents });
  const gone = { id: 'gone' };
  const stays = { id: 'stays' };
  subs.subscribe(gone, 'p1', [[['from', 'chief2']]], { humanId: SKIP });
  subs.subscribe(gone, 'p2', [[['from', 'todd']]], { humanId: SKIP });
  subs.subscribe(stays, 'p3', [[['from', 'chief2']]], { humanId: SKIP });

  assert.equal(subs.dropConnection(gone), 2);
  assert.deepEqual(subs.stats(), { distinctFilters: 1, subscriptions: 1, connections: 1 });
  assert.deepEqual(subs.match(chat(CHIEF.id, SKIP)).map((m) => m.subId), ['p3']);
});

test('unsubscribing the last holder removes the filter entirely', () => {
  const subs = createFilterSubscriptions({ getAgents: agents });
  const conn = {};
  subs.subscribe(conn, 'p', [[['from', 'chief2']]], { humanId: SKIP });
  subs.unsubscribe(conn, 'p');
  assert.equal(subs.stats().distinctFilters, 0);
  assert.equal(subs.match(chat(CHIEF.id, SKIP)).length, 0);
});

test('two connections with the same filter still cost one evaluation', () => {
  const subs = createFilterSubscriptions({ getAgents: agents });
  const filter = [[['from', 'chief2']], [['to', 'chief2']]];
  subs.subscribe({ a: 1 }, 'p', filter, { humanId: SKIP });
  // Same filter written with the clauses the other way round.
  subs.subscribe({ b: 1 }, 'p', [[['to', 'chief2']], [['from', 'chief2']]], { humanId: SKIP });

  const matched = subs.match(chat(CHIEF.id, SKIP));
  assert.equal(matched.length, 2);
  assert.equal(matched.evaluations, 1, 'clause order must not split the evaluation');
});

// --- regressions from chat-lock's adversarial review of 150448ee ---

test('humanName reaches the evaluator — a filter naming the human by name matches', () => {
  // Defect 1: match() built { agents, humanId } while the browser passes
  // { agents, humanId, humanName }. Without humanName the human answers to the
  // label `user` instead of their own name, so one file behaved two ways.
  const subs = createFilterSubscriptions({ getAgents: agents });
  subs.subscribe({}, 'p', [[['from', 'skip']]], { humanId: SKIP, humanName: 'skip' });
  assert.equal(subs.match(chat(SKIP, CHIEF.id)).length, 1,
    'the human must answer to their own name, not to "user"');
});

test('verdict() answers the same question as match(), for live/history equivalence', () => {
  const subs = createFilterSubscriptions({ getAgents: agents });
  const filter = [[['from', 'chief2']]];
  subs.subscribe({}, 'p', filter, { humanId: SKIP, humanName: 'skip' });
  const event = chat(CHIEF.id, SKIP);
  assert.equal(subs.verdict(filter, event, { humanId: SKIP, humanName: 'skip' }), true);
  assert.equal(subs.match(event).length, 1);
  const other = chat(TODD.id, SKIP);
  assert.equal(subs.verdict(filter, other, { humanId: SKIP, humanName: 'skip' }), false);
  assert.equal(subs.match(other).length, 0);
});

test('unsubscribe does not leak filter keys into byConn', () => {
  // Defect 2: unsubscribe cleaned byFilter and never touched byConn, so a
  // long-lived socket accumulated dead keys as its panels opened and refiltered.
  const subs = createFilterSubscriptions({ getAgents: agents });
  const conn = { id: 'long-lived' };
  for (let i = 0; i < 50; i++) {
    subs.subscribe(conn, 'panel', [[['from', `agent-${i}`]]], { humanId: SKIP });
    subs.unsubscribe(conn, 'panel');
  }
  assert.deepEqual(subs.stats(), { distinctFilters: 0, subscriptions: 0, connections: 0 },
    'a socket that subscribes and unsubscribes 50 times must retain nothing');
});

test('unsubscribing one panel keeps the connection alive for its others', () => {
  const subs = createFilterSubscriptions({ getAgents: agents });
  const conn = { id: 'tab' };
  subs.subscribe(conn, 'a', [[['from', 'chief2']]], { humanId: SKIP });
  subs.subscribe(conn, 'b', [[['from', 'todd']]], { humanId: SKIP });
  subs.unsubscribe(conn, 'a');
  assert.deepEqual(subs.stats(), { distinctFilters: 1, subscriptions: 1, connections: 1 });
  assert.equal(subs.match(chat(TODD.id, SKIP)).length, 1);
});

// --- structural guard: one predicate, not two ---

test('verdict() is the only place membership is decided', async () => {
  // Skip: "the filtering code should just be one fucking thing. Not two
  // fucking things that use the same object." Sharing the evaluator is not
  // enough — two call sites that each decide membership are two
  // implementations, and two implementations drift. That is how live and
  // history ended up dropping different sets of protocol messages.
  //
  // This asserts it structurally rather than by convention: the module may
  // call the evaluator exactly once, inside verdict(). match() delegates.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(
    fileURLToPath(new URL('../server/lib/filter-subscriptions.mjs', import.meta.url)),
    'utf8'
  );
  const calls = src.match(/matchesFleetFilter\(/g) || [];
  assert.equal(calls.length, 1,
    `matchesFleetFilter is called ${calls.length} times; it must be called once, inside verdict()`);

  const verdictBody = src.slice(src.indexOf('function verdict('), src.indexOf('function match('));
  assert.ok(verdictBody.includes('matchesFleetFilter('),
    'the single call must be the one inside verdict()');
});

test('match() and verdict() cannot disagree, because match() delegates', () => {
  const subs = createFilterSubscriptions({ getAgents: agents });
  const filter = [[['dm', 'chief2']]];
  const who = { humanId: SKIP, humanName: 'skip' };
  subs.subscribe({}, 'p', filter, who);
  for (const event of [chat(CHIEF.id, SKIP), chat(TODD.id, SKIP), chat(SKIP, CHIEF.id)]) {
    assert.equal(
      subs.match(event).length > 0,
      subs.verdict(filter, event, who),
      `match() and verdict() disagree on ${JSON.stringify(event)}`
    );
  }
});

test('the module contains no raw NUL bytes — it must stay text to git', async () => {
  // A raw NUL makes git treat the file as binary: no diff, no line-level
  // review, and grep goes quiet. The separator itself is fine; embedding it
  // as a byte instead of the escape is not. Caught in review after git
  // refused to show a diff of this file.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const buf = readFileSync(fileURLToPath(new URL('../server/lib/filter-subscriptions.mjs', import.meta.url)));
  assert.equal(buf.includes(0), false, 'raw NUL byte in source — use the escape sequence');
});
