/**
 * The thread author contract, through the real projects router.
 *
 * A layer's author is stamped server-side from the resolved classroom
 * principal at record time, never from the client's body — a caller who could
 * name their own author could speak as the other side of the thread. The
 * drafts listing then exposes it, so the player's speaker label reads off a
 * persisted row rather than off nothing.
 *
 * This mounts the actual `routes/projects.mjs` router (the production POST
 * `/:name/recording` persistence and GET `/:name/recording-drafts` listing,
 * not copies of their shape) over a temp project store and classroom store,
 * with `resolveClassroomPrincipal` installed the way the unified server does.
 * Gating is off in this harness (`server.yaml` unset), so every request is
 * admitted by the bearer positions and the thread decision comes from the
 * classroom identity alone: instructor and answering student file, a stranger
 * is refused, and spoofed body authors are overwritten by the derived row.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import projectRoutes from './projects.mjs'
import { closeProjectStore, createProject, initProjectStore } from '../lib/project-store.mjs'
import { ClassroomStore } from '../lib/classroom-store.mjs'
import { classroomPrincipal } from './classroom.mjs'

const COURSE = 'qtm285'
const OWNER = 'ada'
const ADA_TOKEN = 'ada-enrollment-token'
const INSTRUCTOR_TOKEN = 'instructor-token'
const OTHER_TOKEN = 'other-enrollment-token'
// What `submissionDocumentOwner` looks the owner up by: the submission's
// content ref, which the answer carries with its `doc-` room prefix.
const CONTENT_REF = 'hw1-ada'
const PROJECT = 'thread-author-book'
const ANSWER = { submissionRoomId: `doc-${CONTENT_REF}`, problemId: 'ans-ex3' }

function storeWithThread(root) {
  const store = new ClassroomStore(join(root, 'classroom.db'))
  store.upsertCourse({ id: COURSE, title: 'QTM 285', preferredName: 'Instructor' })
  store.upsertStudent({ id: OWNER, courseId: COURSE, displayName: 'Ada', enrollmentToken: ADA_TOKEN })
  store.upsertStudent({ id: 'bo', courseId: COURSE, displayName: 'Bo', enrollmentToken: OTHER_TOKEN })
  store.upsertAssignment({ id: 'hw1', courseId: COURSE, title: 'Homework 1', dueAt: '2026-09-01T20:00:00Z' })
  store.submit({ assignmentId: 'hw1', studentId: OWNER, contentRef: CONTENT_REF })
  store.registerInstructor({ courseId: COURSE, displayName: 'Sam', universityLogin: 'sam', token: INSTRUCTOR_TOKEN })
  return store
}

test('spoofed authors are stripped, derived authors persist, the listing exposes them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-thread-author-route-'))
  const projectsDir = join(root, 'projects')
  const store = storeWithThread(root)
  const app = express()
  app.use(express.json())
  app.locals.classroomStore = store
  app.locals.resolveClassroomPrincipal = (req, classroomStore) => classroomPrincipal(req, classroomStore)
  app.use('/api/projects', projectRoutes)
  const server = createServer(app)
  try {
    await initProjectStore(projectsDir)
    createProject({ name: PROJECT, title: 'Thread author book', format: 'svg' })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}`

    const post = (id, classroomToken, extra = {}) => fetch(`${base}/api/projects/${PROJECT}/recording`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(classroomToken ? { 'x-tlda-student-token': classroomToken } : {}),
      },
      body: JSON.stringify({ id, title: id, created: new Date().toISOString(), duration_ms: 1_000, events: [], answer: ANSWER, ...extra }),
    })
    const drafts = (classroomToken = null) => fetch(`${base}/api/projects/${PROJECT}/recording-drafts`, {
      headers: { ...(classroomToken ? { 'x-tlda-student-token': classroomToken } : {}) },
    }).then((r) => r.json())

    // A lecture (no answer) keeps no author: nothing to stamp, and the row's
    // shape is unchanged.
    const lecture = await fetch(`${base}/api/projects/${PROJECT}/recording`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'lecture-1', title: 'Lecture 1', created: new Date().toISOString(), duration_ms: 1_000, events: [] }),
    })
    assert.equal(lecture.status, 200)

    // Each layer also gets its audio blob: the drafts listing only surfaces
    // recordings that have one, which is how the production outbox delivers
    // (metadata first, audio after).
    const putAudio = (id, classroomToken) => fetch(`${base}/api/projects/${PROJECT}/recording/${id}/audio`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm', 'x-tlda-student-token': classroomToken },
      body: Buffer.from('fake-audio'),
    })

    // The instructor claims the student's voice in the body; the persisted row
    // must still read instructor.
    const spoofedInstructor = await post('layer-instructor', INSTRUCTOR_TOKEN, {
      author: { role: 'student', studentId: OWNER },
    })
    assert.equal(spoofedInstructor.status, 200)
    assert.equal((await putAudio('layer-instructor', INSTRUCTOR_TOKEN)).status, 200)

    // The answering student claims the instructor's voice; the persisted row
    // must still read the student.
    const spoofedStudent = await post('layer-student', ADA_TOKEN, {
      author: { role: 'instructor' },
    })
    assert.equal(spoofedStudent.status, 200)
    assert.equal((await putAudio('layer-student', ADA_TOKEN)).status, 200)

    // A participant may checkpoint their own layer, but cannot reuse the
    // other participant's id to relabel audio that is already stored there.
    const studentRelabelsInstructor = await post('layer-instructor', ADA_TOKEN, {
      duration_ms: 2_000,
      author: { role: 'instructor' },
    })
    assert.equal(studentRelabelsInstructor.status, 409)
    const instructorRelabelsStudent = await post('layer-student', INSTRUCTOR_TOKEN, {
      duration_ms: 2_000,
      author: { role: 'student', studentId: OWNER },
    })
    assert.equal(instructorRelabelsStudent.status, 409)

    // The listing narrows per row: a bearer-only caller is nobody on the
    // thread, so they see no answer layers and no lecture. Each participant
    // sees the thread; the instructor additionally sees the lecture.
    const listedBare = await drafts()
    assert.equal(listedBare.recordings.some((r) => r.id === 'layer-instructor'), false)
    assert.equal(listedBare.recordings.some((r) => r.id === 'layer-student'), false)
    assert.equal(listedBare.recordings.some((r) => r.id === 'lecture-1'), false)

    const listedInstructor = await drafts(INSTRUCTOR_TOKEN)
    const byInstructor = new Map(listedInstructor.recordings.map((r) => [r.id, r]))
    // The lecture carries no audio, so the listing hides it (same as any
    // undelivered draft); its persisted shape is asserted off disk below.
    assert.deepEqual(byInstructor.get('layer-instructor').author, { role: 'instructor' })
    assert.deepEqual(byInstructor.get('layer-student').author, { role: 'student', studentId: OWNER })
    assert.equal(byInstructor.get('layer-instructor').duration_ms, 1_000)
    assert.equal(byInstructor.get('layer-student').duration_ms, 1_000)
    const persistedLecture = JSON.parse(readFileSync(join(projectsDir, PROJECT, 'recordings', 'lecture-1.json'), 'utf8'))
    assert.deepEqual(persistedLecture.author, undefined)

    const listedStudent = await drafts(ADA_TOKEN)
    const byStudent = new Map(listedStudent.recordings.map((r) => [r.id, r]))
    assert.deepEqual(byStudent.get('layer-instructor').author, { role: 'instructor' })
    assert.deepEqual(byStudent.get('layer-student').author, { role: 'student', studentId: OWNER })
    // A lecture answers nobody, so it is never the student's — the row filter
    // holds it back from every non-instructor, including the thread's owner.
    assert.equal(byStudent.has('lecture-1'), false)

    // A stranger to the answer — another student — is refused by the create
    // gate before anything is persisted. The row is never written.
    const stranger = await post('layer-stranger', OTHER_TOKEN)
    assert.equal(stranger.status, 403)
    assert.equal((await drafts()).recordings.some((r) => r.id === 'layer-stranger'), false)
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve))
    await closeProjectStore()
    store.db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
