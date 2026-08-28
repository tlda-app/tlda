import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ClassroomStore } from '../server/lib/classroom-store.mjs'
import { createClassroomRouter } from '../server/routes/classroom.mjs'

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-grade-404-'))
  const store = new ClassroomStore(path.join(dir, 'classroom.db'))
  store.upsertCourse({ id: 'c1', title: 'Course' })
  store.upsertStudent({ id: 'ada', courseId: 'c1', displayName: 'Ada', enrollmentToken: 'secret' })
  store.upsertAssignment({ id: 'hw1', courseId: 'c1', title: 'HW1', dueAt: '2026-09-01T20:00:00Z' })

  const app = express()
  app.use(express.json())
  app.use('/api/classroom', createClassroomRouter({ store, resolvePrincipal: () => ({ role: 'instructor' }) }))
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  const base = `http://127.0.0.1:${server.address().port}/api/classroom`
  return {
    post: route => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
    get: route => fetch(base + route),
    close() {
      server.close()
      store.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

for (const route of ['grade', 'return']) {
  test(`POST ${route} on a missing submission answers 404 JSON`, async () => {
    const f = await fixture()
    try {
      const response = await f.post(`/assignments/hw1/submissions/ada/${route}`)
      assert.equal(response.status, 404)
      assert.equal(response.headers.get('content-type')?.includes('application/json'), true)
      assert.deepEqual(await response.json(), { error: 'Submission not found' })
    } finally {
      f.close()
    }
  })
}

test('missing-submission POSTs match the sibling GET contract', async () => {
  const f = await fixture()
  try {
    const response = await f.get('/assignments/hw1/submissions/ada')
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: 'Submission not found' })
  } finally {
    f.close()
  }
})
