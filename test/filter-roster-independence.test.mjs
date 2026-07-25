// Characterization test: a chat filter's answer is a function of the agent
// roster the caller hands it.
//
// This is the whole reason filter evaluation is moving to the server. The
// evaluator resolves a filter's NAME terms through `labelSetForParticipant`,
// which can only produce an agent's friendly name if that agent is in the
// roster it was given; otherwise the participant answers to its bare id alone.
//
// In the browser that roster is `_agents`: at most 100 rows per page out of a
// fleet of 500+, with hibernating agents deliberately not hydrated. Every one
// of Skip's 19 chat panels filters by friendly name, so a panel whose agent had
// fallen out of the loaded pages matched nothing at all — while the radio HUD,
// which compares raw ids and consults no roster, kept showing the same
// messages. That is the "the messages were fucking there, I was seeing them in
// radio" report, reduced to a pure function.
//
// These assertions pin the defect rather than pretend it away. When evaluation
// runs server-side against the authoritative, unpaginated roster, the partial
// case stops being reachable — the caller can no longer supply a roster that is
// missing a live participant. At that point the `notEqual`s below become
// `equal`s and this file turns into the regression guard.

import assert from 'node:assert/strict';
import test from 'node:test';

import { matchesFleetFilter, resolveFleetFilter } from '../shared/filter-semantics.mjs';

const AGENT = { id: 'fleet:b6d7cc18', friendly_name: 'chief2', labels: [] };
const HUMAN = { humanId: 'fleet:skip', humanName: 'skip' };

// What the server always holds.
const authoritative = { agents: [AGENT], ...HUMAN };
// The same session after that agent hibernates or falls past the page boundary.
const partial = { agents: [], ...HUMAN };

const fromAgent = { type: 'chat', from: AGENT.id, to: HUMAN.humanId, text: 'hi' };
const toAgent = { type: 'chat', from: HUMAN.humanId, to: AGENT.id, text: 'hi' };

test('a name filter matches on the authoritative roster', () => {
  for (const [label, filter, event] of [
    ['from:', [[['from', 'chief2']]], fromAgent],
    ['to:', [[['to', 'chief2']]], toAgent],
    ['bare', [['chief2']], fromAgent],
    ['dm:', [[['dm', 'chief2']]], fromAgent],
  ]) {
    assert.equal(matchesFleetFilter(filter, event, authoritative), true, `${label} should match`);
  }
});

test('the same name filter matches NOTHING on a partial roster — the defect', () => {
  for (const [label, filter, event] of [
    ['from:', [[['from', 'chief2']]], fromAgent],
    ['to:', [[['to', 'chief2']]], toAgent],
    ['bare', [['chief2']], fromAgent],
    ['dm:', [[['dm', 'chief2']]], fromAgent],
  ]) {
    assert.equal(
      matchesFleetFilter(filter, event, partial),
      false,
      `${label} unexpectedly matched without the agent in the roster — if this ` +
      `fails, resolution no longer depends on the caller's roster and the ` +
      `assertions in this file should be flipped to equality`
    );
  }
});

test('an id filter is immune — which is why radio never lost a message', () => {
  const filter = [[['from', AGENT.id]]];
  assert.equal(matchesFleetFilter(filter, fromAgent, authoritative), true);
  assert.equal(matchesFleetFilter(filter, fromAgent, partial), true);
});

test('direction survives resolution — to: must not match a message FROM the agent', () => {
  assert.equal(matchesFleetFilter([[['to', 'chief2']]], fromAgent, authoritative), false);
});

test('history-fetch targets collapse to empty on a partial roster', () => {
  // resolveFleetFilter picks which agents history is fetched for. With the name
  // unresolved it asks for nobody, so the panel is empty rather than merely
  // stale — both halves of the symptom from one cause.
  const filter = [[['from', 'chief2']], [['to', 'chief2']]];
  assert.deepEqual([...resolveFleetFilter(filter, authoritative)], [AGENT.id]);
  assert.deepEqual([...resolveFleetFilter(filter, partial)], []);
});
