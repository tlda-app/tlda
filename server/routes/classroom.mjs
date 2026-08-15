import { Router } from 'express'
import { ClassroomStore } from '../lib/classroom-store.mjs'
import { extractToken, validateToken } from '../lib/auth.mjs'
import { readdir, readFile, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { createProject, readProject, sourceDir, sourceLifecycleStore, updateProject, writeSourceFileAsync } from '../lib/project-store.mjs'
import { projectRevisionStatus } from '../lib/source-lifecycle.mjs'
import { checkoutSource, currentVersion } from '../lib/shadow-repo.mjs'
import { dispatchBuild } from '../lib/build-dispatch.mjs'
import { inspectSubmissionArchive } from '../lib/classroom-submission.mjs'
import crypto from 'node:crypto'

// Everything the student uploaded, in the shape they uploaded it. Deliberately
// not listSourceFiles, which filters by client-source ownership rules — an
// export that quietly omitted a file would defeat its own purpose.
async function walkSubmissionFiles(dir, base = dir) {
  const found = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return found  // a submission recorded but never materialised — the index still lists it
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...await walkSubmissionFiles(full, base))
    else found.push(relative(base, full))
  }
  return found
}

function studentToken(req) {
  return req.headers['x-tlda-student-token'] || null
}

export function classroomPrincipal(req, store) {
  const level = validateToken(extractToken(req))
  if (level === 'rw') return { role: 'instructor' }
  if (level !== 'read') return null
  const student = store.studentForToken(studentToken(req))
  return student ? { role: 'student', studentId: student.id, courseId: student.courseId, layerScope: student.layerScope } : null
}

function ownsStudent(principal, studentId) {
  return principal?.role === 'instructor' || (principal?.role === 'student' && principal.studentId === studentId)
}

function canReadStudent(principal, assignmentId, studentId, store) {
  if (ownsStudent(principal, studentId)) return true
  if (principal?.role !== 'student') return false
  const student = store.getStudent(studentId)
  const assignment = store.getAssignment(assignmentId)
  return student?.active === 1
    && student.courseId === principal.courseId
    && assignment?.courseId === principal.courseId
    && student.layerScope === 'common'
}

// Submitting is what unlocks the solution. Skip, 26 June: "once you've submitted
// an assignment the solution becomes accessible to you and you can see it
// side-by-side yours."
//
// Documents are fetched by key, so handing an unsubmitted student
// solutionsDocKey hands them the solutions — the difference between a rule and
// a suggestion is whether the key is in the response at all.
function forStudent(assignment, principal, store) {
  if (principal.role === 'instructor') return assignment
  const submitted = store.getSubmission(assignment.id, principal.studentId)
  if (submitted) return assignment
  const { solutionsDocKey, solutionsVersion, ...withheld } = assignment
  return { ...withheld, solutionsLocked: true }
}

export async function classroomTemplateVersion(templateDocKey) {
  const project = await readProject(templateDocKey)
  if (!project) throw new Error('template document not found')
  const status = projectRevisionStatus((await sourceLifecycleStore(templateDocKey)).listRevisionLifecycles(templateDocKey))
  if (status.status !== 'success') throw new Error('template document build is not ready')
  const version = await currentVersion(templateDocKey)
  if (!version?.hash) throw new Error('template document has no source history to freeze against')
  return version.hash
}

/**
 * The template's source at the exact revision that was frozen.
 *
 * The version is a coordinate, not a fingerprint: it names which revision the
 * students started from, so a handout edited after the freeze is still compared
 * against what they were given. Reading current source here would report the
 * instructor's later edit as the student's mistake.
 *
 * This was once a sha256 over hashSourceFiles(), which can detect that the
 * handout moved but cannot say what it was. If you are weighing "detect the
 * change" against "fetch the change" again, the project already answered it:
 * AGENTS.md puts `eiv-paper@0b77278` beside npm's `pkg@1.2.3` and concludes
 * that a version is a coordinate on a thing you already named. A checksum is
 * not that, whatever it is called. Fetch the change.
 */
export async function classroomTemplateSource(templateDocKey, templateVersion) {
  const project = await readProject(templateDocKey)
  if (!project?.mainFile) return null
  const checkout = await checkoutSource(templateDocKey, templateVersion)
  try {
    return await readFile(join(checkout, project.mainFile), 'utf8')
  } finally {
    await rm(checkout, { recursive: true, force: true })
  }
}

/**
 * The handout this assignment's students started from, or null.
 *
 * Only the frozen template counts: the archive check compares against it to tell
 * an answer typed under the box from the document's own narrative, and comparing
 * against a handout that has been edited since would report the edit as the
 * student's mistake. An assignment with no frozen template simply does not get
 * that check — see `strayAnswers`, which makes no claim without one.
 */
