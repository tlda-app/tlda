import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { strFromU8, unzipSync, zipSync } from 'fflate'
import { ClassroomStore } from '../server/lib/classroom-store.mjs'
import { closeProjectStore, initProjectStore, readProject, sourceDir } from '../server/lib/project-store.mjs'
import { createClassroomRouter } from '../server/routes/classroom.mjs'

test('a common-layer student uses the real hand-in, gradebook, marking, return, and export wire', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-classroom-handin-return-'))
  const store = new ClassroomStore(path.join(dir, 'classroom.db'))
  const projects = path.join(dir, 'projects')
  await initProjectStore(projects)

  store.upsertCourse({ id: 'qtm285', title: 'QTM 285' })
  store.upsertStudent({ id: 'ada', courseId: 'qtm285', displayName: 'Ada', enrollmentToken: 'ada-secret', layerScope: 'common' })
  store.upsertStudent({ id: 'grace', courseId: 'qtm285', displayName: 'Grace', enrollmentToken: 'grace-secret' })
  store.upsertAssignment({ id: 'hw1', courseId: 'qtm285', title: 'Homework 1', dueAt: '2026-09-01T20:00:00Z' })

  const builds = []
  let buildError = null
  const app = express()
  app.use(express.json())
  app.use('/api/classroom', createClassroomRouter({
    store,
    resolvePrincipal(req) {
      return req.headers['x-test-role'] === 'instructor'
        ? { role: 'instructor' }
        : req.headers['x-test-role'] === 'ada'
          ? { role: 'student', studentId: 'ada', courseId: 'qtm285', layerScope: 'common' }
          : req.headers['x-test-role'] === 'grace'
            ? { role: 'student', studentId: 'grace', courseId: 'qtm285', layerScope: 'student' }
          : null
    },
    dispatchSubmissionBuild: async contentRef => {
      builds.push(contentRef)
      if (buildError) throw buildError
    },
  }))
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  const base = `http://127.0.0.1:${server.address().port}/api/classroom`
  const request = (route, role, init = {}) => fetch(base + route, {
    ...init,
    headers: { 'x-test-role': role, ...(init.headers || {}) },
  })

  try {
    const qmd = [
      '---',
      'title: Homework 1',
      '---',
      '',
      '## Problem 1 {#exr-one}',
      '',
      '::: {.answer #ans-exr-one}',
      'My answer.',
      ':::',
      '',
    ].join('\n')
    const archive = zipSync({ 'homework.qmd': new Uint8Array(Buffer.from(qmd)) })
    const uploaded = await request('/assignments/hw1/mine/upload', 'ada', {
      method: 'POST',
      headers: { 'content-type': 'application/zip' },
      body: archive,
    })
    const uploadedBody = await uploaded.text()
    assert.equal(uploaded.status, 200, uploadedBody)
    const submission = JSON.parse(uploadedBody)
    assert.equal(submission.contentRef, 'submission-hw1-ada')
    assert.deepEqual(submission.answerIds, ['ans-exr-one'])
    assert.equal((await readProject(submission.contentRef)).mainFile, 'homework.qmd')
    assert.equal(fs.readFileSync(path.join(sourceDir(submission.contentRef), 'homework.qmd'), 'utf8'), qmd)
    assert.deepEqual(builds, ['submission-hw1-ada'])

    const gradebook = await request('/courses/qtm285/status', 'instructor')
    assert.equal(gradebook.status, 200)
    const gradebookBody = await gradebook.json()
    assert.equal(gradebookBody.rows[0].layerScope, 'common')
    assert.equal(gradebookBody.rows[0].assignments[0].state, 'ungraded')

    const problems = await request('/assignments/hw1/problems', 'instructor')
    assert.equal(problems.status, 200)
    assert.equal((await problems.json()).problems[0].answers[0].layerScope, 'common')

    const feedback = await request('/assignments/hw1/submissions/ada/feedback', 'instructor', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Problem 1', text: 'Show the last step.' }),
    })
    assert.equal(feedback.status, 201)
    assert.equal((await request('/assignments/hw1/submissions/ada/grade', 'instructor', { method: 'POST' })).status, 200)
    const returned = await request('/assignments/hw1/submissions/ada/return', 'instructor', { method: 'POST' })
    assert.equal(returned.status, 200)
    assert.equal((await returned.json()).gradingStatus, 'returned')

    const mine = await request('/assignments/hw1/mine', 'ada')
    assert.equal(mine.status, 200)
    const visible = await mine.json()
    assert.equal(visible.gradingStatus, 'returned')
    assert.equal(visible.feedback.length, 1)
    assert.equal(visible.feedback[0].text, 'Show the last step.')
    assert.equal(visible.feedback[0].visibility, 'returned')

    const publicView = await request('/assignments/hw1/submissions/ada', 'grace')
    assert.equal(publicView.status, 200)
    assert.equal((await publicView.json()).contentRef, 'submission-hw1-ada')

    const exported = await request('/courses/qtm285/export', 'instructor')
    assert.equal(exported.status, 200)
    const files = unzipSync(new Uint8Array(await exported.arrayBuffer()))
    assert.match(strFromU8(files['README.md']), /Ada \(ada\) — returned/)
    assert.equal(strFromU8(files['hw1/ada/homework.qmd']), qmd)

    store.upsertAssignment({ id: 'hw2', courseId: 'qtm285', title: 'Homework 2', dueAt: '2026-09-08T20:00:00Z' })
    buildError = new Error('R package missing')
    const failedRender = await request('/assignments/hw2/mine/upload', 'ada', {
      method: 'POST',
      headers: { 'content-type': 'application/zip' },
      body: archive,
    })
    assert.equal(failedRender.status, 200, await failedRender.text())
    await new Promise(resolve => setImmediate(resolve))
    assert.equal((await readProject('submission-hw2-ada')).buildStatus, 'error')
  } finally {
    await new Promise(resolve => server.close(resolve))
    store.close()
    await closeProjectStore()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
