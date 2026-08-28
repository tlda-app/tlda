import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ClassroomStore } from '../server/lib/classroom-store.mjs'
import { classroomPrincipal, createClassroomRouter } from '../server/routes/classroom.mjs'

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
  app.use('/api/classroom', createClassroomRouter({ store, resolveRegistrationAccess: req => req.headers.authorization === 'Bearer read-access', resolveManifestAccess: req => req.query.token === 'read-access', resolveTemplateVersion(docKey) {
    if (docKey !== 'hw1-handout') throw new Error('template document not found')
    return 'build-abc'
  }, resolvePrincipal(req, classroomStore) {
    const role = req.headers['x-test-role']
    if (role === 'instructor') return { role }
    if (role === 'ada') return { role: 'student', studentId: 'ada', courseId: 'qtm285' }
    if (role === 'grace') return { role: 'student', studentId: 'grace', courseId: 'qtm285' }
    const student = classroomStore.studentForToken(req.headers['x-tlda-student-token'])
    return student ? { role: 'student', studentId: student.id, courseId: student.courseId } : null
  } }))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const base = `http://127.0.0.1:${server.address().port}/api/classroom`
  return { store, async request(route, role, init) { return fetch(base + route, { ...init, headers: { 'content-type': 'application/json', 'x-test-role': role, ...(init?.headers || {}) } }) }, close() { server.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }) } }
}

test('a classroom enrollment token identifies a student without exposing the global read bearer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-classroom-principal-'))
  const store = new ClassroomStore(path.join(dir, 'classroom.db'))
  try {
    store.upsertCourse({ id: 'qtm285', title: 'QTM 285' })
    store.upsertStudent({ id: 'ada', courseId: 'qtm285', displayName: 'Ada', enrollmentToken: 'student-secret' })
    const principal = classroomPrincipal({ headers: { 'x-tlda-student-token': 'student-secret' }, query: {} }, store, null)
    assert.deepEqual(principal, { role: 'student', studentId: 'ada', courseId: 'qtm285', layerScope: 'student' })
    assert.equal(classroomPrincipal({ headers: { 'x-tlda-student-token': 'wrong' }, query: {} }, store, null), null)
  } finally {
    store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

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
      headers: { authorization: 'Bearer read-access' },
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
      headers: { authorization: 'Bearer read-access' },
      body: JSON.stringify({ displayName: 'Someone Else', universityLogin: 'kjohn42' }),
    })
    assert.equal(response.status, 409)
  } finally { f.close() }
})

test('a class-scoped web app manifest carries only the class, project, and ordinary read bearer', async () => {
  const f = await serverFixture()
  try {
    assert.equal((await f.request('/courses/qtm285/manifest.webmanifest?project=course-book', '')).status, 401)
    const response = await f.request('/courses/qtm285/manifest.webmanifest?project=course-book&token=read-access', '')
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/manifest+json; charset=utf-8')
    const manifest = await response.json()
    assert.equal(manifest.name, 'QTM 285')
    assert.equal(manifest.display, 'standalone')
    const start = new URL(manifest.start_url, 'https://class.example')
    assert.equal(start.searchParams.get('project'), 'course-book')
    assert.equal(start.searchParams.get('course'), 'qtm285')
    assert.equal(start.searchParams.get('token'), 'read-access')
    assert.equal(start.searchParams.has('classroomToken'), false)
    assert.equal(manifest.icons.length, 1)
    assert.match(manifest.icons[0].src, /^\/api\/classroom\/courses\/qtm285\/icon\.svg\?token=read-access$/)
    assert.doesNotMatch(JSON.stringify(manifest), /ada-secret|classroomToken/)

    const icon = await f.request(manifest.icons[0].src.replace('/api/classroom', ''), '')
    assert.equal(icon.status, 200)
    assert.equal(icon.headers.get('content-type'), 'image/svg+xml; charset=utf-8')
    assert.match(await icon.text(), />Q2<\/text>/)
  } finally { f.close() }
})

