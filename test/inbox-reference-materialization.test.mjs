import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  buildInboxRefPath,
  formatRecipientAttachmentRef,
  initializeRecipientRefs,
  materializeAttachmentBytes,
  recipientAttachmentRef,
  setRecipientAttachmentState,
  sha256Buffer,
} from '../shared/inbox-reference-materialization.mjs'
import { resolveInboxMessage } from '../mcp-server/fleet-tools.mjs'

const resolvers = {
  async resolveChipTokens(text) { return { text, images: [] } },
  resolveTheoremRefs(text) { return text },
  async resolveImages(text) { return { text, images: [] } },
}

test('inbox ref path namespaces by source/date/event and sanitizes filenames', () => {
  const root = path.join(os.tmpdir(), `inbox-ref-path-${process.pid}`)
  const p = buildInboxRefPath({
    root,
    sourceAgent: 'fleet:sender/../../bad',
    date: '2026-07-05T12:00:00.000Z',
    eventId: '../42',
    name: '../evil name.png',
  })
  assert.equal(path.basename(p), 'evil_name.png')
  assert.ok(p.startsWith(root))
  assert.ok(p.includes('event-'))
  assert.equal(path.relative(root, p).split(path.sep).some(part => part === '..' || part.startsWith('..')), false)
})

test('recipient ref metadata patches one recipient attachment without clobbering others', () => {
  let meta = initializeRecipientRefs({}, 'fleet:recipient-a', [
    { type: 'file', id: 0, name: 'a.png', url: 'https://example.test/a.png' },
    { type: 'file', id: 1, name: 'missing.png', broken: true, url: 'https://example.test/missing.png' },
  ])
  assert.equal(recipientAttachmentRef(meta, 'fleet:recipient-a', 0).state, 'pending')
  assert.equal(recipientAttachmentRef(meta, 'fleet:recipient-a', 1), null)

  meta = setRecipientAttachmentState(meta, 'fleet:recipient-b', 0, {
    state: 'failed',
    error: 'no daemon',
  })
  meta = setRecipientAttachmentState(meta, 'fleet:recipient-a', 0, {
    state: 'available',
    status: 'ready',
    localPath: '/tmp/local-a.png',
    contentType: 'image/png',
    hash: 'hash-a',
    sourceAgent: 'fleet:sender',
  })

  assert.equal(recipientAttachmentRef(meta, 'fleet:recipient-a', 0).localPath, '/tmp/local-a.png')
  assert.equal(recipientAttachmentRef(meta, 'fleet:recipient-a', 0).contentType, 'image/png')
  assert.equal(recipientAttachmentRef(meta, 'fleet:recipient-a', 0).hash, 'hash-a')
  assert.equal(recipientAttachmentRef(meta, 'fleet:recipient-a', 0).sourceAgent, 'fleet:sender')
  assert.equal(recipientAttachmentRef(meta, 'fleet:recipient-b', 0).error, 'no daemon')
  assert.equal(formatRecipientAttachmentRef(recipientAttachmentRef(meta, 'fleet:recipient-a', 0)), '/tmp/local-a.png')
  assert.match(formatRecipientAttachmentRef(recipientAttachmentRef(meta, 'fleet:recipient-b', 0)), /materialization failed: no daemon/)
})

test('materializeAttachmentBytes writes atomically under refs root and verifies hash', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-ref-materialize-'))
  try {
    const bytes = Buffer.from('hello recipient refs')
    const sha256 = sha256Buffer(bytes)
    const result = await materializeAttachmentBytes({
      bytes,
      eventId: 123,
      attachmentId: 0,
      sourceAgent: 'fleet:sender',
      name: '../ref.txt',
      expectedSha256: sha256,
      root,
    })
    assert.equal(fs.readFileSync(result.localPath, 'utf8'), 'hello recipient refs')
    assert.equal(result.sha256, sha256)
    assert.equal(result.hash, sha256)
    assert.ok(result.localPath.startsWith(root))
    assert.equal(path.basename(result.localPath), 'ref.txt')
    await assert.rejects(
      materializeAttachmentBytes({
        bytes,
        eventId: 124,
        attachmentId: 0,
        sourceAgent: 'fleet:sender',
        name: 'bad.txt',
        expectedSha256: 'not-the-hash',
        root,
      }),
      /sha256 mismatch/
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('inbox message formatter rewrites attachment tokens to recipient-local state', async () => {
  const available = await resolveInboxMessage({
    id: 1,
    from: 'fleet:sender',
    to: 'fleet:recipient',
    text: 'See {{att:0}}',
    metadata: {
      inline_attachments: [{ type: 'file', id: 0, name: 'repro.txt', url: 'https://server/att' }],
      recipient_refs: {
        'fleet:recipient': {
          attachments: {
            0: { state: 'available', localPath: '/tmp/recipient/repro.txt' },
          },
        },
      },
    },
  }, resolvers)
  assert.match(available.line, /\/tmp\/recipient\/repro\.txt/)
  assert.doesNotMatch(available.line, /\{\{att:0\}\}/)

  const pending = await resolveInboxMessage({
    id: 2,
    from: 'fleet:sender',
    to: 'fleet:recipient',
    text: 'See {{att:0}}',
    metadata: {
      inline_attachments: [{ type: 'file', id: 0, name: 'repro.txt', url: 'https://server/att' }],
      recipient_refs: {
        'fleet:recipient': {
          attachments: {
            0: { state: 'pending' },
          },
        },
      },
    },
  }, resolvers)
  assert.match(pending.line, /materializing on this machine/)

  const fallback = await resolveInboxMessage({
    id: 3,
    from: 'fleet:sender',
    to: 'fleet:recipient',
    text: 'See {{att:0}}',
    metadata: {
      inline_attachments: [{ type: 'file', id: 0, name: 'repro.txt', url: 'https://server/att' }],
    },
  }, resolvers)
  assert.match(fallback.line, /repro\.txt: https:\/\/server\/att/)
})
