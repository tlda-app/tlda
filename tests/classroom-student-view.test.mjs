import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { ClassroomStore } from '../server/lib/classroom-store.mjs'
import { createClassroomRouter } from '../server/routes/classroom.mjs'

// This is the half that reaches someone other than Skip, so the tests are
// about what must NOT come back: another student's work, and feedback he has
// written but not returned. A draft leaking is the same class of fault as
// returning the wrong marks — no error, plausible content, wrong person.

let principal = { role: 'instructor' }

async function serve() {
  const store = new ClassroomStore(':memory:')
  const app = express()
  app.use(express.json())
  app.use('/api/classroom', createClassroomRouter({ store, resolvePrincipal: () => principal, resolveTemplateVersion: async () => 'v1' }))
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  const base = `http://127.0.0.1:${server.address().port}/api/classroom`
  return { store, server, get: p => fetch(base + p).then(async r => ({ status: r.status, body: await r.json() })) }
}

function seeded(store) {
  store.upsertCourse({ id: 'c', title: 'C' })
  store.upsertStudent({ id: 'ada', courseId: 'c', displayName: 'Ada', enrollmentToken: 'a' })
  store.upsertStudent({ id: 'bo', courseId: 'c', displayName: 'Bo', enrollmentToken: 'b' })
  store.upsertAssignment({ id: 'hw', courseId: 'c', title: 'HW', dueAt: '2026-09-12', solutionsDocKey: 'hw-solutions' })
  store.submit({ assignmentId: 'hw', studentId: 'ada', contentRef: 'sub-ada' })
  store.submit({ assignmentId: 'hw', studentId: 'bo', contentRef: 'sub-bo' })
}

test('a student gets their own work without naming themselves', async t => {
  const { store, server, get } = await serve(); t.after(() => server.close())
  seeded(store)
  principal = { role: 'student', studentId: 'ada', courseId: 'c' }
  const mine = await get('/assignments/hw/mine')
  assert.equal(mine.status, 200)
  assert.equal(mine.body.studentId, 'ada')
  assert.equal(mine.body.contentRef, 'sub-ada')
})

test('the route cannot be aimed at another student', async t => {
  const { store, server, get } = await serve(); t.after(() => server.close())
  seeded(store)
  principal = { role: 'student', studentId: 'ada', courseId: 'c' }
  // There is no student id in the path at all — identity comes from the token.
  const mine = await get('/assignments/hw/mine')
  assert.equal(mine.body.studentId, 'ada', 'a student reached a submission that was not theirs')
  // And the id-bearing route still refuses.
  const theirs = await get('/assignments/hw/submissions/bo')
  assert.equal(theirs.status, 403)
})

test('an unreturned draft never reaches the student', async t => {
  const { store, server, get } = await serve(); t.after(() => server.close())
  seeded(store)
  store.addFeedback({ assignmentId: 'hw', studentId: 'ada', title: 'Problem 2', text: 'Still deciding how to say this.' })

  principal = { role: 'student', studentId: 'ada', courseId: 'c' }
  const before = await get('/assignments/hw/mine')
  assert.deepEqual(before.body.feedback, [], 'a draft comment was shown to the student')

  principal = { role: 'instructor' }
  store.returnFeedback('hw', 'ada')

  principal = { role: 'student', studentId: 'ada', courseId: 'c' }
  const after = await get('/assignments/hw/mine')
  assert.equal(after.body.feedback.length, 1, 'returned feedback did not reach the student')
  assert.equal(after.body.feedback[0].visibility, 'returned')
})

test('an unattached draft is not returned even when he returns the rest', async t => {
  const { store, server, get } = await serve(); t.after(() => server.close())
  seeded(store)
  store.addFeedback({ assignmentId: 'hw', studentId: 'ada', title: 'keep', text: 'this one goes back', attached: true })
  store.addFeedback({ assignmentId: 'hw', studentId: 'ada', title: 'private', text: 'note to self', attached: false })
  store.returnFeedback('hw', 'ada')

  principal = { role: 'student', studentId: 'ada', courseId: 'c' }
  const mine = await get('/assignments/hw/mine')
  assert.deepEqual(mine.body.feedback.map(f => f.title), ['keep'], 'a note he kept back was sent to the student')
})

test('not submitted is an ordinary answer, not an error state', async t => {
  const { store, server, get } = await serve(); t.after(() => server.close())
  store.upsertCourse({ id: 'c', title: 'C' })
  store.upsertStudent({ id: 'cy', courseId: 'c', displayName: 'Cy', enrollmentToken: 'c' })
  store.upsertAssignment({ id: 'hw', courseId: 'c', title: 'HW', dueAt: '2026-09-12', solutionsDocKey: 'hw-solutions' })
  principal = { role: 'student', studentId: 'cy', courseId: 'c' }
  assert.equal((await get('/assignments/hw/mine')).status, 404)
  // And the solutions stay shut until they hand something in.
  assert.equal((await get('/assignments/hw')).body.solutionsDocKey, undefined)
})

test('no student-reachable route hands back an unreturned draft', async t => {
  // The leak app-chief2 found was not on a read path — it was `submit()`
  // returning drafts, straight out of a route a student calls. My five cases
  // above all tested /mine, so all five encoded the same assumption: that the
  // leak surface is where you go to read. It is wherever a submission body
  // reaches a student.
  //
  // So this asserts the property rather than the function: whatever a student
  // can call, none of it comes back carrying his unreturned working.
  const { store, server, get } = await serve(); t.after(() => server.close())
  seeded(store)
  store.addFeedback({ assignmentId: 'hw', studentId: 'ada', title: 'draft', text: 'not sent yet' })

  principal = { role: 'student', studentId: 'ada', courseId: 'c' }
  const base = `http://127.0.0.1:${server.address().port}/api/classroom`

  const bodies = [
    (await get('/assignments/hw/mine')).body,
    (await get('/assignments/hw/submissions/ada')).body,
    (await get('/courses/c/assignments')).body,
    // The one that was actually leaking: re-submitting.
    await fetch(`${base}/assignments/hw/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentRef: 'sub-ada' }),
    }).then(r => r.json()),
  ]

  for (const body of bodies) {
    const text = JSON.stringify(body)
    assert.ok(!text.includes('not sent yet'), `a draft reached the student in: ${text.slice(0, 160)}`)
    assert.ok(!text.includes('instructor-draft'), `a draft marker reached the student in: ${text.slice(0, 160)}`)
  }
})
