import { Router } from 'express'
import { ClassroomStore } from '../lib/classroom-store.mjs'
import { configuredReadToken, extractToken, validateToken } from '../lib/auth.mjs'
import { readdir, readFile, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { createProject, readProject, replaceSourceFilesAsync, sourceDir, sourceLifecycleStore } from '../lib/project-store.mjs'
import { projectRevisionStatus } from '../lib/source-lifecycle.mjs'
import { checkoutSource, currentVersion } from '../lib/shadow-repo.mjs'
import { inspectSubmissionArchive } from '../lib/classroom-submission.mjs'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const QRCode = require('qrcode-terminal/vendor/QRCode')
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel')
const DEVICE_TRANSFER_TTL_MS = 10 * 60 * 1000
// A repair link is read out of an email rather than off the screen of the device
// that made it, so it has to survive the gap between the instructor sending it and
// the student getting to it. Still single-use, and still a credential for one
// student, which is what bounds it — the expiry is not the thing keeping it safe.
const REPAIR_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000

function xmlText(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character])
}

function courseInitials(course) {
  const words = String(course.title || course.id).trim().split(/\s+/).filter(Boolean)
  return (words.length > 1 ? `${words[0][0]}${words.at(-1)[0]}` : words[0]?.slice(0, 2) || 'TL').toUpperCase()
}

