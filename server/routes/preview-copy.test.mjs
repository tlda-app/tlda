import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isFlyPrivate, previewCopyReceiverConfig } from './preview-copy.mjs'
import { sendPreviewCopy } from '../lib/publish-copy.mjs'

test('a peer is on the private network and nothing else is', () => {
  assert.equal(isFlyPrivate('fdaa:45:76e5:a7b:818:69c9:8d77:2'), true)
  assert.equal(isFlyPrivate('::ffff:fdaa:45::2'.replace('::ffff:', '::ffff:')), true)
  assert.equal(isFlyPrivate('127.0.0.1'), false)
  assert.equal(isFlyPrivate('::1'), false)
  assert.equal(isFlyPrivate('203.0.113.9'), false)
  assert.equal(isFlyPrivate(undefined), false)
})

test('a box says whether it receives copies, and an absent secret is not a default', () => {
  assert.equal(previewCopyReceiverConfig({}), null)
  const configured = previewCopyReceiverConfig({ TLDA_PREVIEW_COPY_RECEIVE: '1', TLDA_STATIC_DIR: '/srv/site' })
  assert.equal(configured.staticDir, '/srv/site')
  assert.equal(configured.secret, '', 'an unset secret stays empty so the route can refuse rather than assume')
})

test('what is sent is the directory, with its own digest beside it', async () => {
  const from = mkdtempSync(join(tmpdir(), 'preview-send-'))
  mkdirSync(join(from, 'book'), { recursive: true })
  writeFileSync(join(from, 'book', 'index.html'), 'a page')
  let seen = null
  const result = await sendPreviewCopy({
    from,
    url: 'http://host.internal:5176/api/preview-copy',
    secret: 'shhh',
    fetchImpl: async (url, init) => {
      seen = { url, init }
      return { ok: true, status: 200, text: async () => '{"ok":true}' }
    },
  })
  assert.equal(seen.url, 'http://host.internal:5176/api/preview-copy')
  assert.equal(seen.init.headers['x-tlda-preview-copy'], 'shhh')
  assert.equal(seen.init.headers['x-tlda-preview-copy-sha256'], result.digest)
  assert.ok(result.bytes > 0)
  // The digest is of the bytes actually sent, not of the directory listing.
  const { createHash } = await import('node:crypto')
  assert.equal(createHash('sha256').update(seen.init.body).digest('hex'), result.digest)
})

test('a refusal from the host is reported with what it said', async () => {
  const from = mkdtempSync(join(tmpdir(), 'preview-send-'))
  writeFileSync(join(from, 'a'), 'x')
  await assert.rejects(
    () => sendPreviewCopy({
      from, url: 'http://host.internal:5176/api/preview-copy', secret: 'wrong',
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => '{"error":"wrong or missing secret"}' }),
    }),
    /401.*wrong or missing secret/s,
  )
})
