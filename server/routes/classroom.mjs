import { Router } from 'express'
import crypto from 'node:crypto'
import { ClassroomStore } from '../lib/classroom-store.mjs'
import { extractToken, validateToken } from '../lib/auth.mjs'
import { createProject, hashSourceFiles, readProject, writeSourceFileAsync } from '../lib/project-store.mjs'
import { dispatchBuild } from '../lib/build-dispatch.mjs'
import { inspectSubmissionArchive } from '../lib/classroom-submission.mjs'

function studentToken(req) {
  return req.headers['x-tlda-student-token'] || null
}

export function classroomPrincipal(req, store) {
  const level = validateToken(extractToken(req))
  if (level === 'rw') return { role: 'instructor' }
  if (level !== 'read') return null
  const student = store.studentForToken(studentToken(req))
  return student ? { role: 'student', studentId: student.id, courseId: student.courseId } : null
}

function allowedStudent(principal, studentId) {
  return principal?.role === 'instructor' || (principal?.role === 'student' && principal.studentId === studentId)
}

export async function classroomTemplateVersion(templateDocKey) {
  const project = await readProject(templateDocKey)
  if (!project) throw new Error('template document not found')
  if (project.buildStatus !== 'success') throw new Error('template document build is not ready')
  const hashes = Object.entries(await hashSourceFiles(templateDocKey)).sort(([left], [right]) => left.localeCompare(right))
  return crypto.createHash('sha256').update(JSON.stringify(hashes)).digest('hex')
}