export function classroomWebManifest({ course, project, readToken }) {
  const start = new URL('/', 'http://tlda.invalid')
  start.searchParams.set('project', project)
  start.searchParams.set('course', course.id)
  start.searchParams.set('token', readToken)
  return {
    id: `/?course=${encodeURIComponent(course.id)}`,
    name: course.title,
    short_name: course.id,
    description: `${course.title} in tlda`,
    start_url: `${start.pathname}${start.search}`,
    scope: '/',
    display: 'standalone',
    background_color: '#f7f7f4',
    theme_color: '#f7f7f4',
    icons: [{ src: '/tlda-mark.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
  }
}

export function classroomIconSvg(course) {
  const label = xmlText(courseInitials(course))
  const title = xmlText(course.title)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192" role="img" aria-labelledby="title"><title id="title">${title}</title><rect width="192" height="192" rx="38" fill="#f7f7f4"/><path d="M44 48h104v96H44z" fill="#fff" stroke="#262626" stroke-width="8"/><text x="96" y="111" text-anchor="middle" font-family="system-ui,sans-serif" font-size="42" font-weight="700" fill="#262626">${label}</text></svg>`
}

export function classroomTransferQrSvg(value) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.M)
  qr.addData(value)
  qr.make()
  const quiet = 4
  const size = qr.getModuleCount() + quiet * 2
  const modules = []
  for (let row = 0; row < qr.getModuleCount(); row++) {
    for (let col = 0; col < qr.getModuleCount(); col++) {
      if (qr.isDark(row, col)) modules.push(`M${col + quiet} ${row + quiet}h1v1h-1z`)
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><path fill="#fff" d="M0 0h${size}v${size}H0z"/><path fill="#000" d="${modules.join('')}"/></svg>`
}

/**
 * The URL a transfer code is redeemed at.
 *
 * `returnPath`, `project` and `accessToken` are arguments rather than things read
 * off the request, because the two callers differ on all three. A student adding
 * a device is making a link for themselves: their page is where they want to
 * land, it already names the project, and the credential they hold is the class
 * read token. An instructor is making a link for somebody else: the gradebook
 * they are standing on is not the student's destination, it names no project, and
 * the token they hold is RW.
 *
 * `project` matters because without it the app never calls `loadDocument` and
 * shows the manifest picker instead — a repaired student would arrive at a list
 * of documents rather than in their class.
 */
function deviceTransferUrl(req, courseId, transferCode, { returnPath = '', project = null, accessToken = null } = {}) {
  const protocol = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim()
  const origin = `${protocol}://${req.get('host')}`
  const requested = String(returnPath || '').startsWith('/') ? new URL(returnPath, origin) : null
  const url = requested?.origin === origin ? requested : new URL('/', origin)
  url.searchParams.delete('classroomToken')
  url.searchParams.delete('name')
  url.searchParams.delete('pwtab')
  url.searchParams.delete('pw')
  url.searchParams.set('workspace', 'classroom-transfer')
  url.searchParams.set('course', courseId)
  url.searchParams.set('transfer', transferCode)
  if (project) url.searchParams.set('project', project)
  if (accessToken) url.searchParams.set('token', accessToken)
  return url.toString()
}

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

/**
 * The enrolment token a request carries.
 *
 * The classroom API sends it as a header. A document fetch cannot always: the
 * sync path already reads `classroomToken` off the URL because a browser
 * WebSocket cannot set headers, and the same token on the same page URL is what
 * lets a student reach their own submission through `/docs`. Same value, same
 * source, two carriers.
 */
function studentToken(req) {
  return req.headers['x-tlda-student-token'] || req.query?.classroomToken || null
}

export function classroomPrincipal(req, store, level = validateToken(extractToken(req))) {
  if (level === 'rw') return { role: 'instructor' }
  const student = store.studentForToken(studentToken(req))
  return student ? { role: 'student', studentId: student.id, courseId: student.courseId, displayName: student.displayName, preferredName: student.preferredName, pronouns: student.pronouns, layerScope: student.layerScope } : null
}

export function requireClassroomDocumentAccess(req, res, next) {
  const store = req.app?.locals?.classroomStore
  if (!store || !req.params?.name) return next()
  const resolvePrincipal = req.app?.locals?.resolveClassroomPrincipal || classroomPrincipal
  const access = store.documentAccess(req.params.name, resolvePrincipal(req, store))
  if (!access.restricted || access.allowed) return next()
  // One refusal, one shape; the message names which of the two it is, because
  // the next action differs — hand something in, or ask the student whose work
  // this is.
  return res.status(403).json({ error: access.submission
    ? 'A submitted assignment is readable by the student who handed it in and by an instructor'
    : 'Classroom solution access requires instructor access or a submitted assignment' })
}

function ownsStudent(principal, studentId) {
  return principal?.role === 'instructor' || (principal?.role === 'student' && principal.studentId === studentId)
}

// The rule itself is `store.mayReadStudentWork`, because the document, the
// index, the history and the sync room ask the same question and a second copy
// of it here would drift from theirs. This adds only what is local to a row:
// the assignment has to exist and be in the caller's course.
function canReadStudent(principal, assignmentId, studentId, store) {
  // Kept ahead of the lookup: an instructor asking about an assignment that does
  // not exist got a 404 from the handler, and turning that into a 403 would be a
  // change nobody asked for.
  if (ownsStudent(principal, studentId)) return true
  const assignment = store.getAssignment(assignmentId)
  if (!assignment) return false
  return store.mayReadStudentWork(principal, { studentId, courseId: assignment.courseId })
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

async function submissionBuild(contentRef) {
  const project = await readProject(contentRef)
  if (!project) return { buildStatus: 'missing', buildAt: null }
  const lifecycle = projectRevisionStatus((await sourceLifecycleStore(contentRef, { existingProject: project })).listRevisionLifecycles(contentRef))
  return { buildStatus: lifecycle.status, buildAt: project.lastBuildSuccess || project.lastBuild || null }
}

export function createClassroomRouter({ store = new ClassroomStore(), resolvePrincipal = classroomPrincipal, resolveRegistrationAccess = req => ['read', 'rw'].includes(validateToken(extractToken(req))), resolveManifestAccess = req => validateToken(extractToken(req)) === 'read', resolveLinkAccessToken = configuredReadToken, resolveTemplateVersion = classroomTemplateVersion, resolveTemplateSource = classroomTemplateSource, submitSubmissionSource = null, resolveSubmissionBuild = submissionBuild } = {}) {
  const router = Router()
  router.get('/courses/:courseId/manifest.webmanifest', (req, res) => {
    if (!resolveManifestAccess(req)) return res.status(401).json({ error: 'Unauthorized' })
    const course = store.getCourse(req.params.courseId)
    if (!course) return res.status(404).json({ error: 'Course not found' })
    const project = String(req.query.project || '').trim()
    if (!project) return res.status(400).json({ error: 'project is required' })
    const readToken = extractToken(req)
    res.set('Cache-Control', 'private, no-store')
    res.type('application/manifest+json').send(classroomWebManifest({ course, project, readToken }))
  })
  router.get('/courses/:courseId/icon.svg', (req, res) => {
    if (!resolveManifestAccess(req)) return res.status(401).json({ error: 'Unauthorized' })
    const course = store.getCourse(req.params.courseId)
    if (!course) return res.status(404).json({ error: 'Course not found' })
    res.set('Cache-Control', 'private, no-store')
    res.type('image/svg+xml').send(classroomIconSvg(course))
  })
  router.post('/courses/:courseId/register', (req, res) => {
    if (!resolveRegistrationAccess(req)) return res.status(401).json({ error: 'Unauthorized' })
    const preferredName = String(req.body?.preferredName || '').trim()
    const pronouns = String(req.body?.pronouns || '').trim()
    const universityLogin = String(req.body?.universityLogin || '').trim().toLowerCase()
    if (!preferredName || !universityLogin) return res.status(400).json({ error: 'preferredName and universityLogin are required' })
    if (!/^[a-z0-9._-]+$/.test(universityLogin)) return res.status(400).json({ error: 'universityLogin contains unsupported characters' })
    if (!store.getCourse(req.params.courseId)) return res.status(404).json({ error: 'Course not found' })
    const enrollmentToken = crypto.randomBytes(32).toString('hex')
    try {
      const student = store.registerStudent({ courseId: req.params.courseId, preferredName, pronouns, universityLogin, enrollmentToken })
      return res.status(201).json({ student, enrollmentToken })
    } catch (error) {
      if (String(error?.code || '').startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ error: 'That university login is already registered for this course' })
      throw error
    }
  })
  router.post('/courses/:courseId/device-transfer/redeem', (req, res) => {
    if (!resolveRegistrationAccess(req)) return res.status(401).json({ error: 'Unauthorized' })
    const transferCode = String(req.body?.transferCode || '')
    if (!transferCode) return res.status(400).json({ error: 'transferCode is required' })
    const enrollmentToken = crypto.randomBytes(32).toString('hex')
    const result = store.redeemDeviceTransfer({ courseId: req.params.courseId, transferCode, enrollmentToken })
    if (result.status === 'invalid') return res.status(404).json({ error: 'Transfer link is invalid for this class' })
    if (result.status === 'expired') return res.status(410).json({ error: 'Transfer link has expired' })
    if (result.status === 'used') return res.status(409).json({ error: 'Transfer link has already been used' })
    return res.json({ student: result.student, enrollmentToken })
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

  router.post('/courses/:courseId/device-transfer', (req, res) => {
    const principal = req.classroomPrincipal
    if (principal.role !== 'student') return res.status(403).json({ error: 'Student access required' })
    if (principal.courseId !== req.params.courseId) return res.status(403).json({ error: 'Forbidden' })
    const createdAt = new Date().toISOString()
    const expiresAt = new Date(Date.parse(createdAt) + DEVICE_TRANSFER_TTL_MS).toISOString()
    const transferCode = crypto.randomBytes(32).toString('base64url')
    store.createDeviceTransfer({
      studentId: principal.studentId,
      courseId: principal.courseId,
      transferCode,
      createdAt,
      expiresAt,
    })
    const transferUrl = deviceTransferUrl(req, principal.courseId, transferCode, {
      returnPath: req.body?.returnPath,
      accessToken: extractToken(req),
    })
    res.status(201).json({ transferUrl, qrSvg: classroomTransferQrSvg(transferUrl), expiresAt })
  })

  /**
   * A repair link: the same device transfer, minted by the instructor.
   *
   * The enrolment token is stored hashed and printed once, at registration. A
   * student who never connected Positron, or who is working from an address the
   * class link has never reached, has no way back: the API that issues a transfer
   * is the one that needs the token they are missing. Nobody can recite it to
   * them — the instructor holds the hash too.
   *
   * So the instructor mints it instead, and the student's own row is what it is
   * minted against. It resolves to the same student id, so their submissions,
   * their marks and their layer are the ones they land in; nothing is created.
   *
   * It carries the class read token, never `extractToken(req)`: this URL is
   * written into an email, and the caller authorised to make one holds RW.
   *
   * `project` is where the student lands once redeemed, and it has to be said
   * because the instructor's page does not say it. Without one the app shows the
   * manifest picker rather than opening the class. The caller supplies it — the
   * store records no project for a course, and inventing a column to hold one
   * would be a schema decision this repair does not need.
   */
  router.post('/courses/:courseId/students/:studentId/repair-link', instructor, (req, res) => {
    const student = store.getStudent(req.params.studentId)
    if (!student || student.courseId !== req.params.courseId || !student.active) {
      return res.status(404).json({ error: 'Student not found in this course' })
    }
    const project = String(req.body?.project || '').trim()
    // Same rule the project routes enforce on creation, so a repair link cannot
    // name something that could never have been a project.
    if (project && !/^[a-z0-9][a-z0-9-]*$/.test(project)) {
      return res.status(400).json({ error: 'project is not a valid project name' })
    }
    const createdAt = new Date().toISOString()
    const expiresAt = new Date(Date.parse(createdAt) + REPAIR_LINK_TTL_MS).toISOString()
    const transferCode = crypto.randomBytes(32).toString('base64url')
    store.createDeviceTransfer({ studentId: student.id, courseId: student.courseId, transferCode, createdAt, expiresAt })
    const repairUrl = deviceTransferUrl(req, student.courseId, transferCode, { project: project || null, accessToken: resolveLinkAccessToken() })
    res.status(201).json({ student, repairUrl, qrSvg: classroomTransferQrSvg(repairUrl), expiresAt })
  })

  router.post('/courses', instructor, (req, res) => {
    const { id, title, preferredName, pronouns } = req.body || {}
    if (!id || !title || !String(preferredName || '').trim()) return res.status(400).json({ error: 'id, title, and preferredName are required' })
    res.status(201).json(store.upsertCourse({ id, title, preferredName: String(preferredName).trim(), pronouns }))
  })

  router.post('/courses/:courseId/students', instructor, (req, res) => {
    const { id, displayName, preferredName, pronouns, enrollmentToken, active, layerScope } = req.body || {}
    if (!id || !(preferredName || displayName) || !enrollmentToken) return res.status(400).json({ error: 'id, preferredName, and enrollmentToken are required' })
    try {
      res.status(201).json(store.upsertStudent({ id, courseId: req.params.courseId, displayName, preferredName, pronouns, enrollmentToken, active, layerScope }))
    } catch (error) {
      if (error.message.startsWith('invalid student layer scope:')) return res.status(400).json({ error: error.message })
      throw error
    }
  })

  router.post('/courses/:courseId/assignments', instructor, (req, res) => {
    const { id, title, dueAt, solutionsDocKey, solutionsVersion, sourceDocKey, handoutFilter, solutionFilter, bookPageFile } = req.body || {}
    if (!id || !title || !dueAt) return res.status(400).json({ error: 'id, title, and dueAt are required' })
    if (bookPageFile && (String(bookPageFile).startsWith('/') || String(bookPageFile).split('/').includes('..') || !String(bookPageFile).endsWith('.html'))) {
      return res.status(400).json({ error: 'bookPageFile must be a relative HTML path' })
    }
    res.status(201).json(store.upsertAssignment({ id, courseId: req.params.courseId, title, dueAt, solutionsDocKey, solutionsVersion, sourceDocKey, handoutFilter, solutionFilter, bookPageFile }))
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

  // One page, one asymmetry: the instructor gets the whole class, a student gets
  // the same shape holding only their own row. The student id comes from the
  // token and is never read from the path, so this cannot be aimed at anyone
  // else — the narrowing is the principal, not a parameter.
  router.get('/courses/:courseId/status', async (req, res) => {
    const p = req.classroomPrincipal
    if (p.role === 'student' && p.courseId !== req.params.courseId) return res.status(403).json({ error: 'Forbidden' })
    const status = store.status(req.params.courseId, p.role === 'student' ? { studentId: p.studentId } : {})
    const builds = new Map()
    for (const row of status.rows) {
      for (const cell of row.assignments) {
        if (!cell.contentRef) continue
        if (!builds.has(cell.contentRef)) builds.set(cell.contentRef, await resolveSubmissionBuild(cell.contentRef))
        Object.assign(cell, builds.get(cell.contentRef))
      }
    }
    // The page needs to know which side of the asymmetry it is rendering, and
    // the endpoint already knows. Carrying it here saves the client asking a
    // second question about a request it has already made.
    res.json({ ...status, viewer: { role: p.role } })
  })

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

  // Who the caller is, by their token alone.
  //
  // The book surface needs this: a student reading the book has no assignment
  // in hand, but their annotations go to a room named for them, so the page has
  // to know who they are before it can open one. Same rule as `/mine` above —
  // the id comes from the token and the request cannot name anyone else.
  //
  // An instructor gets `role: 'instructor'` and no student id; they choose whose
  // overlay to read, and that choice is checked where it is made.
  // The name comes back with the id because the classroom surface says who is
  // reading it — the registered name, not the tlda identity the page would
  // otherwise show. It is the caller's own name, from the caller's own token.
  router.get('/me', (req, res) => {
    const p = req.classroomPrincipal
    if (p.role === 'student') return res.json({ role: 'student', studentId: p.studentId, courseId: p.courseId, displayName: p.displayName, preferredName: p.preferredName || p.displayName, pronouns: p.pronouns || null })
    const courseId = String(req.query?.course || '')
    if (!courseId) return res.status(400).json({ error: 'course is required' })
    const course = store.getCourse(courseId)
    if (!course) return res.status(404).json({ error: 'Course not found' })
    if (!course?.preferred_name) return res.status(409).json({ error: 'Course instructor preferred name is not configured' })
    res.json({ role: 'instructor', courseId, preferredName: course.preferred_name, pronouns: course.pronouns || null })
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
        if (typeof submitSubmissionSource !== 'function') throw new Error('source-room daemon snapshot submission is not configured')
        const files = Object.entries(inspection.entries)
          .filter(([entryPath]) => !entryPath.endsWith('/'))
          .map(([entryPath, bytes]) => ({ path: entryPath, content: Buffer.from(bytes).toString('base64'), encoding: 'base64' }))
        const accepted = await submitSubmissionSource(contentRef, {
          files,
          sourceManifest: files.map(file => file.path).sort(),
        })
        if (!accepted?.body?.ok) throw new Error(accepted?.body?.error || accepted?.body?.status || 'source snapshot was not accepted')
        // AND MATERIALISE IT, because the room's git tree is not what anything
        // downstream reads. `sourceDir(contentRef)` is: the build runner takes
        // it as `srcDir`, the marking view reads what that render produced, and
        // the instructor export walks it directly.
        //
        // This is not a second authority over the bytes. The room submit above
        // is what makes them a revision; this is the working tree that revision
        // is materialised into, which every ordinary project has for the same
        // reason.
        //
        // It was here until `83cd0b0d6` swapped source materialisation for the
        // room submit and did not put it back. Measured on a fixture after that:
        // the settle commits within five seconds and `source/` is still empty a
        // minute later, so a submission that uploaded 200 and read back fine
        // exported as nothing but a README — no qmd, no photo.
        // Replace the working tree with the accepted snapshot. Writing its
        // members over the previous tree leaves omitted files from an earlier
        // submission behind, so a removed photo would still be exported.
        await replaceSourceFilesAsync(contentRef, files.map(file => ({
          path: file.path,
          content: Buffer.from(file.content, 'base64'),
        })))
        const submission = store.submit({ assignmentId, studentId, contentRef, answerIds: inspection.answerIds })
        settled = true
        // The record is written before the render is asked for: a build that
        // fails leaves the work stored and re-renderable, where waiting on the
        // build would lose it.
        res.json({ ...submission, qmdPath: inspection.qmdPath, answerIds: inspection.answerIds })
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

  const missingSubmission = error => /submission not found/i.test(error?.message || '')

  router.post('/assignments/:assignmentId/submissions/:studentId/grade', instructor, (req, res) => {
    try {
      res.json(store.setStatus(req.params.assignmentId, req.params.studentId, 'graded'))
    } catch (error) {
      if (!missingSubmission(error)) throw error
      res.status(404).json({ error: 'Submission not found' })
    }
  })

  router.post('/assignments/:assignmentId/submissions/:studentId/return', instructor, (req, res) => {
    try {
      res.json(store.returnFeedback(req.params.assignmentId, req.params.studentId))
    } catch (error) {
      if (!missingSubmission(error)) throw error
      res.status(404).json({ error: 'Submission not found' })
    }
  })

  return router
}
