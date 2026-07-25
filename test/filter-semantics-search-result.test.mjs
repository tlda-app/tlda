import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fleetSearchResultAgentChatFilter,
  fleetSearchResultParticipantLabel,
  fleetSearchResultTargetAgentLabel,
} from '../shared/filter-semantics.mjs';

test('search result participant labels use live roster names first', () => {
  const result = {
    agentId: 'fleet:old-chief',
    agentName: 'chief-old',
    from: 'fleet:old-chief',
    fromName: 'chief-old',
  };
  const agents = [{ id: 'fleet:old-chief', friendly_name: 'chief', labels: [] }];

  assert.equal(fleetSearchResultParticipantLabel(result, 'fleet:old-chief', { agents }), 'chief');
  assert.equal(fleetSearchResultTargetAgentLabel(result, { agents }), 'chief');
  assert.deepEqual(fleetSearchResultAgentChatFilter(result, { agents }), [
    [['from', 'chief']],
    [['to', 'chief']],
  ]);
});

test('search result participant labels fall back to stamped historical names', () => {
  const result = {
    agentId: 'fleet:gone',
    agentName: 'ghost',
    from: 'fleet:skip',
    fromName: 'skip',
    to: 'fleet:gone',
    toName: 'ghost',
  };
  const agents = [{ id: 'fleet:skip', friendly_name: 'skip', human: true, labels: [] }];

  assert.equal(fleetSearchResultParticipantLabel(result, 'fleet:gone', { agents }), 'ghost');
  assert.equal(fleetSearchResultTargetAgentLabel(result, { agents, humanId: 'fleet:skip' }), 'ghost');
  assert.deepEqual(fleetSearchResultAgentChatFilter(result, { agents, humanId: 'fleet:skip' }), [
    [['from', 'ghost']],
    [['to', 'ghost']],
  ]);
});
