// history() must return full pages and a cursor that skips nothing.
//
// The shipped defect this exists to prevent (buildChatHistoryResponse): the
// content filter ran AFTER the page maths, so hasMore and the shift() were
// computed on unfiltered rows and a page of `cap` containing rejected rows came
// back short with a nextCursor that looked correct.
//
// It must also decide membership only through verdict(), so live push and
// history cannot disagree.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createFilterSubscriptions } from '../server/lib/filter-subscriptions.mjs';

const CHIEF = { id: 'fleet:b6d7cc18', friendly_name: 'chief2', labels: [] };
const NOISE = { id: 'fleet:n0ise', friendly_name: 'noisy', labels: [] };
const SKIP = 'fleet:skip';
const who = { humanId: SKIP, humanName: 'skip' };

const subs = () => createFilterSubscriptions({ getAgents: () => [CHIEF, NOISE] });
const FILTER = [[['from', 'chief2']]];

// A synthetic corpus, newest first, where only 1 row in 5 matches the filter.
function corpus(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const from = i % 5 === 0 ? CHIEF.id : NOISE.id;
    rows.push({
      type: 'chat',
      from,
      to: SKIP,
      text: `m${i}`,
      timestamp: new Date(Date.UTC(2026, 6, 25, 0, 0, 0) - i * 1000).toISOString(),
    });
  }
  return rows;
}

/** Stand-in for the SQL page: newest-first, strictly older than `before`. */
function pagerOver(rows, calls = []) {
  return async ({ before, limit }) => {
    calls.push({ before, limit });
    const start = before ? rows.findIndex((r) => r.timestamp < before) : 0;
    if (start === -1) return [];
    return rows.slice(start, start + limit);
  };
}

test('a full page is returned even when most candidates are rejected', async () => {
  const rows = corpus(500);
  const s = subs();
  const { events, truncated } = await s.history(FILTER, { ...who, limit: 20, queryPage: pagerOver(rows) });
  assert.equal(events.length, 20, 'short page — the defect this function exists to prevent');
  assert.equal(truncated, false);
  assert.ok(events.every((e) => e.from === CHIEF.id), 'a non-matching row leaked through');
});

test('it over-fetches rather than trusting one pass', async () => {
  const calls = [];
  const s = subs();
  await s.history(FILTER, { ...who, limit: 20, queryPage: pagerOver(corpus(500), calls) });
  assert.ok(calls.length > 1, 'one pass cannot fill a page at a 1-in-5 match rate');
});

test('the cursor skips nothing — paging through yields every match exactly once', async () => {
  const rows = corpus(200);
  const expected = rows.filter((r) => r.from === CHIEF.id).map((r) => r.text);

  const s = subs();
  const seen = [];
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const r = await s.history(FILTER, { ...who, limit: 7, before: cursor, queryPage: pagerOver(rows) });
    seen.push(...r.events.map((e) => e.text));
    cursor = r.nextCursor;
    if (!r.hasMore) break;
  }
  assert.deepEqual(seen, expected, 'paging dropped or duplicated matches');
});

test('an exhausted source reports hasMore false and a null cursor', async () => {
  const s = subs();
  const r = await s.history(FILTER, { ...who, limit: 50, queryPage: pagerOver(corpus(10)) });
  assert.equal(r.hasMore, false);
  assert.equal(r.nextCursor, null);
});

test('a page that cannot be filled says truncated rather than implying exhaustion', async () => {
  // 1-in-5000 match rate against a hard pass cap: the honest answer is "I gave
  // up", not "there is no more".
  const rows = corpus(5000).map((r, i) => (i === 0 ? r : { ...r, from: NOISE.id }));
  const s = subs();
  const r = await s.history(FILTER, { ...who, limit: 50, maxPasses: 3, queryPage: pagerOver(rows) });
  assert.ok(r.events.length < 50);
  assert.equal(r.truncated, true, 'must not present a short page as a complete one');
  assert.equal(r.hasMore, true);
  assert.ok(r.nextCursor, 'a truncated page must still hand back a usable cursor');
});

test('history and live agree, because both go through verdict()', async () => {
  const s = subs();
  s.subscribe({}, 'panel', FILTER, who);
  for (const row of corpus(40)) {
    assert.equal(
      s.match(row).length > 0,
      s.verdict(FILTER, row, who),
      'live delivery disagrees with the predicate'
    );
  }
  const { events } = await s.history(FILTER, { ...who, limit: 8, queryPage: pagerOver(corpus(40)) });
  for (const e of events) {
    assert.equal(s.verdict(FILTER, e, who), true, 'history returned a row the predicate rejects');
  }
});