async function frozenTemplateSource(store, assignmentId, resolveTemplateSource) {
  const assignment = store.getAssignment(assignmentId)
  if (!assignment?.templateDocKey || !assignment.templateVersion) return null
  try {
    return await resolveTemplateSource(assignment.templateDocKey, assignment.templateVersion)
  } catch (error) {
    // A template that cannot be read must not block a hand-in. The check is
    // skipped and the reason reaches the log rather than the student.
    console.error(`[classroom] could not read template for ${assignmentId}:`, error)
    return null
  }
}

export function createClassroomRouter({ store = new ClassroomStore(), resolvePrincipal = classroomPrincipal, resolveRegistrationAccess = req => ['read', 'rw'].includes(validateToken(extractToken(req))), resolveTemplateVersion = classroomTemplateVersion, resolveTemplateSource = classroomTemplateSource, dispatchSubmissionBuild = dispatchBuild } = {}) {
  const router = Router()
  router.post('/courses/:courseId/register', (req, res) => {
    if (!resolveRegistrationAccess(req)) return res.status(401).json({ error: 'Unauthorized' })
    const displayName = String(req.body?.displayName || '').trim()
    const universityLogin = String(req.body?.universityLogin || '').trim().toLowerCase()
    if (!displayName || !universityLogin) return res.status(400).json({ error: 'displayName and universityLogin are required' })
    if (!/^[a-z0-9._-]+$/.test(universityLogin)) return res.status(400).json({ error: 'universityLogin contains unsupported characters' })
    if (!store.getCourse(req.params.courseId)) return res.status(404).json({ error: 'Course not found' })
    const enrollmentToken = crypto.randomBytes(32).toString('hex')
    try {
      const student = store.registerStudent({ courseId: req.params.courseId, displayName, universityLogin, enrollmentToken })
      return res.status(201).json({ student, enrollmentToken })
    } catch (error) {
      if (String(error?.code || '').startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ error: 'That university login is already registered for this course' })
      throw error
    }
  })
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
    const { id, displayName, enrollmentToken, active, layerScope } = req.body || {}
    if (!id || !displayName || !enrollmentToken) return res.status(400).json({ error: 'id, displayName, and enrollmentToken are required' })
    try {
      res.status(201).json(store.upsertStudent({ id, courseId: req.params.courseId, displayName, enrollmentToken, active, layerScope }))
    } catch (error) {
      if (error.message.startsWith('invalid student layer scope:')) return res.status(400).json({ error: error.message })
      throw error
    }
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
      ...forStudent(assignment, p, store),
      submission: store.getSubmission(assignment.id, p.studentId),
    })) })
  })

  router.get('/courses/:courseId/status', instructor, (req, res) => res.json(store.status(req.params.courseId)))

  // The safety net: everything students submitted, plus whatever has been said
  // back to them, as one archive that opens without tlda. It exists so the
  // interface can be trusted before anyone has reason to trust it, which means
  // the export must not depend on the app being up, the database being
  // readable, or this code being present later. Plain files and plain text.
  router.get('/courses/:courseId/export', instructor, async (req, res) => {
    const { courseId } = req.params
    const course = store.getCourse(courseId)
    if (!course) return res.status(404).json({ error: 'Course not found' })

    try {
      const students = store.listStudents(courseId)
      const assignments = store.listAssignments(courseId)
      const files = {}
      const index = [`# ${course.title}`, '', `Exported ${new Date().toISOString()}.`, '',
        'Every folder below is one student\'s submitted work for one assignment,',
        'exactly as they uploaded it. `feedback.md` is what was written back to',
        'them. Nothing here needs tlda to read.', '']

      for (const assignment of assignments) {
        index.push(`## ${assignment.title} (${assignment.id}) — due ${assignment.dueAt}`, '')
        for (const student of students) {
          const submission = store.getSubmission(assignment.id, student.id, { includeDrafts: true })
          if (!submission) {
            index.push(`- ${student.displayName} (${student.id}) — **not submitted**`)
            continue
          }
          index.push(`- ${student.displayName} (${student.id}) — ${submission.gradingStatus}, submitted ${submission.submittedAt}`)

          const root = `${assignment.id}/${student.id}`
          const dir = sourceDir(submission.contentRef)
          for (const relativePath of await walkSubmissionFiles(dir)) {
            files[`${root}/${relativePath}`] = new Uint8Array(await readFile(join(dir, relativePath)))
          }
          if (submission.feedback.length) {
            const notes = submission.feedback.map(mark =>
              `## ${mark.title}\n\n_${mark.visibility === 'returned' ? 'Returned to the student' : 'Draft, not yet returned'}_\n\n${mark.text}\n`)
            files[`${root}/feedback.md`] = strToU8(`# Feedback for ${student.displayName} — ${assignment.title}\n\n${notes.join('\n')}`)
          }
        }
        index.push('')
      }

      files['README.md'] = strToU8(index.join('\n'))
      const archive = Buffer.from(zipSync(files))
      res.setHeader('Content-Type', 'application/zip')
      res.setHeader('Content-Disposition', `attachment; filename="${courseId}-submissions.zip"`)
      res.setHeader('Content-Length', archive.length)
      res.end(archive)
    } catch (error) {
      console.error(`[classroom] export failed for ${courseId}:`, error)
      res.status(500).json({ error: `The export could not be built: ${error.message}` })
    }
  })

  // The assignment as he marks it: each problem, and every student's answer to
  // that problem, so he can hold one exercise still and flick through the class.
  router.get('/assignments/:assignmentId/problems', instructor, (req, res) => {
    const view = store.problems(req.params.assignmentId)
    if (!view) return res.status(404).json({ error: 'Assignment not found' })
    res.json(view)
  })

  router.get('/assignments/:assignmentId', (req, res) => {
    const assignment = store.getAssignment(req.params.assignmentId)
    if (!assignment) return res.status(404).json({ error: 'Assignment not found' })
    const p = req.classroomPrincipal
    if (p.role === 'student' && p.courseId !== assignment.courseId) return res.status(403).json({ error: 'Forbidden' })
    res.json(forStudent(assignment, p, store))
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

  // A student asking for their own work, without naming themselves. Their id
  // comes from their token, so there is no path here that can be pointed at
  // somebody else's submission by editing a URL.
  router.get('/assignments/:assignmentId/mine', (req, res) => {
    const p = req.classroomPrincipal
    if (p.role !== 'student') return res.status(400).json({ error: 'Only a student has a submission of their own' })
    const row = store.getSubmission(req.params.assignmentId, p.studentId)
    if (!row) return res.status(404).json({ error: 'Not submitted yet' })
    res.json(row)
  })

  router.get('/assignments/:assignmentId/submissions/:studentId', (req, res) => {
    const { assignmentId, studentId } = req.params
    if (!canReadStudent(req.classroomPrincipal, assignmentId, studentId, store)) return res.status(403).json({ error: 'Forbidden' })
    const row = store.getSubmission(assignmentId, studentId, { includeDrafts: req.classroomPrincipal.role === 'instructor' })
    if (!row) return res.status(404).json({ error: 'Submission not found' })
    res.json(row)
  })

  // A submission arrives as an archive, not a file: an answer done on paper is
  // photographed and included with ordinary markdown image syntax, so the .qmd
  // cannot travel alone.
  //
  // Accepting one means materialising it as a qmd project, because that is what
  // renders the work to HTML pages — which is what the side-by-side marking view
  // already reads. So `contentRef` stays a document key and nothing downstream
  // has to learn a new shape.
  const receiveSubmissionArchive = (req, res, assignmentId, studentId) => {
    if (!ownsStudent(req.classroomPrincipal, studentId)) return res.status(403).json({ error: 'Forbidden' })
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

      const inspection = inspectSubmissionArchive(archive, { template: await frozenTemplateSource(store, assignmentId, resolveTemplateSource) })
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
        const submission = store.submit({ assignmentId, studentId, contentRef, answerIds: inspection.answerIds })
        settled = true
        // The record is written before the render is asked for: a build that
        // fails leaves the work stored and re-renderable, where waiting on the
        // build would lose it.
        res.json({ ...submission, qmdPath: inspection.qmdPath, answerIds: inspection.answerIds })
        dispatchSubmissionBuild(contentRef).catch(async error => {
          console.error(`[classroom] render failed for ${contentRef}:`, error)
          try {
            await updateProject(contentRef, { buildStatus: 'error' })
          } catch (updateError) {
            // The submission response has already been sent; retain the original render failure in the server log.
            console.error(`[classroom] failed to record render error for ${contentRef}:`, updateError)
          }
        })
      } catch (error) {
        console.error(`[classroom] could not store submission ${contentRef}:`, error)
        fail(500, { error: 'The submission could not be stored. Nothing was recorded — please try again.' })
      }
    })
  }

  // A student never supplies their own id. The enrollment token is the
  // identity, and the assignment page is the assignment.
  router.post('/assignments/:assignmentId/mine/upload', (req, res) => {
    const p = req.classroomPrincipal
    if (p.role !== 'student') return res.status(400).json({ error: 'Only a student can upload work of their own' })
    return receiveSubmissionArchive(req, res, req.params.assignmentId, p.studentId)
  })

  router.post('/assignments/:assignmentId/submissions/:studentId/upload', (req, res) => {
    return receiveSubmissionArchive(req, res, req.params.assignmentId, req.params.studentId)
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
