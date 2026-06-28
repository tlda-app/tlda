import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { createServer } from 'node:http'

async function withUploadServer(uploadDir, fn) {
  const oldUploadDir = process.env.TLDA_UPLOAD_DIR
  process.env.TLDA_UPLOAD_DIR = uploadDir
  const { createFleetRouter } = await import(`../server/routes/fleet.mjs?upload-test=${Date.now()}`)
  const app = express()
  app.use(createFleetRouter({
    broadcastEvent: () => {},
    broadcastState: () => {},
    clearEphemeralState: () => {},
    suppressEchoFor: () => {},
    sendRpc: async () => ({}),
    resolveRpc: () => ({ via: 'none', code: 503, error: 'unused' }),
    resolveSpawnTarget: null,
  }))
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise(resolve => server.close(resolve))
    if (oldUploadDir == null) delete process.env.TLDA_UPLOAD_DIR
    else process.env.TLDA_UPLOAD_DIR = oldUploadDir
  }
}

test('/api/upload writes to persistent configured upload directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-upload-dir-'))
  const uploadDir = path.join(root, '.config', 'tlda', 'uploads')
  try {
    let uploadedUrl = null
    await withUploadServer(uploadDir, async (base) => {
      const res = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-filename': encodeURIComponent('proof.md') },
        body: '# upload proof\n',
      })
      assert.equal(res.status, 200)
      const json = await res.json()
      assert.equal(path.dirname(json.path), uploadDir)
      assert.match(json.url, /^\/api\/file\?path=/)
      assert.equal(fs.readFileSync(json.path, 'utf8'), '# upload proof\n')
      uploadedUrl = json.url
    })
    await withUploadServer(uploadDir, async (base) => {
      const res = await fetch(`${base}${uploadedUrl}`)
      assert.equal(res.status, 200)
      assert.equal(await res.text(), '# upload proof\n')
      const secret = path.join(root, '.ssh', 'id_rsa')
      fs.mkdirSync(path.dirname(secret), { recursive: true })
      fs.writeFileSync(secret, 'not for upload serving\n')
      const secretRes = await fetch(`${base}/api/file?path=${encodeURIComponent(secret)}`)
      assert.equal(secretRes.status, 404)
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
