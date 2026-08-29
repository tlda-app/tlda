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

const ASSIGNMENT = 'hw-minus-1-setup'
const COURSE = 'qtm285'
const OWNER = `${COURSE}:ada`
const CLASSMATE = `${COURSE}:biko`
const SUBMISSION = `submission-${ASSIGNMENT}-${OWNER}`

/** A store holding one course, two students, and one submission by the first. */
function storeWithOneSubmission(root) {
  const store = new ClassroomStore(join(root, 'classroom.db'))
  store.upsertCourse({ id: COURSE, title: 'QTM 285' })
  store.registerStudent({ courseId: COURSE, displayName: 'Ada', universityLogin: 'ada', enrollmentToken: 'tok-ada' })
  store.registerStudent({ courseId: COURSE, displayName: 'Biko', universityLogin: 'biko', enrollmentToken: 'tok-biko' })
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
