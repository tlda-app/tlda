import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import projectRoutes from './projects.mjs'

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
