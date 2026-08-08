import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { ClassroomStore } from '../server/lib/classroom-store.mjs'
import { createClassroomRouter } from '../server/routes/classroom.mjs'

// Skip, 26 June: "once you've submitted an assignment the solution becomes
// accessible to you." Documents are fetched by key, so whether that rule holds
// is exactly whether solutionsDocKey appears in the response. A student who can
// read the solutions before submitting makes the homework pointless, and the
// leak is invisible from the instructor's side -- nothing looks wrong.

let principal = { role: 'instructor' }

async function serve() {
  const store = new ClassroomStore(':memory:')
  const app = express()
  app.use(express.json())
  app.use('/api/classroom', createClassroomRouter({
    store,
    resolvePrincipal: () => principal,
    resolveTemplateVersion: async () => 'v1',
  }))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const base = `http://127.0.0.1:${server.address().port}/api/classroom`
  return { store, server, base, get: path => fetch(base + path).then(r => r.json()) }
}

test('the solution is withheld until the student submits, then appears', async t => {
  const { store, server, base, get } = await serve()
  t.after(() => server.close())

  store.upsertCourse({ id: 'c', title: 'C' })
  store.upsertStudent({ id: 'ada', courseId: 'c', displayName: 'Ada', enrollmentToken: 'tok' })
  store.upsertAssignment({ id: 'hw', courseId: 'c', title: 'HW', dueAt: '2026-09-12', solutionsDocKey: 'hw-solutions' })

  principal = { role: 'student', studentId: 'ada', courseId: 'c' }

  const before = await get('/assignments/hw')
  assert.equal(before.solutionsDocKey, undefined, 'solutions leaked before submitting')
  assert.equal(before.solutionsLocked, true)

  const listBefore = await get('/courses/c/assignments')
  assert.equal(listBefore.assignments[0].solutionsDocKey, undefined, 'solutions leaked via the list')

  store.submit({ assignmentId: 'hw', studentId: 'ada', contentRef: 'submission-hw-ada' })

  const after = await get('/assignments/hw')
  assert.equal(after.solutionsDocKey, 'hw-solutions', 'solution did not unlock after submitting')
  assert.equal(after.solutionsLocked, undefined)

  const listAfter = await get('/courses/c/assignments')
  assert.equal(listAfter.assignments[0].solutionsDocKey, 'hw-solutions')
})

test('the instructor always sees the solution', async t => {
  const { store, server, get } = await serve()
  t.after(() => server.close())
  store.upsertCourse({ id: 'c', title: 'C' })
  store.upsertAssignment({ id: 'hw', courseId: 'c', title: 'HW', dueAt: '2026-09-12', solutionsDocKey: 'hw-solutions' })
  principal = { role: 'instructor' }
  assert.equal((await get('/assignments/hw')).solutionsDocKey, 'hw-solutions')
})

test("one student's submission does not unlock it for another", async t => {
  const { store, server, get } = await serve()
  t.after(() => server.close())
  store.upsertCourse({ id: 'c', title: 'C' })
  store.upsertStudent({ id: 'ada', courseId: 'c', displayName: 'Ada', enrollmentToken: 'tok-a' })
  store.upsertStudent({ id: 'bo', courseId: 'c', displayName: 'Bo', enrollmentToken: 'tok-b' })
  store.upsertAssignment({ id: 'hw', courseId: 'c', title: 'HW', dueAt: '2026-09-12', solutionsDocKey: 'hw-solutions' })
  store.submit({ assignmentId: 'hw', studentId: 'ada', contentRef: 'submission-hw-ada' })

  principal = { role: 'student', studentId: 'bo', courseId: 'c' }
  const bo = await get('/assignments/hw')
  assert.equal(bo.solutionsDocKey, undefined, "Ada submitting unlocked the solution for Bo")
  assert.equal(bo.solutionsLocked, true)
})
