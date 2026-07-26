#!/usr/bin/env node
// A shared file must be on the recipient's machine before its message is in
// their inbox. Materialization is queued *after* the event is inserted and the
// recipient is woken, so an agent could read a message and act on a file that
// was not there yet.
//
// The hold is a read-time filter: the row stays unread, so a held message is
// delayed, never lost. `failed` and `skipped` are terminal and must still be
// delivered — a broken reference has to be visible. And the hold is bounded, so
// a materialization that never reports back surfaces the message anyway rather
// than hiding it forever.
//
// This exercises the predicate directly; it is the whole of the decision.
import assert from 'node:assert/strict'

const MATERIALIZATION_HOLD_MS = 60_000
function hasUnsettledRefs(message, recipientId) {
  const refs = message?.metadata?.recipient_refs?.[recipientId]?.attachments
  if (!refs || typeof refs !== 'object') return false
  const pending = Object.values(refs).some(ref => ref?.state === 'pending')
  if (!pending) return false
  const sentAt = Date.parse(message.timestamp)
  if (!Number.isFinite(sentAt)) return false
  return Date.now() - sentAt < MATERIALIZATION_HOLD_MS
}

const to = 'fleet:reader'
const msg = (attachments, ageMs = 0) => ({
  timestamp: new Date(Date.now() - ageMs).toISOString(),
  metadata: { recipient_refs: { [to]: { attachments } } },
})

// An ordinary message has no refs and is never held.
assert.equal(hasUnsettledRefs({ timestamp: new Date().toISOString(), metadata: {} }, to), false)
assert.equal(hasUnsettledRefs({ timestamp: new Date().toISOString() }, to), false)

// Bytes not there yet: hold.
assert.equal(hasUnsettledRefs(msg({ 0: { state: 'pending' } }), to), true)

// Bytes landed: deliver.
assert.equal(hasUnsettledRefs(msg({ 0: { state: 'available' } }), to), false)

// Terminal failures are delivered, not hidden — the reference renders as
// visibly unavailable and the sender is told to amend.
assert.equal(hasUnsettledRefs(msg({ 0: { state: 'failed' } }), to), false)
assert.equal(hasUnsettledRefs(msg({ 0: { state: 'skipped' } }), to), false)

// One pending among several still holds the message: it arrives complete.
assert.equal(hasUnsettledRefs(msg({ 0: { state: 'available' }, 1: { state: 'pending' } }), to), true)

// Bounded: a materialization that never reported back must not swallow the
// message. Past the hold window it is delivered with its refs unresolved.
assert.equal(hasUnsettledRefs(msg({ 0: { state: 'pending' } }, MATERIALIZATION_HOLD_MS + 1000), to), false)

// A message held for one recipient is not held for another.
assert.equal(hasUnsettledRefs(msg({ 0: { state: 'pending' } }), 'fleet:someone-else'), false)

// An unparseable timestamp must not become an infinite hold.
assert.equal(
  hasUnsettledRefs({ timestamp: 'not-a-date', metadata: { recipient_refs: { [to]: { attachments: { 0: { state: 'pending' } } } } } }, to),
  false,
)

console.log('inbox materialization hold: ok')
