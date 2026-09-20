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

// Identity is resolved from the per-person token against the real store, so
// both halves are exercised rather than stubbed: a student token resolves to a
// student row, an instructor token to an instructor row, and a bearer level
// resolves to nothing at all.
const byEnrolmentToken = (req, store) => {
  const token = req.headers['x-tlda-student-token']
  const student = store.studentForToken(token)
  if (student) return { role: 'student', studentId: student.id, courseId: student.courseId, displayName: student.displayName }
  const instructor = store.instructorForToken ? store.instructorForToken(token) : null
  if (instructor) return { role: 'instructor', instructorId: instructor.id, courseId: instructor.courseId, displayName: instructor.displayName, preferredName: instructor.preferredName, pronouns: instructor.pronouns }
  return null
}

test('a student is told who they are, and it comes from their token', async t => {
  const { store, server, get } = await serve(byEnrolmentToken)
  t.after(() => server.close())

  store.upsertCourse({ id: 'c', title: 'C', preferredName: 'Instructor' })
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

test('an instructor gets their own registered name and no student id', async t => {
  // The name is the instructor's own, from their own per-person token — not the
  // course row's. Reading the course name here put the instructor's identity on
  // a column describing somebody else.
  const { store, server, get } = await serve(byEnrolmentToken)
  t.after(() => server.close())
  store.upsertCourse({ id: 'c', title: 'C', preferredName: 'Course Name' })
  store.registerInstructor({ courseId: 'c', displayName: 'Professor Example', preferredName: 'Professor Example', pronouns: 'they/them', universityLogin: 'prof', token: 'token-prof' })

  const who = await get('/me?course=c', { 'x-tlda-student-token': 'token-prof' })
  assert.equal(who.status, 200)
  assert.equal(who.body.role, 'instructor')
  assert.equal(who.body.studentId, undefined, 'an instructor was handed a student overlay to write into')
  assert.equal(who.body.preferredName, 'Professor Example')
  assert.equal(who.body.pronouns, 'they/them')
  assert.equal(who.body.instructorId, 'c:prof')
  assert.equal(who.body.courseId, 'c')
})

test('instructor identity failures name the condition that failed', async t => {
  const { store, server, get } = await serve(byEnrolmentToken)
  t.after(() => server.close())
  store.upsertCourse({ id: 'c', title: 'C', preferredName: 'Course Name' })
  store.registerInstructor({ courseId: 'c', displayName: 'Professor Example', universityLogin: 'prof', token: 'token-prof' })
  store.upsertCourse({ id: 'other', title: 'Other', preferredName: 'Other' })

  // No token at all: the gate answers before the handler is reached.
  assert.deepEqual(await get('/me?course=c'), { status: 401, body: { error: 'Unauthorized' } })
  // A member asking about a course they are not a member of is refused rather
  // than answered: `?course=` names the course being asked about.
  assert.deepEqual(
    await get('/me?course=other', { 'x-tlda-student-token': 'token-prof' }),
    { status: 403, body: { error: 'Forbidden' } },
  )
  assert.deepEqual(
    await get('/me?course=missing', { 'x-tlda-student-token': 'token-prof' }),
    { status: 403, body: { error: 'Forbidden' } },
  )
})

// THERE IS NO THIRD FAILURE HERE, AND THE MISSING ONE IS DELIBERATE.
//
// This route also answered 409 "Course instructor preferred name is not
// configured" when the name was empty. That read as a cosmetic complaint about
// a badge and was not one: the solution chapter's marking asks `/me` before it
// installs and gives up on a null identity, so on every course whose row
// predates the column — which was every real course, since `4a01a1545` added it
// with no backfill — the marking layer silently never installed, and the only
// visible trace was a toast about a name.
//
// There is deliberately no test here for a course with no name, because a
// course with no name can no longer exist: the store backfills the column,
// holds it NOT NULL, and refuses to create a course without one. That guarantee
// is tested where it lives, in `classroom-course-preferred-name-migration`.
// If you are here to add the 409 back, the thing to change is the store.
