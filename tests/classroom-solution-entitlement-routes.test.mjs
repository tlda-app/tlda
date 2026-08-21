import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ClassroomStore } from '../server/lib/classroom-store.mjs'
import { createProject, closeProjectStore, initProjectStore, outputDir, writeSourceFileAsync } from '../server/lib/project-store.mjs'
import projectRoutes from '../server/routes/projects.mjs'
import { requireClassroomDocumentAccess } from '../server/routes/classroom.mjs'

async function serve() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-classroom-entitlement-'))
  const projects = path.join(dir, 'projects')
  await initProjectStore(projects)
  const store = new ClassroomStore(path.join(dir, 'classroom.db'))
  store.upsertCourse({ id: 'qtm285', title: 'QTM 285' })
  store.upsertStudent({ id: 'ada', courseId: 'qtm285', displayName: 'Ada', enrollmentToken: 'ada-secret' })
  store.upsertStudent({ id: 'bo', courseId: 'qtm285', displayName: 'Bo', enrollmentToken: 'bo-secret' })
  store.upsertAssignment({
    id: 'hw1',
    courseId: 'qtm285',
    title: 'Homework 1',
    dueAt: '2026-09-01T20:00:00Z',
    templateDocKey: 'hw1-handout',
    templateVersion: 'handout-rev',
    solutionsDocKey: 'hw1-solutions',
  })
  createProject({ name: 'hw1-solutions', title: 'HW1 solutions', mainFile: 'homework.qmd', format: 'html' })
  await writeSourceFileAsync('hw1-solutions', 'homework.qmd', 'solution source')
  fs.writeFileSync(path.join(outputDir('hw1-solutions'), 'page.html'), '<p>solution page</p>')

  const app = express()
  app.locals.classroomStore = store
  app.locals.resolveClassroomPrincipal = req => {
    const role = req.headers['x-test-role']
    if (role === 'instructor') return { role: 'instructor' }
    if (role === 'ada') return { role: 'student', studentId: 'ada', courseId: 'qtm285' }
    if (role === 'bo') return { role: 'student', studentId: 'bo', courseId: 'qtm285' }
    return null
  }
  app.use('/api/projects', projectRoutes)
  app.get('/docs/:name/:file', requireClassroomDocumentAccess, (req, res) => {
    res.sendFile(path.join(outputDir(req.params.name), req.params.file))
  })
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    store,
    get(route, role) { return fetch(base + route, { headers: { 'x-test-role': role } }) },
    async close() {
      server.close()
      store.close()
      await closeProjectStore()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('solution document project, source, and page routes require classroom entitlement', async () => {
  const f = await serve()
  try {
    assert.equal((await f.get('/api/projects/hw1-solutions', 'bo')).status, 403)
    assert.equal((await f.get('/api/projects/hw1-solutions/files', 'bo')).status, 403)
    assert.equal((await f.get('/api/projects/hw1-solutions/source/homework.qmd', 'bo')).status, 403)
    assert.equal((await f.get('/docs/hw1-solutions/page.html', 'bo')).status, 403)

    assert.equal((await f.get('/api/projects/hw1-solutions/source/homework.qmd', 'instructor')).status, 200)
    assert.equal((await f.get('/docs/hw1-solutions/page.html', 'instructor')).status, 200)

    f.store.submit({ assignmentId: 'hw1', studentId: 'ada', contentRef: 'submission-hw1-ada' })
    assert.equal((await f.get('/api/projects/hw1-solutions/source/homework.qmd', 'ada')).status, 200)
    assert.equal((await f.get('/docs/hw1-solutions/page.html', 'ada')).status, 200)
    assert.equal((await f.get('/api/projects/hw1-solutions/source/homework.qmd', 'bo')).status, 403)
  } finally {
    await f.close()
  }
})
