import assert from 'node:assert/strict';
import test from 'node:test';

import { createFilterSubscriptions, filterKey } from '../server/lib/filter-subscriptions.mjs';
import { fleetFilterSendTargets } from '../shared/filter-semantics.mjs';

const CHIEF = { id: 'fleet:b6d7cc18', friendly_name: 'chief2', labels: [] };
const CHILD = { id: 'fleet:child', parent_agent_id: CHIEF.id, friendly_name: 'chief2:Plan', labels: [] };
const GRANDCHILD = { id: 'fleet:grandchild', parent_agent_id: CHILD.id, friendly_name: 'chief2:Plan:Probe', labels: [] };
const TODD = { id: 'fleet:t0dd', friendly_name: 'todd', labels: [] };
const SKIP = 'fleet:skip';

const agents = () => [CHIEF, TODD];
const chat = (from, to) => ({ type: 'chat', from, to, text: 'hi' });
const makeSubs = (roster = agents) => createFilterSubscriptions({
  getAgentsByIds: async (agentIds) => {
    const ids = new Set(agentIds);
    return roster().filter(agent => ids.has(agent.id));
  },
  loadMembershipSpans: async () => [],
});
const statsCore = (subs) => {
  const { perFilter, ...core } = subs.stats();
  return core;
};

