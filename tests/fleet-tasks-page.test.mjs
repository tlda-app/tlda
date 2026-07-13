import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'

import { createFleetRouter } from '../server/routes/fleet.mjs'

test('/api/tasks returns a bounded page with the active task total', async () => {
  const app = express()
  app.use(createFleetRouter({
    fleetStore: {
      getActiveTasksPage({ limit, cursor }) {
        assert.equal(limit, 2)
        assert.equal(cursor, 'next')
        return {
          tasks: [{ id: 'task-1' }, { id: 'task-2' }],
          nextCursor: 'after-task-2',
        }
      },
      getActiveTaskCount() {
        return 517
      },
    },
  }))

  const server = http.createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/tasks?limit=2&cursor=next`)
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.deepEqual(payload, {
      tasks: [{ id: 'task-1' }, { id: 'task-2' }],
      nextCursor: 'after-task-2',
      total: 517,
    })
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})
