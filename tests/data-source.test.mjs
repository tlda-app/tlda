import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

import { initDataSource, readManifest } from '../mcp-server/data-source.mjs'

function makeProject(root, name) {
  const dir = path.join(root, 'server', 'projects', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ name, title: name, pages: 1 }))
}

test('local data-source mode scans server/projects when manifest is absent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-data-source-local-'))
  makeProject(root, 'local-doc')
  initDataSource(root, null)

  const manifest = await readManifest()
  assert.equal(manifest.documents['local-doc'].pages, 1)
})

test('remote data-source mode fails loud instead of scanning local disk on HTTP errors', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-data-source-remote-'))
  makeProject(root, 'wrong-local-doc')
  const server = http.createServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('server failure')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  initDataSource(root, `http://127.0.0.1:${port}`)

  await assert.rejects(
    () => readManifest(),
    /manifest fetch failed .* HTTP 500/
  )

  await new Promise(resolve => server.close(resolve))
})
