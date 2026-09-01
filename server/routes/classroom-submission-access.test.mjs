// A handed-in assignment is the student's own, over HTTP as well as over sync.
//
// Measured on the live course box before this gate existed: the shared class
// read token — the one on the QR code, the one every classmate holds — returned
// `/api/projects` listing three submissions by student login, and then the
// rendered homework and the attached photograph of each. `classroomRoomAccess`
// already refuses one student a look at another's sync layer; nothing said the
// same thing about the documents.
//
// The three surfaces below are the three a classmate actually used, so each one
// is asserted separately: the index that names them, the project record, and the
// document itself. Every refusal is paired with the instructor and the owning
// student succeeding on the same URL — a gate that also refuses the two people
// entitled to it is not a gate, it is an outage.

import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClassroomStore } from '../lib/classroom-store.mjs'
import { classroomPrincipal, requireClassroomDocumentAccess } from './classroom.mjs'
import projectRoutes from './projects.mjs'

const ASSIGNMENT = 'hw-minus-1-setup'
const COURSE = 'qtm285'
const OWNER = `${COURSE}:ada`
const CLASSMATE = `${COURSE}:biko`
const SUBMISSION = `submission-${ASSIGNMENT}-${OWNER}`

/** A store holding one course, two students, and one submission by the first. */
function storeWithOneSubmission(root) {
  const store = new ClassroomStore(join(root, 'classroom.db'))
  store.upsertCourse({ id: COURSE, title: 'QTM 285' })
  store.registerStudent({ courseId: COURSE, preferredName: 'Ada', universityLogin: 'ada', enrollmentToken: 'tok-ada' })
  store.registerStudent({ courseId: COURSE, preferredName: 'Biko', universityLogin: 'biko', enrollmentToken: 'tok-biko' })
  store.upsertAssignment({ id: ASSIGNMENT, courseId: COURSE, title: 'Setup', dueAt: '2026-09-01T00:00:00.000Z' })
  store.submit({ assignmentId: ASSIGNMENT, studentId: OWNER, contentRef: SUBMISSION })
  return store
}

const instructor = { role: 'instructor' }
const owner = { role: 'student', studentId: OWNER, courseId: COURSE, layerScope: 'student' }
const classmate = { role: 'student', studentId: CLASSMATE, courseId: COURSE, layerScope: 'student' }

function withStore(fn) {
  const root = mkdtempSync(join(tmpdir(), 'tlda-submission-access-'))
  const store = storeWithOneSubmission(root)
  try { return fn(store) } finally { store.db.close(); rmSync(root, { recursive: true, force: true }) }
}

test('the store refuses a submission to a read-token visitor and to a classmate', () => {
  withStore(store => {
    // The read link carries no classroom identity at all, which is exactly what
    // a student scanning the QR code has.
    const anonymous = store.documentAccess(SUBMISSION, null)
    assert.equal(anonymous.restricted, true)
    assert.equal(anonymous.allowed, false)
    assert.equal(anonymous.submission.studentId, OWNER)

    assert.equal(store.documentAccess(SUBMISSION, classmate).allowed, false)

    assert.equal(store.documentAccess(SUBMISSION, instructor).allowed, true)
    assert.equal(store.documentAccess(SUBMISSION, owner).allowed, true)
  })
})

test('an ordinary project is not restricted by this rule', () => {
  withStore(store => {
    const access = store.documentAccess('qtm285-book', null)
    assert.equal(access.restricted, false)
    assert.equal(access.allowed, true)
    assert.equal(access.submission, undefined)
  })
})

test('the owner is found from the submission record, not from the name', () => {
  withStore(store => {
    // `submission-<assignment>-<student>` where both halves hold a `-`. Any
    // parse of this string has to guess where the split is; the record does not.
    assert.equal(store.submissionDocumentOwner(SUBMISSION).studentId, OWNER)
    assert.equal(store.submissionDocumentOwner(`submission-${ASSIGNMENT}-${CLASSMATE}`), null)
    assert.equal(store.submissionDocumentOwner('qtm285-book'), null)
  })
})

