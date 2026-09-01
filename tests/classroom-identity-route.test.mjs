import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { ClassroomStore } from '../server/lib/classroom-store.mjs'
import { createClassroomRouter } from '../server/routes/classroom.mjs'

// GET /me is how the book surface learns who is reading it, and the student's
// own annotation room is named from the answer. So the failure this guards is
// the quiet one: the wrong student id coming back, which does not error and
// which puts one student's marks in another student's room.
//
// The route is exercised over HTTP through the real router rather than by
// calling a handler, because the thing that can be missing is the route itself.

async function serve(resolvePrincipal) {
  const store = new ClassroomStore(':memory:')
  const app = express()
  app.use(express.json())
  app.use('/api/classroom', createClassroomRouter({ store, resolvePrincipal, resolveTemplateVersion: async () => 'v1' }))
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  const base = `http://127.0.0.1:${server.address().port}/api/classroom`
  return {
    store,
    server,
    get: (p, headers) => fetch(base + p, { headers }).then(async r => ({ status: r.status, body: await r.json() })),
  }
}

// Identity is resolved from the enrolment token against the real store, so the
// token -> student half is exercised rather than stubbed. The bearer-token check
// that sits above it in production is the part standing in here.
const byEnrolmentToken = (req, store) => {
  const student = store.studentForToken(req.headers['x-tlda-student-token'])
  return student ? { role: 'student', studentId: student.id, courseId: student.courseId, displayName: student.displayName } : null
}

test('a student is told who they are, and it comes from their token', async t => {
  const { store, server, get } = await serve(byEnrolmentToken)
  t.after(() => server.close())

  store.upsertCourse({ id: 'c', title: 'C' })
  store.upsertStudent({ id: 'ada', courseId: 'c', displayName: 'Ada', enrollmentToken: 'token-ada' })
  store.upsertStudent({ id: 'bo', courseId: 'c', displayName: 'Bo', enrollmentToken: 'token-bo' })

  const ada = await get('/me', { 'x-tlda-student-token': 'token-ada' })
  assert.equal(ada.status, 200)
  // The registered name comes back with the id. The classroom badge says
  // "Logged in as Ada" from this and nothing else, so a route that answered
  // only the id would leave the badge unable to name anyone.
  assert.deepEqual(ada.body, { role: 'student', studentId: 'ada', courseId: 'c', displayName: 'Ada', preferredName: 'Ada', pronouns: null })

  // The counterfactual that makes the assertion above mean something: a
  // different token has to produce a different student, or the test would pass
  // just as well against a route that returned a constant.
  const bo = await get('/me', { 'x-tlda-student-token': 'token-bo' })
  assert.equal(bo.body.studentId, 'bo', 'two enrolment tokens resolved to the same student')
  assert.equal(bo.body.displayName, 'Bo', 'two enrolment tokens resolved to the same name')
})

test('no token is 401, not an anonymous identity', async t => {
  const { server, get } = await serve(byEnrolmentToken)
  t.after(() => server.close())

  const anon = await get('/me')
  assert.equal(anon.status, 401, 'an unauthenticated reader was given an identity')
  assert.equal(anon.body.studentId, undefined)
})

test('an instructor gets the course-owned preferred name and no student id', async t => {
  const { store, server, get } = await serve(() => ({ role: 'instructor' }))
  t.after(() => server.close())
  store.upsertCourse({ id: 'c', title: 'C', preferredName: 'Professor Example', pronouns: 'they/them' })

  const who = await get('/me?course=c')
  assert.equal(who.status, 200)
  assert.equal(who.body.role, 'instructor')
  assert.equal(who.body.studentId, undefined, 'an instructor was handed a student overlay to write into')
  assert.equal(who.body.preferredName, 'Professor Example')
  assert.equal(who.body.pronouns, 'they/them')
})
