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
