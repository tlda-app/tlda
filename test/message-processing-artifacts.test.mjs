import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

import { detectAttachments, processMessageText } from '../shared/message-processing.mjs'

function withTempDir(fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-artifacts-'))
    try {
      await fn(dir)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

function startUploadStub() {
  const uploads = []
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/upload') {
      res.writeHead(404).end()
      return
    }
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const name = decodeURIComponent(req.headers['x-filename'] || 'artifact.bin')
      uploads.push({ name, body: Buffer.concat(chunks) })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ url: `/api/file?path=${encodeURIComponent(`/tmp/fleet-uploads/${name}`)}` }))
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        uploads,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise(done => server.close(done)),
      })
    })
  })
}

test('bare local image path uploads and rewrites to an attachment token', withTempDir(async (dir) => {
  const img = path.join(dir, 'activity-card.png')
  fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const stub = await startUploadStub()
  try {
    const result = await processMessageText(`Artifact: ${img}`, dir, stub.baseUrl)
    assert.equal(result.resolvedMessage, 'Artifact: {{att:0}}')
    assert.deepEqual(result.brokenPaths, [])
    assert.equal(result.inlineAttachments.length, 1)
    assert.equal(result.inlineAttachments[0].path, img)
    assert.equal(result.inlineAttachments[0].name, 'activity-card.png')
    assert.match(result.inlineAttachments[0].url, /^\/api\/file\?path=/)
    assert.equal(stub.uploads.length, 1)
    assert.equal(stub.uploads[0].name, 'activity-card.png')
  } finally {
    await stub.close()
  }
}))

test('missing bare local path is reported as broken', withTempDir(async (dir) => {
  const missing = path.join(dir, 'missing-shot.png')
  const result = detectAttachments(`Artifact: ${missing}`, dir)
  assert.equal(result.resolvedMessage, 'Artifact: {{att:0}}')
  assert.equal(result.inlineAttachments.length, 1)
  assert.equal(result.inlineAttachments[0].broken, true)
  assert.equal(result.inlineAttachments[0].path, missing)
}))

test('backticked local path remains literal and does not upload', withTempDir(async (dir) => {
  const img = path.join(dir, 'activity-card.png')
  fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const stub = await startUploadStub()
  try {
    const result = await processMessageText(`Artifact: \`${img}\``, dir, stub.baseUrl)
    assert.equal(result.resolvedMessage, `Artifact: \`${img}\``)
    assert.deepEqual(result.inlineAttachments, [])
    assert.deepEqual(result.brokenPaths, [])
    assert.equal(stub.uploads.length, 0)
  } finally {
    await stub.close()
  }
}))
