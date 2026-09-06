import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { initializeRecipientRefs, setRecipientAttachmentState } from '../../shared/inbox-reference-materialization.mjs'
import { FleetStore } from './fleet-store.mjs'

function supersede(metadata, recipientId, attachmentId) {
  const next = structuredClone(metadata)
  const recipient = next.recipient_refs[recipientId]
  recipient.placeholder_superseded_at = '2026-09-06T00:00:00.000Z'
  recipient.placeholder_superseded_attachment_ids = [String(attachmentId)]
  return next
}

async function settleAvailable(store, eventId, recipientId, attachmentId, record) {
  if (typeof store.updateRecipientAttachment === 'function') {
    return store.updateRecipientAttachment(eventId, recipientId, attachmentId, record, { supersede: true })
  }
  // Parent behavior: both writes derive a full replacement from the same pending row.
  // Controlled delays make the placeholder replacement land last, reproducing chat#3807445.
  const pending = store.getEventById(eventId).metadata
  const available = setRecipientAttachmentState(pending, recipientId, attachmentId, record)
  const placeholder = supersede(pending, recipientId, attachmentId)
  await Promise.all([
    new Promise(resolve => setTimeout(() => { store.replaceEventMetadata(eventId, available); resolve() }, 5)),
    new Promise(resolve => setTimeout(() => { store.replaceEventMetadata(eventId, placeholder); resolve() }, 15)),
  ])
  return { metadata: store.getEventById(eventId).metadata, supersededNow: true }
}

async function settleFailed(store, eventId, recipientId, attachmentId, record) {
  if (typeof store.updateRecipientAttachment === 'function') {
    return store.updateRecipientAttachment(eventId, recipientId, attachmentId, record)
  }
  const current = store.getEventById(eventId).metadata
  store.replaceEventMetadata(eventId, setRecipientAttachmentState(current, recipientId, attachmentId, record))
}

test('recipient attachment terminal updates preserve every recipient and attachment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-recipient-attachment-settlement-'))
  const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
  try {
    const attachments = [0, 1].map(id => ({ id, type: 'file', name: `${id}.txt`, url: `https://fleet.test/${id}`, sha256: `hash-${id}` }))
    let metadata = {}
    for (const recipient of ['fleet:a', 'fleet:b']) {
      metadata = initializeRecipientRefs(metadata, recipient, attachments, { sourceAgent: 'fleet:sender' })
    }
    const inserted = await store.insertEventRecord({
      type: 'chat', timestamp: new Date().toISOString(), from: 'fleet:sender', to: ['fleet:a', 'fleet:b'],
      text: '{{att:0}} {{att:1}}', metadata, unread: false,
    }, { notify: false })

    await Promise.all([
      settleAvailable(store, inserted.id, 'fleet:a', 0, { state: 'available', status: 'ready', localPath: '/a/0' }),
      settleFailed(store, inserted.id, 'fleet:a', 1, { state: 'failed', status: 'failed', error: 'copy failed' }),
      settleAvailable(store, inserted.id, 'fleet:b', 0, { state: 'available', status: 'ready', localPath: '/b/0' }),
      settleAvailable(store, inserted.id, 'fleet:b', 1, { state: 'available', status: 'ready', localPath: '/b/1' }),
    ])

    const refs = store.getEventById(inserted.id).metadata.recipient_refs
    assert.equal(refs['fleet:a'].attachments['0'].state, 'available')
    assert.equal(refs['fleet:a'].attachments['1'].state, 'failed')
    assert.equal(refs['fleet:b'].attachments['0'].state, 'available')
    assert.equal(refs['fleet:b'].attachments['1'].state, 'available')
    assert.deepEqual(refs['fleet:a'].placeholder_superseded_attachment_ids, ['0'])
    assert.deepEqual(refs['fleet:b'].placeholder_superseded_attachment_ids.sort(), ['0', '1'])
  } finally {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
