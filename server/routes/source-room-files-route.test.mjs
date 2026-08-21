import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import projectRoutes from './projects.mjs'
import { closeProjectStore, initProjectStore } from '../lib/project-store.mjs'

test('public source-room files route hands edits and deletions to the Git-backed room daemon', async () => {
  const calls = []
  const app = express()
  app.use(express.json())
  app.locals.sourceRoomDaemon = {
    async submitFiles(project, payload) {
      calls.push({ project, payload })
      return { status: 202, body: { ok: true, status: 'queued' } }
    },
  }
  app.use('/api/projects', projectRoutes)
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/projects/paper/source-room/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        files: [{ path: 'main.md', content: '# edit' }],
        deletedFiles: ['old.md'],
      }),
    })
    assert.equal(response.status, 202)
    assert.deepEqual(await response.json(), { ok: true, status: 'queued' })
    assert.deepEqual(calls, [{
      project: 'paper',
      payload: { files: [{ path: 'main.md', content: '# edit' }], deletedFiles: ['old.md'] },
    }])
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('project creation initializes its Git remote before the first source push', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-project-create-git-'))
  const projectsDir = join(root, 'projects')
  const app = express()
  app.use(express.json())
  app.use('/api/projects', projectRoutes)
  const server = createServer(app)
  try {
    await initProjectStore(projectsDir)
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'fresh-paper', mainFile: 'main.tex', format: 'svg' }),
    })
    assert.equal(response.status, 201)
    assert.equal(existsSync(join(projectsDir, 'fresh-paper', '.source-lifecycle', 'git', 'HEAD')), true)
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve))
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  }
})
