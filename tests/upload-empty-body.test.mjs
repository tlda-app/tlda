import assert from 'node:assert/strict'
import express from 'express'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createFleetRouter, persistUpload } from '../server/routes/fleet.mjs'

// Regression: POST /api/upload must never persist a 0-byte file and answer 200.
// A client disconnect mid-upload (or an empty Blob) leaves no bytes; the old
// handler wrote an empty file and returned a valid-looking /api/file URL, which
// the browser then rendered as a permanent broken image (Skip's screenshot bug,
// confirmed live against Fly: 200 · image/png · content-length 0).
// persistUpload() is the exported decide-and-write core the route calls.

function mkTmpUploadDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-upload-test-'))
}

async function withUploadServer(fn) {
  const app = express()
  app.use(createFleetRouter({}))
  const server = http.createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

test('persistUpload rejects an empty body and writes no file', () => {
  const dir = mkTmpUploadDir()
  const r = persistUpload({ body: Buffer.alloc(0), contentType: 'application/octet-stream', xFilename: 'empty.png', uploadDir: dir })
  assert.equal(r.value, undefined, 'must not return a success value')
  assert.equal(r.status, 422, 'empty upload must be rejected, not 200')
  assert.match(r.error, /empty upload/)
  assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0, 'no file should be written')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('persistUpload persists a non-empty body and returns a matching URL', () => {
  const dir = mkTmpUploadDir()
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03])
  const r = persistUpload({ body: bytes, contentType: 'application/octet-stream', xFilename: 'real.png', uploadDir: dir })
  assert.equal(r.error, undefined)
  assert.match(r.value.url, /^\/api\/file\?path=/)
  const written = fs.readFileSync(r.value.path)
  assert.equal(written.length, bytes.length, 'stored bytes must match the uploaded body')
  assert.ok(written.equals(bytes))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('persistUpload rejects a multipart body with no file part', () => {
  const dir = mkTmpUploadDir()
  const boundary = 'testboundary123'
  const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="notafile"\r\n\r\nhello\r\n--${boundary}--\r\n`)
  const r = persistUpload({ body, contentType: `multipart/form-data; boundary=${boundary}`, uploadDir: dir })
  assert.equal(r.status, 400)
  assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('persistUpload extracts and persists a multipart file part', () => {
  const dir = mkTmpUploadDir()
  const boundary = 'b0undary'
  const fileBytes = 'PNGDATA'
  const body = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="shot.png"\r\nContent-Type: image/png\r\n\r\n${fileBytes}\r\n--${boundary}--\r\n`
  )
  const r = persistUpload({ body, contentType: `multipart/form-data; boundary=${boundary}`, uploadDir: dir })
  assert.equal(r.error, undefined)
  assert.equal(fs.readFileSync(r.value.path).toString(), fileBytes)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('POST /api/upload consumes the request body and rejects empty uploads', async () => {
  await withUploadServer(async base => {
    const r = await fetch(`${base}/api/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.alloc(0),
      signal: AbortSignal.timeout(2000),
    })
    assert.equal(r.status, 422)
    assert.match((await r.json()).error, /empty upload/)
  })
})

test('POST /api/upload consumes the request body and persists non-empty uploads', async () => {
  await withUploadServer(async base => {
    const r = await fetch(`${base}/api/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-filename': 'route-live.txt',
      },
      body: Buffer.from('route bytes'),
      signal: AbortSignal.timeout(2000),
    })
    assert.equal(r.status, 200)
    const json = await r.json()
    assert.equal(fs.readFileSync(json.path, 'utf8'), 'route bytes')
    fs.rmSync(path.dirname(json.path), { recursive: true, force: true })
  })
})