test('equal filters share one key regardless of term or clause order', async () => {
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

test('an event is evaluated once per distinct filter, not once per subscription', async () => {
  const subs = makeSubs();
  const filter = [[['from', 'chief2']]];
  // Nineteen panels in ONE tab, one filter — Skip's actual shape.
  const tab = { id: 'tab' };
  for (let i = 0; i < 19; i++) subs.subscribe(tab, `panel-${i}`, filter, { humanId: SKIP });

  const matched = await subs.match(chat(CHIEF.id, SKIP));
  assert.equal(matched.length, 19, 'every subscription should receive it');
  assert.equal(matched.evaluations, 1, 'but the filter should be evaluated once');
  assert.deepEqual(statsCore(subs), { distinctFilters: 1, subscriptions: 19, connections: 1 });
});

test('the name resolves here even though a browser roster would have missed it', async () => {
  // This is the defect the move exists to remove: the same call with agents: []
  // returns no match. On the server the roster is authoritative, so it cannot.
  const subs = makeSubs();
  const conn = {};
  subs.subscribe(conn, 'p', [[['from', 'chief2']]], { humanId: SKIP });
  assert.equal((await subs.match(chat(CHIEF.id, SKIP))).length, 1);

  const starved = makeSubs(() => []);
  starved.subscribe({}, 'p', [[['from', 'chief2']]], { humanId: SKIP });
  assert.equal((await starved.match(chat(CHIEF.id, SKIP))).length, 0);
});

test('non-matching traffic is delivered to nobody', async () => {
  const subs = makeSubs();
  subs.subscribe({}, 'p', [[['from', 'chief2']]], { humanId: SKIP });
  assert.equal((await subs.match(chat(TODD.id, SKIP))).length, 0);
});

test('direction is preserved through the registry', async () => {
  const subs = makeSubs();
  subs.subscribe({}, 'p', [[['to', 'chief2']]], { humanId: SKIP });
  assert.equal((await subs.match(chat(CHIEF.id, SKIP))).length, 0, 'to: must not match a message FROM');
  assert.equal((await subs.match(chat(SKIP, CHIEF.id))).length, 1, 'to: must match a message TO');
});

test('team filters keep the parent relation and add descendant activity only', async () => {
  const roster = () => [CHIEF, CHILD, GRANDCHILD, TODD];
  const subs = makeSubs(roster);
  const teamFrom = [[['team-from', CHIEF.id]]];
  const teamTo = [[['team-to', CHIEF.id]]];
  const withRoster = event => ({ ...event, _filter_agents: roster() });

  for (const event of [
    chat(CHIEF.id, SKIP),
    chat(CHILD.id, SKIP),
    chat(GRANDCHILD.id, SKIP),
  ]) {
    assert.equal(await subs.verdict(teamFrom, withRoster(event), { humanId: SKIP }), true);
  }
  assert.equal(await subs.verdict(teamFrom, withRoster(chat(TODD.id, SKIP)), { humanId: SKIP }), false);

  assert.equal(await subs.verdict(teamTo, withRoster(chat(SKIP, CHIEF.id)), { humanId: SKIP }), true);
  assert.equal(await subs.verdict(teamTo, withRoster(chat(CHILD.id, SKIP)), { humanId: SKIP }), true);
  assert.equal(await subs.verdict(teamTo, withRoster(chat(GRANDCHILD.id, SKIP)), { humanId: SKIP }), true);
  assert.equal(
    await subs.verdict(teamTo, withRoster({ type: 'activity', agent: CHIEF.id, _activity: true }), { humanId: SKIP }),
    true,
    'the parent must retain the to pane’s ordinary activity semantics',
  );
  assert.equal(
    await subs.verdict(teamTo, withRoster(chat(CHIEF.id, SKIP)), { humanId: SKIP }),
    false,
    'a to/team pill must not turn parent-sent traffic into a symmetric team relation',
  );
  assert.equal(await subs.verdict(teamTo, withRoster(chat(SKIP, CHILD.id)), { humanId: SKIP }), false);
  assert.deepEqual(fleetFilterSendTargets(teamTo), [CHIEF.id]);
  assert.deepEqual(fleetFilterSendTargets(teamFrom), []);
  assert.deepEqual(
    fleetFilterSendTargets([[['to', CHIEF.friendly_name]], [['team-to', CHIEF.id]]], { agents: roster() }),
    [CHIEF.friendly_name],
    'the parent id and friendly name must not become duplicate composer recipients',
  );
});

test('dm: is scoped per subscriber, and two humans on one filter cost two evaluations', async () => {
  const subs = makeSubs();
  const filter = [[['dm', 'chief2']]];
  subs.subscribe({ a: 1 }, 'skip-panel', filter, { humanId: SKIP });
  subs.subscribe({ b: 1 }, 'other-panel', filter, { humanId: 'fleet:dmitry' });

  const matched = await subs.match(chat(CHIEF.id, SKIP));
  assert.deepEqual(matched.map((m) => m.subId), ['skip-panel'],
    "a DM to Skip must not be delivered to another human's dm panel");
  assert.equal(matched.evaluations, 2, 'one evaluation per distinct (filter, human)');
});

test('a closed connection drops every subscription it held', async () => {
  const subs = makeSubs();
  const gone = { id: 'gone' };
  const stays = { id: 'stays' };
  subs.subscribe(gone, 'p1', [[['from', 'chief2']]], { humanId: SKIP });
  subs.subscribe(gone, 'p2', [[['from', 'todd']]], { humanId: SKIP });
  subs.subscribe(stays, 'p3', [[['from', 'chief2']]], { humanId: SKIP });

  assert.equal(subs.dropConnection(gone), 2);
  assert.deepEqual(statsCore(subs), { distinctFilters: 1, subscriptions: 1, connections: 1 });
  assert.deepEqual((await subs.match(chat(CHIEF.id, SKIP))).map((m) => m.subId), ['p3']);
});

test('unsubscribing the last holder removes the filter entirely', async () => {
  const subs = makeSubs();
  const conn = {};
  subs.subscribe(conn, 'p', [[['from', 'chief2']]], { humanId: SKIP });
  subs.unsubscribe(conn, 'p');
  assert.equal(subs.stats().distinctFilters, 0);
  assert.equal((await subs.match(chat(CHIEF.id, SKIP))).length, 0);
});

test('two connections with the same filter still cost one evaluation', async () => {
  const subs = makeSubs();
  const filter = [[['from', 'chief2']], [['to', 'chief2']]];
  subs.subscribe({ a: 1 }, 'p', filter, { humanId: SKIP });
  // Same filter written with the clauses the other way round.
  subs.subscribe({ b: 1 }, 'p', [[['to', 'chief2']], [['from', 'chief2']]], { humanId: SKIP });

  const matched = await subs.match(chat(CHIEF.id, SKIP));
  assert.equal(matched.length, 2);
  assert.equal(matched.evaluations, 1, 'clause order must not split the evaluation');
});

// --- regressions from chat-lock's adversarial review of 150448ee ---

test('humanName reaches the evaluator — a filter naming the human by name matches', async () => {
  // Defect 1: match() built { agents, humanId } while the browser passes
  // { agents, humanId, humanName }. Without humanName the human answers to the
  // label `user` instead of their own name, so one file behaved two ways.
  const subs = makeSubs();
  subs.subscribe({}, 'p', [[['from', 'skip']]], { humanId: SKIP, humanName: 'skip' });
  assert.equal((await subs.match(chat(SKIP, CHIEF.id))).length, 1,
    'the human must answer to their own name, not to "user"');
});

test('verdict() answers the same question as match(), for live/history equivalence', async () => {
  const subs = makeSubs();
  const filter = [[['from', 'chief2']]];
  subs.subscribe({}, 'p', filter, { humanId: SKIP, humanName: 'skip' });
  const event = chat(CHIEF.id, SKIP);
  assert.equal(await subs.verdict(filter, event, { humanId: SKIP, humanName: 'skip' }), true);
  assert.equal((await subs.match(event)).length, 1);
  const other = chat(TODD.id, SKIP);
  assert.equal(await subs.verdict(filter, other, { humanId: SKIP, humanName: 'skip' }), false);
  assert.equal((await subs.match(other)).length, 0);
});

test('unsubscribe does not leak filter keys into byConn', async () => {
  // Defect 2: unsubscribe cleaned byFilter and never touched byConn, so a
  // long-lived socket accumulated dead keys as its panels opened and refiltered.
  const subs = makeSubs();
  const conn = { id: 'long-lived' };
  for (let i = 0; i < 50; i++) {
    subs.subscribe(conn, 'panel', [[['from', `agent-${i}`]]], { humanId: SKIP });
    subs.unsubscribe(conn, 'panel');
  }
  assert.deepEqual(statsCore(subs), { distinctFilters: 0, subscriptions: 0, connections: 0 },
    'a socket that subscribes and unsubscribes 50 times must retain nothing');
});

test('unsubscribing one panel keeps the connection alive for its others', async () => {
  const subs = makeSubs();
  const conn = { id: 'tab' };
  subs.subscribe(conn, 'a', [[['from', 'chief2']]], { humanId: SKIP });
  subs.subscribe(conn, 'b', [[['from', 'todd']]], { humanId: SKIP });
  subs.unsubscribe(conn, 'a');
  assert.deepEqual(statsCore(subs), { distinctFilters: 1, subscriptions: 1, connections: 1 });
  assert.equal((await subs.match(chat(TODD.id, SKIP))).length, 1);
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

test('match() and verdict() cannot disagree, because match() delegates', async () => {
  const subs = makeSubs();
  const filter = [[['dm', 'chief2']]];
  const who = { humanId: SKIP, humanName: 'skip' };
  subs.subscribe({}, 'p', filter, who);
  for (const event of [chat(CHIEF.id, SKIP), chat(TODD.id, SKIP), chat(SKIP, CHIEF.id)]) {
    assert.equal(
      (await subs.match(event)).length > 0,
      await subs.verdict(filter, event, who),
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

test('re-subscribing a subId with a NEW filter replaces it — no duplicate delivery', async () => {
  // Answering a question chat-lock asked about this registry, which their
  // identity re-send fix depends on. Their case (same subId, same filter,
  // updated identity) was already correct. The case neither of us checked was
  // not: a panel that REFILTERS kept its old entry under the old filterKey, so
  // it matched both filters and received every qualifying event twice.
  //
  // Refiltering is the workaround people reach for when a panel looks stuck,
  // which is exactly when duplicate delivery would land.
  const s = makeSubs();
  const conn = { id: 'tab' };
  s.subscribe(conn, 'p', [[['from', 'chief2']]], { humanId: SKIP, humanName: 'skip' });
  s.subscribe(conn, 'p', [[['to', 'chief2']]], { humanId: SKIP, humanName: 'skip' });
  assert.deepEqual(statsCore(s), { distinctFilters: 1, subscriptions: 1, connections: 1 },
    'the old filter entry survived the refilter');
  assert.equal((await s.match(chat(CHIEF.id, SKIP))).length, 0,
    'the replaced from: filter still matched — a stale entry is still delivering');
  assert.equal((await s.match(chat(SKIP, CHIEF.id))).length, 1);
});

test('re-subscribing the SAME filter updates identity in place', async () => {
  // The identity-refresh path chat-lock built. dm: cannot match a null humanId,
  // so this is the difference between a dead subscription and a live one.
  const s = makeSubs();
  const conn = { id: 'tab' };
  const F = [[['dm', 'chief2']]];
  s.subscribe(conn, 'p', F, { humanId: null, humanName: null });
  assert.equal((await s.match(chat(CHIEF.id, SKIP))).length, 0, 'a null identity cannot match dm:');
  s.subscribe(conn, 'p', F, { humanId: SKIP, humanName: 'skip' });
  assert.equal((await s.match(chat(CHIEF.id, SKIP))).length, 1, 'the re-send must revive it');
  assert.deepEqual(statsCore(s), { distinctFilters: 1, subscriptions: 1, connections: 1 });
});