test('the enrolment token reaches the principal on the URL as well as the header', () => {
  withStore(store => {
    const asHeader = { headers: { 'x-tlda-student-token': 'tok-ada' }, query: {} }
    const asQuery = { headers: {}, query: { classroomToken: 'tok-ada' } }
    // `read` rather than the real token check: this asserts which carrier is
    // read, not what the bearer token was.
    assert.equal(classroomPrincipal(asHeader, store, 'read').studentId, OWNER)
    assert.equal(classroomPrincipal(asQuery, store, 'read').studentId, OWNER)
    assert.equal(classroomPrincipal({ headers: {}, query: {} }, store, 'read'), null)
    // An rw token is the instructor whatever it carries beside it.
    assert.deepEqual(classroomPrincipal(asQuery, store, 'rw'), { role: 'instructor' })
  })
})

test('the index shows each student their own submission and nobody else theirs', () => {
  withStore(store => {
    const theirs = `submission-${ASSIGNMENT}-${CLASSMATE}`
    store.submit({ assignmentId: ASSIGNMENT, studentId: CLASSMATE, contentRef: theirs })
    const all = [{ name: 'qtm285-book' }, { name: SUBMISSION }, { name: theirs }]
    // The filter the listing route applies, over the same one rule.
    const visibleTo = principal => all
      .filter(project => {
        const access = store.documentAccess(project.name, principal)
        return access.submission ? access.allowed : true
      })
      .map(project => project.name)

    assert.deepEqual(visibleTo(null), ['qtm285-book'])
    assert.deepEqual(visibleTo(owner), ['qtm285-book', SUBMISSION])
    assert.deepEqual(visibleTo(classmate), ['qtm285-book', theirs])
    assert.deepEqual(visibleTo(instructor), ['qtm285-book', SUBMISSION, theirs])
  })
})

