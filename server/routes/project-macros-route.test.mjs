import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import projectRoutes from './projects.mjs'
import { closeProjectStore, initProjectStore } from '../lib/project-store.mjs'

test('a built-format project with no TeX preamble has an empty macro set', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-project-macros-route-'))
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { req.authLevel = 'rw'; next() })
  app.use('/api/projects', projectRoutes)
  const server = createServer(app)
  try {
    await initProjectStore(join(root, 'projects'))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}/api/projects`
    const created = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'submission', mainFile: 'homework.qmd', format: 'qmd' }),
    })
    assert.equal(created.status, 201)

    const response = await fetch(`${base}/submission/macros`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { macros: {} })
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve))
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  }
})
