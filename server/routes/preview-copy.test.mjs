import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import express from 'express'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPreviewCopyReceiver, isFlyPrivate, previewCopyReceiverConfig, startPreviewCopyReceiver } from './preview-copy.mjs'
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
  assert.equal(configured.host, '', 'an unset private address stays empty so starting can refuse rather than bind everything')
  assert.equal(configured.port, 5181)
})

test('with no private address to bind, the receiver refuses to start and says nothing is listening', async () => {
  await assert.rejects(
    () => startPreviewCopyReceiver({ staticDir: '/srv/site', secret: 'shhh', port: 5181, host: '' }),
    /FLY_PRIVATE_IP is unset.*Nothing is listening/s,
    'binding every interface would put the receiver on whatever the box publishes, so this must not fall back',
  )
})

test('a deployment that says nothing about copies starts no receiver', async () => {
  assert.equal(await startPreviewCopyReceiver(previewCopyReceiverConfig({})), null)
})

test('what is sent is only the changed files and its complete manifest', async () => {
  const from = mkdtempSync(join(tmpdir(), 'preview-send-'))
  mkdirSync(join(from, 'book'), { recursive: true })
  writeFileSync(join(from, 'book', 'index.html'), 'a page')
  const seen = []
  const result = await sendPreviewCopy({
    from,
    url: 'http://host.internal:5176/api/preview-copy',
    secret: 'shhh',
    fetchImpl: async (url, init) => {
      seen.push({ url, init })
      if (url.endsWith('/manifest')) return { ok: true, status: 200, text: async () => JSON.stringify({ version: 1, files: [], rootSha256: 'x' }) }
      return { ok: true, status: 200, text: async () => '{"ok":true}' }
    },
  })
  assert.equal(seen[0].url, 'http://host.internal:5176/api/preview-copy/manifest')
  assert.equal(seen[1].url, 'http://host.internal:5176/api/preview-copy')
  assert.equal(seen[1].init.headers['x-tlda-preview-copy'], 'shhh')
  assert.equal(seen[1].init.headers['x-tlda-preview-copy-root'], result.rootSha256)
  assert.equal(result.files, 1)
  assert.equal(seen[1].init.duplex, 'half')
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

// A REAL SERVER, A REAL ARCHIVE, A REAL SWAP. Everything above this point tests
// a decision; these test the half that writes to disk, which otherwise would
// first run on the deployed box. `isPeer` is the only thing faked -- off Fly the
// caller is 127.0.0.1 and the network check would refuse before any of this.
async function receiverOn(staticDir, overrides = {}) {
  const app = express()
  app.use(createPreviewCopyReceiver({
    staticDir, secret: 'shhh', isPeer: () => true,
    log: { log() {}, warn() {} }, ...overrides,
  }))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  return { url: `http://127.0.0.1:${server.address().port}/api/preview-copy`, close: () => server.close() }
}

function filePaths(root, current = '') {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = current ? `${current}/${entry.name}` : entry.name
    return entry.isDirectory() ? filePaths(join(root, entry.name), path) : [path]
  })
}

test('a copy sent from one box is what the other serves, and the one it replaces is gone', async () => {
  const staticDir = join(mkdtempSync(join(tmpdir(), 'preview-host-')), 'site')
  mkdirSync(staticDir, { recursive: true })
  writeFileSync(join(staticDir, 'stale.html'), 'the previous copy')
  const from = mkdtempSync(join(tmpdir(), 'preview-build-'))
  mkdirSync(join(from, 'book'), { recursive: true })
  writeFileSync(join(from, 'book', 'chapter-1.html'), 'the page Skip just edited')
  writeFileSync(join(from, 'unchanged.css'), 'same bytes')
  writeFileSync(join(from, 'page-info.json'), '[{"file":"book/chapter-1.html"}]')

  const host = await receiverOn(staticDir)
  try {
    const sent = await sendPreviewCopy({ from, url: host.url, secret: 'shhh' })
    assert.equal(sent.files, 3)
    assert.equal(readFileSync(join(staticDir, 'book', 'chapter-1.html'), 'utf8'), 'the page Skip just edited')
    assert.equal(readFileSync(join(staticDir, 'page-info.json'), 'utf8'), '[{"file":"book/chapter-1.html"}]')
    assert.deepEqual(filePaths(staticDir).sort(), ['book/chapter-1.html', 'page-info.json', 'unchanged.css'])
    assert.equal(existsSync(join(staticDir, '.tlda-preview-manifest.json')), false, 'the transport manifest must not be served')
    assert.throws(() => readFileSync(join(staticDir, 'stale.html')), /ENOENT/,
      'the previous copy must be replaced rather than merged into')

    writeFileSync(join(from, 'book', 'chapter-1.html'), 'the page Skip edited again')
    const differential = await sendPreviewCopy({ from, url: host.url, secret: 'shhh' })
    assert.equal(differential.files, 1, 'the second transfer contains only the changed blob')
    assert.equal(readFileSync(join(staticDir, 'unchanged.css'), 'utf8'), 'same bytes')
    assert.equal(readFileSync(join(staticDir, 'book', 'chapter-1.html'), 'utf8'), 'the page Skip edited again')
    assert.deepEqual(filePaths(staticDir).sort(), ['book/chapter-1.html', 'page-info.json', 'unchanged.css'])
    assert.equal(existsSync(join(staticDir, '.tlda-preview-manifest.json')), false, 'the transport manifest must not be served')
  } finally { host.close() }
})