/** The middleware, mounted the way `/api/projects/:name` mounts it. */
async function documentRequest(store, principal) {
  const app = express()
  app.locals.classroomStore = store
  app.locals.resolveClassroomPrincipal = () => principal
  app.use('/api/projects/:name', requireClassroomDocumentAccess, (req, res) => res.json({ ok: true }))
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/projects/${encodeURIComponent(SUBMISSION)}`)
    return { status: response.status, body: await response.json() }
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

test('the document route refuses the class read link and serves the instructor and the owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-submission-route-'))
  const store = storeWithOneSubmission(root)
  try {
    const refused = await documentRequest(store, null)
    assert.equal(refused.status, 403)
    // The message names which of the two refusals this is, because the next
    // action differs: hand something in, or ask whose work it is.
    assert.match(refused.body.error, /readable by the student who handed it in/)

    assert.equal((await documentRequest(store, classmate)).status, 403)
    assert.deepEqual(await documentRequest(store, instructor), { status: 200, body: { ok: true } })
    assert.deepEqual(await documentRequest(store, owner), { status: 200, body: { ok: true } })
  } finally {
    store.db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * The real project router, so route ORDER is part of what is under test.
 *
 * `router.use('/:name', requireClassroomDocumentAccess)` sits below two mounts
 * that also match a project name, so express reaches those first and they never
 * met the gate. A test that mounts the middleware by hand cannot see that — the
 * defect is entirely in which line comes first.
 */
async function projectRouterCall(store, principal, path, init = {}) {
  const app = express()
  app.use(express.json())
  app.locals.classroomStore = store
  app.locals.resolveClassroomPrincipal = () => principal
  app.use('/api/projects', projectRoutes)
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, init)
    const text = await response.text()
    return { status: response.status, text }
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

const projectRouterRequest = async (...args) => (await projectRouterCall(...args)).status

/** How many projects a batch history response actually answered for. */
function answeredCount(text) {
  const projects = JSON.parse(text).projects
  return Array.isArray(projects) ? projects.length : Object.keys(projects || {}).length
}

test('a submission\'s history is refused to the class read link and reachable by the instructor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-submission-history-'))
  const store = storeWithOneSubmission(root)
  const encoded = encodeURIComponent(SUBMISSION)
  try {
    // Measured 200 on the live course box with the shared read token before this.
    assert.equal(await projectRouterRequest(store, null, `/api/projects/${encoded}/history/shadow`), 403)
    assert.equal(await projectRouterRequest(store, classmate, `/api/projects/${encoded}/history/shadow`), 403)
    // The instructor is not refused. What the handler then does with a project
    // that is not on disk is not this test's business — only that the gate is
    // not what stopped them.
    assert.notEqual(await projectRouterRequest(store, instructor, `/api/projects/${encoded}/history/shadow`), 403)
    assert.notEqual(await projectRouterRequest(store, owner, `/api/projects/${encoded}/history/shadow`), 403)

    // The book, which every reader must keep.
    assert.notEqual(await projectRouterRequest(store, null, '/api/projects/qtm285-book/history/shadow'), 403)
  } finally {
    store.db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('the batch changelog drops submissions it was asked for by name in the body', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-submission-batch-'))
  const store = storeWithOneSubmission(root)
  const body = (names) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projects: names }),
  })
  try {
    // A name in the request BODY is invisible to any path gate. Both batch
    // routes take one, and both return a project's history.
    // `changelog/batch` answers for every name it is given, so the count is a
    // real discriminator here: dropped by the filter reads 0, kept reads 1.
    //
    // The refusal is that the name is DROPPED, not that the call errors, so the
    // status is 200 either way and only the count can see it. Asserting the
    // status alone stays green with the filter removed — which is the shape this
    // whole file is about.
    const route = '/api/projects/history/shadow/changelog/batch'

    const refused = await projectRouterCall(store, null, route, body([SUBMISSION]))
    assert.equal(refused.status, 200)
    assert.equal(answeredCount(refused.text), 0)
    assert.equal(answeredCount((await projectRouterCall(store, classmate, route, body([SUBMISSION]))).text), 0)

    // The owner and the instructor are answered for, which is what makes the
    // zero above a refusal rather than the route being broken.
    assert.equal(answeredCount((await projectRouterCall(store, instructor, route, body([SUBMISSION]))).text), 1)
    assert.equal(answeredCount((await projectRouterCall(store, owner, route, body([SUBMISSION]))).text), 1)

    // `/history/shadow/index` takes its names the same way and gets the same
    // filter on the same line. It is NOT asserted here: it selects projects that
    // have real history, so it answers 0 for the instructor too, and a check
    // that cannot tell a refusal from an empty project is not a check. Proving
    // it needs a project store on disk, which this file does not stand up.
  } finally {
    store.db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a common-scope student\'s work stays readable by their classmates', () => {
  withStore(store => {
    // `layerScope: 'common'` is an explicit opt-in — never the default — and
    // `canReadStudent` already let classmates read such a student's submission
    // ROW. The document, the index, the history and the sync room ask the same
    // question now, so they must give the same answer; a quieter one here would
    // be a product change smuggled in under a privacy fix.
    assert.equal(store.documentAccess(SUBMISSION, classmate).allowed, false)

    store.upsertStudent({
      id: OWNER, courseId: COURSE, displayName: 'Ada', enrollmentToken: 'tok-ada', layerScope: 'common',
    })
    assert.equal(store.getStudent(OWNER).layerScope, 'common')
    assert.equal(store.documentAccess(SUBMISSION, classmate).allowed, true)

    // And it buys nothing to the read link, which is the exposure.
    assert.equal(store.documentAccess(SUBMISSION, null).allowed, false)
    // Nor to somebody enrolled in a different course.
    assert.equal(store.documentAccess(SUBMISSION, { role: 'student', studentId: 'other:zed', courseId: 'other' }).allowed, false)
  })
})