test('a student transfers their enrollment to one new device without exposing or replacing either credential', async () => {
  const f = await serverFixture()
  try {
    let response = await f.request('/courses/qtm285/device-transfer', 'ada', {
      method: 'POST',
      headers: { authorization: 'Bearer read-access' },
      body: JSON.stringify({ returnPath: '/?project=course-book&classroomToken=ada-secret&name=someone-else' }),
    })
    assert.equal(response.status, 201)
    const transfer = await response.json()
    const transferUrl = new URL(transfer.transferUrl)
    const transferCode = transferUrl.searchParams.get('transfer')
    assert.equal(transferUrl.searchParams.get('workspace'), 'classroom-transfer')
    assert.equal(transferUrl.searchParams.get('course'), 'qtm285')
    assert.equal(transferUrl.searchParams.get('token'), 'read-access')
    assert.equal(transferUrl.searchParams.get('project'), 'course-book')
    assert.equal(transferUrl.searchParams.has('name'), false)
    assert.ok(transferCode?.length > 30)
    assert.equal(transferUrl.searchParams.has('classroomToken'), false)
    assert.doesNotMatch(transfer.transferUrl, /ada-secret/)
    assert.match(transfer.qrSvg, /^<svg /)
    assert.doesNotMatch(transfer.qrSvg, /ada-secret|classroomToken/)

    response = await f.request('/courses/qtm285/device-transfer/redeem', '', {
      method: 'POST', headers: { authorization: 'Bearer read-access' }, body: JSON.stringify({ transferCode }),
    })
    assert.equal(response.status, 200)
    const redeemed = await response.json()
    assert.equal(redeemed.student.id, 'ada')
    assert.notEqual(redeemed.enrollmentToken, 'ada-secret')
    assert.equal(f.store.studentForToken('ada-secret').id, 'ada', 'the first device was logged out')
    assert.equal(f.store.studentForToken(redeemed.enrollmentToken).id, 'ada')

    response = await f.request('/me', '', { headers: { 'x-tlda-student-token': redeemed.enrollmentToken } })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { role: 'student', studentId: 'ada', courseId: 'qtm285' })

    response = await f.request('/courses/qtm285/device-transfer/redeem', '', {
      method: 'POST', headers: { authorization: 'Bearer read-access' }, body: JSON.stringify({ transferCode }),
    })
    assert.equal(response.status, 409, 'the transfer code replayed')
  } finally { f.close() }
})

test('device transfer rejects instructor, anonymous, wrong-course and expired attempts', async () => {
  const f = await serverFixture()
  try {
    f.store.upsertCourse({ id: 'other', title: 'Other course' })
    assert.equal((await f.request('/courses/qtm285/device-transfer', 'instructor', { method: 'POST' })).status, 403)
    assert.equal((await f.request('/courses/qtm285/device-transfer', '', { method: 'POST' })).status, 401)
    assert.equal((await f.request('/courses/other/device-transfer', 'ada', { method: 'POST' })).status, 403)

    let response = await f.request('/courses/qtm285/device-transfer', 'ada', { method: 'POST', headers: { authorization: 'Bearer read-access' } })
    const transferCode = new URL((await response.json()).transferUrl).searchParams.get('transfer')
    assert.equal((await f.request('/courses/qtm285/device-transfer/redeem', '', {
      method: 'POST', body: JSON.stringify({ transferCode }),
    })).status, 401, 'a transfer redeemed without the class read bearer')
    response = await f.request('/courses/other/device-transfer/redeem', '', {
      method: 'POST', headers: { authorization: 'Bearer read-access' }, body: JSON.stringify({ transferCode }),
    })
    assert.equal(response.status, 404)
    response = await f.request('/courses/qtm285/device-transfer/redeem', '', {
      method: 'POST', headers: { authorization: 'Bearer read-access' }, body: JSON.stringify({ transferCode }),
    })
    assert.equal(response.status, 200, 'a wrong-course attempt consumed the transfer code')

    f.store.createDeviceTransfer({
      studentId: 'ada',
      courseId: 'qtm285',
      transferCode: 'expired-code',
      createdAt: '2026-08-27T23:00:00.000Z',
      expiresAt: '2026-08-27T23:10:00.000Z',
    })
    response = await f.request('/courses/qtm285/device-transfer/redeem', '', {
      method: 'POST', headers: { authorization: 'Bearer read-access' }, body: JSON.stringify({ transferCode: 'expired-code' }),
    })
    assert.equal(response.status, 410)
    assert.equal(f.store.studentForToken('expired-code'), null)
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

test('instructor creates a common-layer student through the ordinary student API', async () => {
  const f = await serverFixture()
  try {
    let response = await f.request('/courses/qtm285/students', 'instructor', {
      method: 'POST',
      body: JSON.stringify({ id: 'demo', displayName: 'Demo Student', enrollmentToken: 'demo-secret', layerScope: 'common' }),
    })
    assert.equal(response.status, 201)
    assert.equal((await response.json()).layerScope, 'common')

    response = await f.request('/courses/qtm285/status', 'instructor')
    const demo = (await response.json()).rows.find(row => row.id === 'demo')
    assert.equal(demo.layerScope, 'common')
    assert.equal(demo.assignments[0].state, 'not-submitted')

    response = await f.request('/courses/qtm285/students', 'instructor', {
      method: 'POST',
      body: JSON.stringify({ id: 'bad', displayName: 'Bad Scope', enrollmentToken: 'bad-secret', layerScope: 'public-demo' }),
    })
    assert.equal(response.status, 400)
  } finally { f.close() }
})
