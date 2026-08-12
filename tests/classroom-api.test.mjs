import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ClassroomStore } from '../server/lib/classroom-store.mjs'
import { createClassroomRouter } from '../server/routes/classroom.mjs'

async function serverFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-classroom-api-'))
  const store = new ClassroomStore(path.join(dir, 'classroom.db'))
  store.upsertCourse({ id: 'qtm285', title: 'QTM 285' })
  store.upsertStudent({ id: 'ada', courseId: 'qtm285', displayName: 'Ada', enrollmentToken: 'ada-secret' })
  store.upsertStudent({ id: 'grace', courseId: 'qtm285', displayName: 'Grace', enrollmentToken: 'grace-secret' })
  store.upsertAssignment({ id: 'hw1', courseId: 'qtm285', title: 'Homework 1', dueAt: '2026-09-01T20:00:00Z' })
  store.submit({ assignmentId: 'hw1', studentId: 'ada', contentRef: 'hw1-ada' })
  store.addFeedback({ id: 'draft', assignmentId: 'hw1', studentId: 'ada', title: 'Draft', text: 'Private.' })
  const app = express(); app.use(express.json())
  app.use('/api/classroom', createClassroomRouter({ store, resolveRegistrationAccess: () => true, resolveTemplateVersion(docKey) {
    if (docKey !== 'hw1-handout') throw new Error('template document not found')
    return 'build-abc'
  }, resolvePrincipal(req) {
    const role = req.headers['x-test-role']
    return role === 'instructor' ? { role } : role === 'ada' ? { role: 'student', studentId: 'ada', courseId: 'qtm285' } : role === 'grace' ? { role: 'student', studentId: 'grace', courseId: 'qtm285' } : null
  } }))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const base = `http://127.0.0.1:${server.address().port}/api/classroom`
  return { store, async request(route, role, init) { return fetch(base + route, { ...init, headers: { 'content-type': 'application/json', 'x-test-role': role, ...(init?.headers || {}) } }) }, close() { server.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }) } }
}

test('student can read own submission but not another student or instructor drafts', async () => {
  const f = await serverFixture()
  try {
    let response = await f.request('/assignments/hw1/submissions/ada', 'ada')
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).feedback, [])
    response = await f.request('/assignments/hw1/submissions/ada', 'grace')
    assert.equal(response.status, 403)
    response = await f.request('/assignments/hw1/submissions/ada', 'instructor')
    assert.equal((await response.json()).feedback[0].id, 'draft')
  } finally { f.close() }
})

test('a student cannot bypass archive hand-in with an arbitrary document key', async () => {
  const f = await serverFixture()
  try {
    const response = await f.request('/assignments/hw1/submit', 'grace', {
      method: 'POST',
      body: JSON.stringify({ contentRef: 'anything-I-name' }),
    })
    assert.equal(response.status, 404)
    assert.equal(f.store.getSubmission('hw1', 'grace'), null)
  } finally { f.close() }
})

test('a student can register their name and university login and receive a token', async () => {
  const f = await serverFixture()
  try {
    let response = await f.request('/courses/qtm285/register', '', {
      method: 'POST',
      body: JSON.stringify({ displayName: 'Katherine Johnson', universityLogin: 'kjohn42' }),
    })
    assert.equal(response.status, 201)
    const registration = await response.json()
    assert.equal(registration.student.displayName, 'Katherine Johnson')
    assert.equal(registration.student.id, 'qtm285:kjohn42')
    assert.equal(f.store.studentForToken(registration.enrollmentToken).id, registration.student.id)
    assert.equal(f.store.listStudents('qtm285').find(student => student.id === registration.student.id).universityLogin, 'kjohn42')

    response = await f.request('/courses/qtm285/register', '', {
      method: 'POST',
      body: JSON.stringify({ displayName: 'Someone Else', universityLogin: 'kjohn42' }),
    })
    assert.equal(response.status, 409)
  } finally { f.close() }
})

test('only instructor can read gradebook and return feedback', async () => {
  const f = await serverFixture()
  try {
    assert.equal((await f.request('/courses/qtm285/status', 'ada')).status, 403)
    assert.equal((await f.request('/courses/qtm285/status', 'instructor')).status, 200)
    assert.equal((await f.request('/assignments/hw1/submissions/ada/return', 'ada', { method: 'POST' })).status, 403)
    const returned = await f.request('/assignments/hw1/submissions/ada/return', 'instructor', { method: 'POST' })
    assert.equal(returned.status, 200)
    assert.equal((await returned.json()).gradingStatus, 'returned')
  } finally { f.close() }
})

test('only instructor can freeze the generated handout reference', async () => {
  const f = await serverFixture()
  try {
    const body = JSON.stringify({ templateDocKey: 'hw1-handout' })
    assert.equal((await f.request('/assignments/hw1/template', 'ada', { method: 'PUT', body })).status, 403)
    const frozen = await f.request('/assignments/hw1/template', 'instructor', { method: 'PUT', body })
    assert.equal(frozen.status, 200)
    assert.equal((await frozen.json()).templateDocKey, 'hw1-handout')
    const missing = await f.request('/assignments/hw1/template', 'instructor', { method: 'PUT', body: JSON.stringify({ templateDocKey: 'other' }) })
    assert.equal(missing.status, 404)
  } finally { f.close() }
})