export function createClassroomRouter({ store = new ClassroomStore(), resolvePrincipal = classroomPrincipal, resolveTemplateVersion = classroomTemplateVersion } = {}) {
  const router = Router()
  router.use((req, res, next) => {
    const principal = resolvePrincipal(req, store)
    if (!principal) return res.status(401).json({ error: 'Unauthorized' })
    req.classroomPrincipal = principal
    next()
  })

  const instructor = (req, res, next) => req.classroomPrincipal.role === 'instructor'
    ? next()
    : res.status(403).json({ error: 'Instructor access required' })

  router.post('/courses', instructor, (req, res) => {
    const { id, title } = req.body || {}
    if (!id || !title) return res.status(400).json({ error: 'id and title are required' })
    res.status(201).json(store.upsertCourse({ id, title }))
  })

  router.post('/courses/:courseId/students', instructor, (req, res) => {
    const { id, displayName, enrollmentToken, active } = req.body || {}
    if (!id || !displayName || !enrollmentToken) return res.status(400).json({ error: 'id, displayName, and enrollmentToken are required' })
    res.status(201).json(store.upsertStudent({ id, courseId: req.params.courseId, displayName, enrollmentToken, active }))
  })

  router.post('/courses/:courseId/assignments', instructor, (req, res) => {
    const { id, title, dueAt, solutionsDocKey, solutionsVersion } = req.body || {}
    if (!id || !title || !dueAt) return res.status(400).json({ error: 'id, title, and dueAt are required' })
    res.status(201).json(store.upsertAssignment({ id, courseId: req.params.courseId, title, dueAt, solutionsDocKey, solutionsVersion }))
  })

  router.get('/courses/:courseId/assignments', (req, res) => {
    const p = req.classroomPrincipal
    if (p.role === 'student' && p.courseId !== req.params.courseId) return res.status(403).json({ error: 'Forbidden' })
    const assignments = store.listAssignments(req.params.courseId)
    if (p.role === 'instructor') return res.json({ assignments })
    res.json({ assignments: assignments.map(assignment => ({
      ...assignment,
      submission: store.getSubmission(assignment.id, p.studentId),
    })) })
  })

  router.get('/courses/:courseId/status', instructor, (req, res) => res.json(store.status(req.params.courseId)))

  router.get('/assignments/:assignmentId', (req, res) => {
    const assignment = store.getAssignment(req.params.assignmentId)
    if (!assignment) return res.status(404).json({ error: 'Assignment not found' })
    const p = req.classroomPrincipal
    if (p.role === 'student' && p.courseId !== assignment.courseId) return res.status(403).json({ error: 'Forbidden' })
    res.json(assignment)
  })

  router.put('/assignments/:assignmentId/template', instructor, async (req, res) => {
    const { templateDocKey } = req.body || {}
    if (!templateDocKey) return res.status(400).json({ error: 'templateDocKey is required' })
    try {
      const templateVersion = await resolveTemplateVersion(templateDocKey)
      res.json(store.freezeTemplate(req.params.assignmentId, { templateDocKey, templateVersion }))
    } catch (error) {
      const status = error.message.includes('not found') ? 404 : 409
      res.status(status).json({ error: error.message })
    }
  })

  router.get('/assignments/:assignmentId/submissions/:studentId', (req, res) => {
    const { assignmentId, studentId } = req.params
    if (!allowedStudent(req.classroomPrincipal, studentId)) return res.status(403).json({ error: 'Forbidden' })
    const row = store.getSubmission(assignmentId, studentId, { includeDrafts: req.classroomPrincipal.role === 'instructor' })
    if (!row) return res.status(404).json({ error: 'Submission not found' })
    res.json(row)
  })

  router.post('/assignments/:assignmentId/submit', (req, res) => {
    const p = req.classroomPrincipal
    const studentId = p.role === 'student' ? p.studentId : req.body?.studentId
    if (!studentId || !allowedStudent(p, studentId)) return res.status(403).json({ error: 'Forbidden' })
    const contentRef = String(req.body?.contentRef || '').trim()
    if (!contentRef) return res.status(400).json({ error: 'contentRef is required' })
    res.json(store.submit({ assignmentId: req.params.assignmentId, studentId, contentRef }))
  })

  // A submission arrives as an archive, not a file: an answer done on paper is
  // photographed and included with ordinary markdown image syntax, so the .qmd
  // cannot travel alone.
  //
  // Accepting one means materialising it as a qmd project, because that is what
  // renders the work to HTML pages — which is what the side-by-side marking view
  // already reads. So `contentRef` stays a document key and nothing downstream
  // has to learn a new shape.
  router.post('/assignments/:assignmentId/submissions/:studentId/upload', (req, res) => {
    const { assignmentId, studentId } = req.params
    if (!allowedStudent(req.classroomPrincipal, studentId)) return res.status(403).json({ error: 'Forbidden' })
    if (!store.getAssignment(assignmentId)) return res.status(404).json({ error: 'Assignment not found' })

    const chunks = []
    let settled = false
    const fail = (code, body) => {
      if (settled) return
      settled = true
      res.status(code).json(body)
    }
    // A disconnect mid-upload must never be recorded as a submission. Telling a
    // student their work arrived when only half of it did is the exact failure
    // this whole path exists to prevent, so nothing is stored until the bytes
    // are complete and the archive has been read.
    req.on('aborted', () => fail(400, { error: 'The upload stopped before it finished. Nothing was recorded — please upload again.' }))
    req.on('error', error => fail(400, { error: `The upload failed in transit: ${error.message}. Nothing was recorded.` }))
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', async () => {
      if (settled) return
      const archive = Buffer.concat(chunks)
      if (!archive.length) return fail(422, { error: 'The upload was empty — no file bytes arrived.' })

      const inspection = inspectSubmissionArchive(archive)
      if (!inspection.ok) return fail(422, { error: 'This archive cannot be marked yet.', problems: inspection.errors })

      const contentRef = `submission-${assignmentId}-${studentId}`
      try {
        if (!await readProject(contentRef)) {
          createProject({ name: contentRef, title: `${studentId} — ${assignmentId}`, mainFile: inspection.qmdPath, format: 'qmd' })
        }
        for (const [entryPath, bytes] of Object.entries(inspection.entries)) {
          if (entryPath.endsWith('/')) continue
          await writeSourceFileAsync(contentRef, entryPath, Buffer.from(bytes))
        }
        const submission = store.submit({ assignmentId, studentId, contentRef })
        settled = true
        // The record is written before the render is asked for: a build that
        // fails leaves the work stored and re-renderable, where waiting on the
        // build would lose it.
        res.json({ ...submission, qmdPath: inspection.qmdPath, answerIds: inspection.answerIds })
        dispatchBuild(contentRef).catch(error => console.error(`[classroom] render failed for ${contentRef}:`, error))
      } catch (error) {
        console.error(`[classroom] could not store submission ${contentRef}:`, error)
        fail(500, { error: 'The submission could not be stored. Nothing was recorded — please try again.' })
      }
    })
  })

  router.post('/assignments/:assignmentId/submissions/:studentId/feedback', instructor, (req, res) => {
    const { title, text, attached = true } = req.body || {}
    if (!title || !text) return res.status(400).json({ error: 'title and text are required' })
    const id = store.addFeedback({ assignmentId: req.params.assignmentId, studentId: req.params.studentId, title, text, attached })
    res.status(201).json({ id })
  })

  router.post('/assignments/:assignmentId/submissions/:studentId/grade', instructor, (req, res) => {
    res.json(store.setStatus(req.params.assignmentId, req.params.studentId, 'graded'))
  })

  router.post('/assignments/:assignmentId/submissions/:studentId/return', instructor, (req, res) => {
    res.json(store.returnFeedback(req.params.assignmentId, req.params.studentId))
  })

  return router
}

export default createClassroomRouter()
