import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldDeliverChannelTurn } from '../mcp-server/fleet-tools.mjs'

test('direct chat and delegate events create a channel turn', () => {
  assert.equal(shouldDeliverChannelTurn({ eventType: 'chat', isDirectTarget: true }), true)
  assert.equal(shouldDeliverChannelTurn({ eventType: 'delegate', isDirectTarget: true }), true)
})

// This assertion used to read `isDirectTarget: false` → false, under the title
// "wiretap and non-message events do not create a channel turn". It was added by
// 21b1512ea (2026-08-11, "Reapply: Restrict fleet wakes to direct messages"),
// the same commit that introduced the gate it was asserting.
//
// Before that commit the handler admitted an observer and delivered it -- the
// only checks were sender-is-self and source-is-terminal. So observer delivery
// was not a decision that was taken; it was removed as a side effect of a change
// about WAKES, and the test shipped in the same commit made the removal look
// specified. Restricting wakes is still honoured: the wake-ack block is guarded
// on isDirectTarget separately, so an observer is notified and never answers
// someone else's ack.
//
// What the case below actually tests is an agent who is NEITHER addressed nor an
// observer, which is the real "no turn" case and the control for the tests above.
test('an agent who is neither addressed nor an observer gets no channel turn', () => {
  assert.equal(shouldDeliverChannelTurn({ eventType: 'chat', isDirectTarget: false, isWiretapTarget: false }), false)
})

test('non-message events do not create a channel turn', () => {
  assert.equal(shouldDeliverChannelTurn({
    eventType: 'chat',
    fromId: 'fleet:tlda',
    isDirectTarget: true,
    data: { metadata: { type: 'build_result' } },
  }), false)
  assert.equal(shouldDeliverChannelTurn({ eventType: 'task_done', isDirectTarget: true }), false)
  assert.equal(shouldDeliverChannelTurn({ eventType: 'timer', isDirectTarget: true }), false)
})

test('channel notifications create a turn only for wake acknowledgements', () => {
  assert.equal(shouldDeliverChannelTurn({
    eventType: 'channel-notification',
    isDirectTarget: true,
    data: { metadata: { wake_ack_id: 'ack-1' } },
  }), true)
  assert.equal(shouldDeliverChannelTurn({
    eventType: 'channel-notification',
    isDirectTarget: true,
    data: { metadata: { type: 'build_result' } },
  }), false)
})

// The incident: three subscriptions of the form `A <> B` held by an agent who
// was neither A nor B went silent across 16 events, while that same agent's
// `to:me` row delivered. The subscriptions matched -- the server put the agent
// in `wiretap_cc` and sent the event -- and the client dropped it here.
//
// The controls matter as much as the case. A subscription whose owner happens
// to be one of the two parties delivered throughout, which made the operator
// look innocent and the subscriber look special. It was neither: what varied
// was whether the subscriber was a party to the traffic it watched.
test('an observer gets a channel turn for traffic between two other parties', () => {
  assert.equal(shouldDeliverChannelTurn({
    eventType: 'chat',
    fromId: 'fleet:skip',
    isDirectTarget: false,
    isWiretapTarget: true,
  }), true)
  assert.equal(shouldDeliverChannelTurn({
    eventType: 'delegate',
    fromId: 'fleet:skip',
    isDirectTarget: false,
    isWiretapTarget: true,
  }), true)
})

test('an observer is still refused the turns a direct target is refused', () => {
  // System chatter and tlda's own messages are suppressed for everyone. An
  // observer must not become a way around that.
  assert.equal(shouldDeliverChannelTurn({
    eventType: 'chat', fromId: 'fleet:tlda', isDirectTarget: false, isWiretapTarget: true,
  }), false)
  assert.equal(shouldDeliverChannelTurn({
    eventType: 'chat', fromId: 'fleet:skip', isDirectTarget: false, isWiretapTarget: true,
    data: { metadata: { type: 'build_result' } },
  }), false)
  assert.equal(shouldDeliverChannelTurn({
    eventType: 'task_done', isDirectTarget: false, isWiretapTarget: true,
  }), false)
})
