import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

import {
  initDataSource,
  localDocDir,
  readJson,
  readManifest,
  readText,
} from '../mcp-server/data-source.mjs'

function makeProject(root, name) {
  const dir = path.join(root, 'server', 'projects', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ name, title: name, pages: 1 }))
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value))
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

test('local data-source mode reads server project output instead of stale public docs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-data-source-output-'))
  makeProject(root, 'built-doc')
  writeJson(path.join(root, 'server', 'projects', 'built-doc', 'output', 'lookup.json'), {
    source: 'server-project-output',
  })
  writeJson(path.join(root, 'public', 'docs', 'built-doc', 'lookup.json'), {
    source: 'stale-public-docs',
  })
  initDataSource(root, null)

  const lookup = await readJson('built-doc', 'lookup.json')
  assert.deepEqual(lookup, { source: 'server-project-output' })
})

test('local data-source mode ignores docs that only exist under public docs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-data-source-no-public-'))
  fs.mkdirSync(path.join(root, 'public', 'docs', 'legacy-doc'), { recursive: true })
  fs.writeFileSync(path.join(root, 'public', 'docs', 'legacy-doc', 'page1.svg'), '<svg></svg>')
  writeJson(path.join(root, 'public', 'docs', 'legacy-doc', 'lookup.json'), { source: 'legacy' })
  initDataSource(root, null)

  assert.equal(localDocDir('legacy-doc'), path.join(root, 'server', 'projects', 'legacy-doc', 'output'))
  assert.equal(await readJson('legacy-doc', 'lookup.json'), null)
  assert.equal(await readText('legacy-doc', 'page1.svg'), null)
})
