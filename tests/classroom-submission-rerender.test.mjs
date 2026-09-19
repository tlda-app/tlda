import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { ClassroomStore } from '../server/lib/classroom-store.mjs'
import { createClassroomRouter } from '../server/routes/classroom.mjs'

// Work that is accepted, stored, and unrenderable is the worst shape in this
// system, and before this route there was no way out of it. A build is keyed on
// the source revision, so a failed submission build could not be run again:
// re-uploading the student's own bytes produces the same revision and the source
// transaction does nothing — measured on the one real hand-in, which returned
// 200 with every answer id and enqueued no build — and a submission has no
// daemon binding for `rebuildLinkedProject`. The only workaround was editing the
// student's file, which is not one.

let principal = { role: 'instructor' }

async function serve(rerunFailedBuild) {
  const store = new ClassroomStore(':memory:')
  const app = express()
  app.use(express.json())
  app.use('/api/classroom', createClassroomRouter({
    store,
    resolvePrincipal: () => principal,
    resolveTemplateVersion: async () => 'v1',
    rerunFailedBuild,
  }))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const base = `http://127.0.0.1:${server.address().port}/api/classroom`
  return { store, server, base }
}

function enrol(store) {
  store.upsertCourse({ id: 'c', title: 'C', preferredName: 'Instructor' })
  store.upsertStudent({ id: 'ada', courseId: 'c', displayName: 'Ada', enrollmentToken: 'tok' })
  store.upsertAssignment({ id: 'hw', courseId: 'c', title: 'HW', dueAt: '2026-09-12' })
}

test('a student who never handed in has no build to re-run', async t => {
  const { store, server, base } = await serve(async () => { throw new Error('must not be called') })
  t.after(() => server.close())
  enrol(store)
  principal = { role: 'instructor' }

  const response = await fetch(`${base}/assignments/hw/submissions/ada/rerender`, { method: 'POST' })
  assert.equal(response.status, 404)
  // The refusal names what is missing rather than telling the reader to look.
  assert.match((await response.json()).error, /has not handed in hw/)
})

test('a student cannot re-run a build', async t => {
  const { store, server, base } = await serve(async () => { throw new Error('must not be called') })
  t.after(() => server.close())
  enrol(store)
  store.submit({ assignmentId: 'hw', studentId: 'ada', contentRef: 'submission-hw-ada' })
  principal = { role: 'student', studentId: 'ada', courseId: 'c' }

  const response = await fetch(`${base}/assignments/hw/submissions/ada/rerender`, { method: 'POST' })
  assert.equal(response.status, 403)
})

test('a build that did not fail is refused, and the refusal says what state it is in', async t => {
  const calls = []
  const { store, server, base } = await serve(async (project) => {
    calls.push({ project })
    return { ok: false, reason: 'complete', revision: 'a'.repeat(40) }
  })
  t.after(() => server.close())
  enrol(store)
  store.submit({ assignmentId: 'hw', studentId: 'ada', contentRef: 'submission-hw-ada' })
  principal = { role: 'instructor' }

  const response = await fetch(`${base}/assignments/hw/submissions/ada/rerender`, { method: 'POST' })
  assert.equal(response.status, 409)
  const body = await response.json()
  assert.equal(body.state, 'complete')
  assert.match(body.error, /only a failed build is re-run/)
  // Which project was asked about — not a scoping guarantee, since this caller
  // sends no project to be preferred over it. The scoping is enforced by the
  // widening case at the bottom of this file.
  assert.equal(calls[0].project, 'submission-hw-ada')
})

test('a failed build is re-admitted, and the response says what it was and now is', async t => {
  const { store, server, base } = await serve(async project => ({
    ok: true, state: 'pending', previousState: 'failed', revision: 'b'.repeat(40), project,
  }))
  t.after(() => server.close())
  enrol(store)
  store.submit({ assignmentId: 'hw', studentId: 'ada', contentRef: 'submission-hw-ada' })
  principal = { role: 'instructor' }

  const response = await fetch(`${base}/assignments/hw/submissions/ada/rerender`, { method: 'POST' })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.project, 'submission-hw-ada')
  assert.equal(body.previousState, 'failed')
  assert.equal(body.state, 'pending')
  assert.equal(body.revision, 'b'.repeat(40))
})

// The scoping is the reason this route may exist at all, so it is asserted
// against a caller that TRIES to widen it rather than against a caller that
// cannot. The previous version of this file checked the project handed to the
// re-run while the route had no way to accept one — true, and unable to fail.
// A `project` in the body is the obvious widening, and it must be ignored: the
// project comes off the submission record or this becomes a general rebuild API
// that re-runs any project an instructor can name.
test('a project named by the caller is ignored, not honoured', async t => {
  const calls = []
  const { store, server, base } = await serve(async project => {
    calls.push(project)
    return { ok: true, state: 'pending', previousState: 'failed', revision: 'c'.repeat(40) }
  })
  t.after(() => server.close())
  enrol(store)
  store.submit({ assignmentId: 'hw', studentId: 'ada', contentRef: 'submission-hw-ada' })
  principal = { role: 'instructor' }

  const response = await fetch(`${base}/assignments/hw/submissions/ada/rerender`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: 'qtm285-book', name: 'qtm285-book', contentRef: 'qtm285-book' }),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(calls, ['submission-hw-ada'], 'the caller widened the route to another project')
  assert.equal((await response.json()).project, 'submission-hw-ada')
})