test('a copy that would write outside the served directory is refused and writes nothing', async () => {
  const staticDir = join(mkdtempSync(join(tmpdir(), 'preview-host-')), 'site')
  mkdirSync(staticDir, { recursive: true })
  writeFileSync(join(staticDir, 'intact.html'), 'still here')
  const from = mkdtempSync(join(tmpdir(), 'preview-evil-'))
  writeFileSync(join(from, 'fine.html'), 'ok')
  // An archive naming a parent path. Built by tar itself so the test exercises
  // what tar would actually hand the unpacker, not a hand-written member name.
  const outside = mkdtempSync(join(tmpdir(), 'preview-outside-'))
  writeFileSync(join(outside, 'escaped.html'), 'should never land')
  const archive = join(mkdtempSync(join(tmpdir(), 'preview-evil-')), 'evil.tgz')
  await new Promise((resolve, reject) => {
    const child = spawn('tar', ['czf', archive, '-C', from, '.', '-C', outside, `../${outside.split('/').pop()}/escaped.html`])
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`tar exited ${code}`)))
  })

  const host = await receiverOn(staticDir)
  try {
    const response = await fetch(host.url, {
      method: 'POST',
      headers: { 'x-tlda-preview-copy': 'shhh' },
      body: readFileSync(archive),
      duplex: 'half',
    })
    assert.equal(response.status, 400)
    assert.equal(readFileSync(join(staticDir, 'intact.html'), 'utf8'), 'still here')
  } finally { host.close() }
})

test('a copy whose bytes changed on the wire is refused and writes nothing', async () => {
  const staticDir = join(mkdtempSync(join(tmpdir(), 'preview-host-')), 'site')
  mkdirSync(staticDir, { recursive: true })
  writeFileSync(join(staticDir, 'intact.html'), 'still here')
  const from = mkdtempSync(join(tmpdir(), 'preview-build-'))
  writeFileSync(join(from, 'page.html'), 'a page')

  const host = await receiverOn(staticDir)
  try {
    await assert.rejects(
      () => sendPreviewCopy({
        from, url: host.url, secret: 'shhh',
        fetchImpl: (url, init) => fetch(url, {
          ...init,
          headers: { ...init.headers, 'x-tlda-preview-copy-root': 'f'.repeat(64) },
        }),
      }),
      /400.*not ffffffffffff/s,
    )
    assert.equal(readFileSync(join(staticDir, 'intact.html'), 'utf8'), 'still here')
  } finally { host.close() }
})

test('an interrupted transfer leaves the previous complete tree serving', async () => {
  const staticDir = join(mkdtempSync(join(tmpdir(), 'preview-host-')), 'site')
  mkdirSync(staticDir, { recursive: true })
  writeFileSync(join(staticDir, 'intact.html'), 'still here')
  const host = await receiverOn(staticDir)
  try {
    const body = new Readable({ read() { this.push(Buffer.from('partial archive')); this.destroy(new Error('interrupted')) } })
    await assert.rejects(
      () => fetch(host.url, {
        method: 'POST',
        headers: { 'content-type': 'application/gzip', 'x-tlda-preview-copy': 'shhh' },
        body,
        duplex: 'half',
      }),
      /interrupted|fetch failed/s,
    )
    assert.equal(readFileSync(join(staticDir, 'intact.html'), 'utf8'), 'still here')
  } finally { host.close() }
})
