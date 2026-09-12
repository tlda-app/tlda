import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { decideSubscriptionDelivery } from '../../shared/inbox-attention.mjs'
import { parseFilter } from '../../shared/fleet-labels.mjs'
import { FleetStore } from './fleet-store.mjs'

function withStore(run) {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-singleton-seat-'))
  const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
  try { return run(store) } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function addAgent(store, id, name, labels = []) {
  const now = new Date().toISOString()
  store.upsertAgent({ id, friendly_name: name, labels, registered_at: now, last_seen: now })
}

test('singleton definitions are fixed at creation and reject a second living holder', () => withStore(store => {
  assert.equal(Boolean(store.getLabelDefinition('on-call')?.singleton), true)
  store.defineLabel('review-lead', { singleton: true, actorId: 'fleet:skip' })
  addAgent(store, 'fleet:existing', 'existing')
  store.mutateAgentLabels('fleet:existing', 'add', 'review-lead')
  assert.throws(
    () => store.defineLabel('review-lead', { singleton: false, actorId: 'fleet:skip' }),
    /Singleton-ness is set when a label is created/,
  )

  addAgent(store, 'fleet:first', 'first')
  addAgent(store, 'fleet:second', 'second')
  store.mutateAgentLabels('fleet:first', 'add', 'on-call')
  assert.throws(
    () => store.mutateAgentLabels('fleet:second', 'add', 'on-call'),
    /"on-call" is a singleton label and agent fleet:first holds it/,
  )
  assert.deepEqual(store.getAgent('fleet:second').labels, [])
}))

test('chief acquisition is atomic, renames the colliding name, and persists split policies', () => withStore(store => {
  addAgent(store, 'fleet:sender', 'sender')
  addAgent(store, 'fleet:named-chief', 'chief')
  addAgent(store, 'fleet:incoming', 'incoming')

  const result = store.assignSingletonSeat({
    label: 'chief', agentId: 'fleet:incoming', actorId: 'fleet:skip', batchPolicy: 'batch(default)',
  })
  assert.equal(Boolean(store.getLabelDefinition('chief')?.singleton), true)
  assert.equal(store.getAgent('fleet:named-chief').friendly_name, 'chief-agent')
  assert.deepEqual(store.getAgent('fleet:incoming').labels, ['chief'])
  assert.equal(result.subscriptions.direct.notification_policy, 'immediate')
  assert.equal(result.subscriptions.labels.notification_policy, 'batch(default)')

  const labelDeliveries = store.resolveSubscriptionDeliveries(
    'fleet:sender', 'fleet:incoming', 'chat', parseFilter('chief'),
  ).filter(row => row.recipient === 'fleet:incoming')
  assert.deepEqual(labelDeliveries.map(row => [row.query, row.notification_policy]), [
    ['to:my_labels', 'batch(default)'],
  ])
  assert.equal(decideSubscriptionDelivery({ policy: labelDeliveries[0].notification_policy }).delivery, 'batched')

  const directDeliveries = store.resolveSubscriptionDeliveries(
    'fleet:sender', 'fleet:incoming', 'chat', parseFilter('fleet:incoming'),
  ).filter(row => row.recipient === 'fleet:incoming')
  assert.ok(directDeliveries.some(row => row.query === 'to:me' && row.notification_policy === 'immediate'))
  assert.equal(decideSubscriptionDelivery({ policy: 'immediate' }).delivery, 'notified')
}))

test('occupied chief rejects until explicit transfer, then restores the outgoing policy', () => withStore(store => {
  addAgent(store, 'fleet:first', 'first')
  addAgent(store, 'fleet:second', 'second')
  store.assignSingletonSeat({ label: 'chief', agentId: 'fleet:first', actorId: 'fleet:skip' })

  assert.throws(
    () => store.assignSingletonSeat({ label: 'chief', agentId: 'fleet:second', actorId: 'fleet:skip' }),
    /held by first \(fleet:first\).*Todd transfer chief to second/,
  )
  assert.deepEqual(store.getAgent('fleet:first').labels, ['chief'])
  assert.deepEqual(store.getAgent('fleet:second').labels, [])

  const moved = store.assignSingletonSeat({
    label: 'chief', agentId: 'fleet:second', actorId: 'fleet:skip', transfer: true,
  })
  assert.equal(moved.previous_holder.id, 'fleet:first')
  assert.deepEqual(store.getAgent('fleet:first').labels, [])
  assert.deepEqual(store.getAgent('fleet:second').labels, ['chief'])
  const outgoingGroup = store.getSubscriptionsByOwner('fleet:first').find(row => row.query === 'to:my_labels')
  assert.equal(outgoingGroup.notification_policy, 'immediate')
}))

test('migration atomically removes every prior living holder', () => withStore(store => {
  addAgent(store, 'fleet:first', 'first', ['on-call'])
  addAgent(store, 'fleet:second', 'second')
  addAgent(store, 'fleet:incoming', 'incoming')
  const timestamp = new Date().toISOString()
  store.db.prepare('UPDATE agents SET labels = ? WHERE id = ?').run('["on-call"]', 'fleet:second')
  store._insertLabelStateEvent({
    type: 'label', agentId: 'fleet:second', actorId: 'fleet:skip', labels: ['on-call'],
    operation: 'migration-fixture', timestamp,
  })
  store._rebuildLabelHistoryForAgent('fleet:second')

  const moved = store.assignSingletonSeat({
    label: 'on-call', agentId: 'fleet:incoming', actorId: 'fleet:skip', transfer: true,
  })

  assert.deepEqual(moved.previous_holders.map(holder => holder.id).sort(), ['fleet:first', 'fleet:second'])
  assert.deepEqual(store.getAgent('fleet:first').labels, [])
  assert.deepEqual(store.getAgent('fleet:second').labels, [])
  assert.deepEqual(store.getAgent('fleet:incoming').labels, ['on-call'])
  assert.deepEqual(store.livingHoldersOfLabel('on-call'), ['fleet:incoming'])
}))

test('explicit transfer promotes a non-singleton definition in the same transaction', () => withStore(store => {
  addAgent(store, 'fleet:first', 'first', ['chief'])
  addAgent(store, 'fleet:second', 'second', ['chief'])
  addAgent(store, 'fleet:incoming', 'incoming')
  assert.equal(Boolean(store.getLabelDefinition('chief')?.singleton), false)

  assert.throws(
    () => store.assignSingletonSeat({ label: 'chief', agentId: 'fleet:incoming', actorId: 'fleet:skip' }),
    /already defined as non-singleton/,
  )

  const moved = store.assignSingletonSeat({
    label: 'chief', agentId: 'fleet:incoming', actorId: 'fleet:skip', transfer: true,
  })

  assert.equal(Boolean(store.getLabelDefinition('chief')?.singleton), true)
  assert.deepEqual(moved.previous_holders.map(holder => holder.id).sort(), ['fleet:first', 'fleet:second'])
  assert.deepEqual(store.livingHoldersOfLabel('chief'), ['fleet:incoming'])
}))
