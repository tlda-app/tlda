import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { servePublishRawApp } from './publish-raw-app.mjs'

const BYTES = '<html><body><a href="homework/homework-setup.html">HW −1</a></body></html>'

function outputRoot() {
  // realpath: the resolver returns canonical paths (/tmp is a symlink on macOS).
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tlda-publish-raw-app-')))
  mkdirSync(join(root, 'app', 'book'), { recursive: true })
  writeFileSync(join(root, 'app', 'book', 'index.html'), BYTES)
  return root
}

function stubRes() {
  return {
    code: null,
    body: null,
    file: null,
    status(code) { this.code = code; return this },
    json(body) { this.body = body; return this },
    sendFile(path) { this.file = path; return this },
  }
}

const req = (overrides = {}) => ({
  query: { _tldaPublishRaw: '1' },
  path: '/docs/book/app/book/index.html',
  params: { coursePath: ['book', 'index.html'] },
  ...overrides,
})

test('a publish-raw app page answers the built file untouched', async () => {
  const root = outputRoot()
  const res = stubRes()
  const handled = await servePublishRawApp(req(), res, { outputRoot: root })
  assert.equal(handled, true)
  // The output file itself, not a transformed copy: the staged copy gets its
  // bridge from the publish's own patch step, never from this serve.
  assert.equal(res.file, resolve(root, 'app/book/index.html'))
  assert.equal(res.code, null)
})

test('without the flag the request is not ours and the shell serves', async () => {
  const res = stubRes()
  const handled = await servePublishRawApp(req({ query: {} }), res, { outputRoot: outputRoot() })
  assert.equal(handled, false)
  assert.equal(res.file, null)
  assert.equal(res.code, null)
})

test('a non-HTML app asset falls through: the downstream already serves it raw', async () => {
  const res = stubRes()
  const handled = await servePublishRawApp(req({
    path: '/docs/book/app/book/fig.svg',
    params: { coursePath: ['book', 'fig.svg'] },
  }), res, { outputRoot: outputRoot() })
  assert.equal(handled, false)
  assert.equal(res.file, null)
})

test('a listed-but-missing file is a 404, never the shell', async () => {
  const res = stubRes()
  const handled = await servePublishRawApp(req({
    path: '/docs/book/app/book/gone.html',
    params: { coursePath: ['book', 'gone.html'] },
  }), res, { outputRoot: outputRoot() })
  assert.equal(handled, true)
  assert.equal(res.code, 404)
  assert.equal(res.file, null)
})

test('a traversal stays contained and answers 404', async () => {
  const root = outputRoot()
  writeFileSync(join(tmpdir(), 'tlda-publish-raw-app-escape.txt'), 'escape')
  const res = stubRes()
  const handled = await servePublishRawApp(req({
    path: '/docs/book/app/book/index.html',
    params: { coursePath: ['..', '..', '..', 'tlda-publish-raw-app-escape.txt'] },
  }), res, { outputRoot: root })
  assert.equal(handled, true)
  assert.equal(res.code, 404)
  assert.equal(res.file, null)
})

test('a directory answers its index file', async () => {
  const root = outputRoot()
  mkdirSync(join(root, 'app', 'book', 'nested'), { recursive: true })
  writeFileSync(join(root, 'app', 'book', 'nested', 'index.html'), BYTES)
  const res = stubRes()
  const handled = await servePublishRawApp(req({
    path: '/docs/book/app/book/nested/',
    params: { coursePath: ['book', 'nested'] },
  }), res, { outputRoot: root })
  assert.equal(handled, true)
  assert.equal(res.file, resolve(root, 'app/book/nested/index.html'))
})
