import { Router } from 'express'
import { ClassroomStore } from '../lib/classroom-store.mjs'
import { extractToken, resolveIdentity } from '../lib/auth.mjs'
import { readdir, readFile, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { createProject, readProject, projectDir, replaceSourceFilesAsync, sourceDir, sourceLifecycleStore } from '../lib/project-store.mjs'
import { projectRevisionStatus } from '../lib/source-lifecycle.mjs'
import { rerunFailedRevision } from '../lib/build-dispatch.mjs'
import { checkoutSource, currentVersion } from '../lib/shadow-repo.mjs'
import { inspectSubmissionArchive } from '../lib/classroom-submission.mjs'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { gradingDraftRoomId, gradingReturnedRoomId } from '../../shared/classroom-rooms.mjs'

/**
 * The stored recording for one layer id, or null. Read off disk here rather
 * than through the projects router so the return verifies the join itself:
 * send's layer id must name a recording belonging to this answer.
 */
function readAnswerRecording(contentRef, layerId) {
  if (!contentRef || !layerId || String(layerId).includes('/') || String(layerId).includes('..')) return null
  try {
    const metaPath = join(projectDir(String(contentRef)), 'recordings', `${layerId}.json`)
    if (!existsSync(metaPath)) return null
    return JSON.parse(readFileSync(metaPath, 'utf8'))
  } catch {
    return null
  }
}

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

export function classroomWebManifest({ course, project }) {
  const start = new URL('/', 'http://tlda.invalid')
  start.searchParams.set('project', project)
  start.searchParams.set('course', course.id)
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
 * `returnPath` and `project` are arguments rather than things read off the
 * request, because the two callers differ on both. A student adding a device is
 * making a link for themselves: their page is where they want to land, and it
 * already names the project. An instructor is making a link for somebody else:
 * the gradebook they are standing on is not the student's destination and names
 * no project. The transfer code is the credential in both cases — no token of
 * any kind is written into the URL, because a link that leaves the browser must
 * never carry a capability.
 *
 * `project` matters because without it the app never calls `loadDocument` and
 * shows the manifest picker instead — a repaired student would arrive at a list
 * of documents rather than in their class.
 */
function deviceTransferUrl(req, courseId, transferCode, { returnPath = '', project = null } = {}) {
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
  const cookie = String(req.headers?.cookie || '')
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith('tlda_classroom_token='))
  const cookieToken = cookie ? decodeURIComponent(cookie.slice('tlda_classroom_token='.length)) : null
  return req.headers['x-tlda-student-token'] || req.query?.classroomToken || cookieToken || null
}

function rememberStudentToken(req, res, token) {
  const secure = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https'
  const flags = `HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure ? '; Secure' : ''}`
  res.append('Set-Cookie', `tlda_classroom_token=${encodeURIComponent(token)}; ${flags}`)
}

/**
 * Who this request is, from classroom identity tokens alone.
 *
 * A token carries identity and nothing else. A student token resolves against
 * the students table, an instructor token against the instructors table, and a
 * bearer token resolves against nothing — it is not consulted here at all. A
 * shared secret has no members, and "grouped to the instructors" presupposes a
 * group with members. Instructor membership is checked where it is used
 * (`store.isInstructorOf`), never here.
 */
export function classroomPrincipal(req, store) {
  const token = studentToken(req)
  const student = store.studentForToken(token)
  if (student) return { role: 'student', studentId: student.id, courseId: student.courseId, displayName: student.displayName, preferredName: student.preferredName, pronouns: student.pronouns, layerScope: student.layerScope }
  const instructor = store.instructorForToken ? store.instructorForToken(token) : null
  if (instructor) return { role: 'instructor', instructorId: instructor.id, courseId: instructor.courseId, displayName: instructor.displayName, preferredName: instructor.preferredName, pronouns: instructor.pronouns }
  return null
}

/**
 * Which carrier the classroom credential arrived on, for refusal logging.
 * Shape only — a refusal that will not say what it resolved is the defect
 * this exists for, and the token itself is never logged.
 */
export function classroomTokenCarrier(req) {
  if (req.headers?.['x-tlda-student-token']) return 'header'
  if (req.query?.classroomToken) return 'query'
  const cookie = String(req.headers?.cookie || '')
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith('tlda_classroom_token='))
  if (cookie) return 'cookie'
  return 'none'
}

/**
 * One line on a refusal: who was turned away from whose work, and what the
 * request resolved to. Role and carrier, never the token — the next
 * disagreement is settled by "a student over the header reached someone
 * else's submission" rather than by re-deriving which credential rode where.
 */
export function logClassroomRefusal(req, principal, docKey) {
  const who = principal?.role === 'student' ? `student:${principal.studentId}`
    : principal?.role === 'instructor' ? `instructor:${principal.instructorId}`
    : 'nobody'
  console.warn(`[classroom] refused "${docKey}" who=${who} carrier=${classroomTokenCarrier(req)} course=${principal?.courseId ?? 'none'}`)
}

/**
 * Give the browser the identity it has just proved, so the document's own
 * subresources can prove it too.
 *
 * A page authenticates with a header. The stylesheets and scripts it links do
 * NOT: the browser fetches those itself and attaches only cookies. So a reader
 * whose identity travels as a header is admitted to the document and refused
 * every asset it references -- measured on `dda5b2c0e`'s successor as 403s on
 * `bootstrap.min.css`, `tippy.css` and `quarto-syntax-highlighting*.css`, which
 * is a chapter arriving unstyled and half-built rather than an error anyone
 * can read. A student never meets this, because their identity IS the cookie.
 *
 * Bounded deliberately. It runs only after the gate above has admitted the
 * caller, only when a principal actually resolved, and only when the identity
 * arrived by some carrier OTHER than the cookie. So it hands back the exact
 * credential the caller supplied and proved -- never one they did not have,
 * and never over the top of a cookie already in place.
 */
function rememberCarrierAsCookie(req, res, principal) {
  if (!principal) return
  const carried = req.headers['x-tlda-student-token'] || req.query?.classroomToken
  if (!carried) return
  if (String(req.headers?.cookie || '').includes('tlda_classroom_token=')) return
  rememberStudentToken(req, res, String(carried))
}

export function requireClassroomDocumentAccess(req, res, next) {
  const store = req.app?.locals?.classroomStore
  if (!store || !req.params?.name) return next()
  const resolvePrincipal = req.app?.locals?.resolveClassroomPrincipal || classroomPrincipal
  const principal = resolvePrincipal(req, store)
  const access = store.documentAccess(req.params.name, principal)
  if (!access.restricted || access.allowed) {
    rememberCarrierAsCookie(req, res, principal)
    return next()
  }
  // One refusal, one shape; the message names which of the two it is, because
  // the next action differs — hand something in, or ask the student whose work
  // this is.
  logClassroomRefusal(req, principal, req.params.name)
  return res.status(403).json({ error: access.submission
    ? 'A submitted assignment is readable by the student who handed it in and by an instructor'
    : 'Classroom solution access requires instructor access or a submitted assignment' })
}

function ownsStudent(principal, studentId, store, courseId = null) {
  if (principal?.role === 'student' && principal.studentId === studentId) return true
  // An instructor of the student's course may act on their row: grading,
  // feedback, rerender, repair. Membership, not the role string alone — the
  // course id comes from the assignment or the path, never from the caller.
  if (principal?.role === 'instructor' && store && courseId) return store.isInstructorOf(principal, courseId)
  return false
}

// The rule itself is `store.mayReadStudentWork`, because the document, the
// index, the history and the sync room ask the same question and a second copy
// of it here would drift from theirs. This adds only what is local to a row:
// the assignment has to exist and be in the caller's course.
function canReadStudent(principal, assignmentId, studentId, store) {
  const assignment = store.getAssignment(assignmentId)
  // Kept ahead of the membership check: an instructor asking about an
  // assignment that does not exist got a 404 from the handler, and turning
  // that into a 403 would be a change nobody asked for.
  if (!assignment) return principal?.role === 'student' && principal.studentId === studentId
  if (ownsStudent(principal, studentId, store, assignment.courseId)) return true
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
  if (store.isInstructorOf(principal, assignment.courseId)) return assignment
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
export async function classroomTemplateSource(templateDocKey, templateVersion, templateFile = null) {
  const project = await readProject(templateDocKey)
  // `templateFile` names the file to read; without one this falls back to the
  // project's mainFile, which is what every assignment frozen before the column
  // existed has. The handout project's mainFile is the rendered HTML, so the
  // file has to be nameable for the template to be the handout QMD.
  const file = templateFile || project?.mainFile
  if (!file) return null
  const checkout = await checkoutSource(templateDocKey, templateVersion)
  try {
    return await readFile(join(checkout, file), 'utf8')
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
    return await resolveTemplateSource(assignment.templateDocKey, assignment.templateVersion, assignment.templateFile)
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

export function createClassroomRouter({ store = new ClassroomStore(), resolvePrincipal = classroomPrincipal, resolveRegistrationAccess = null, resolveManifestAccess = null, resolveLinkAccessToken = null, resolveTemplateVersion = classroomTemplateVersion, resolveTemplateSource = classroomTemplateSource, submitSubmissionSource = null, copyRoomStore = null, resolveSubmissionBuild = submissionBuild, rerunFailedBuild = rerunFailedRevision } = {}) {
  const router = Router()
  // The manifest and icon name a course and a project — neither is student
  // information — so they are open. The bearer check that used to sit here
  // (`resolveManifestAccess`) is gone: holding a class link must never be what
  // admits a reader, and the manifest is what the link IS.
  router.get('/courses/:courseId/manifest.webmanifest', (req, res) => {
    const course = store.getCourse(req.params.courseId)
    if (!course) return res.status(404).json({ error: 'Course not found' })
    const project = String(req.query.project || '').trim()
    if (!project) return res.status(400).json({ error: 'project is required' })
    res.set('Cache-Control', 'private, no-store')
    res.type('application/manifest+json').send(classroomWebManifest({ course, project }))
  })
  router.get('/courses/:courseId/icon.svg', (req, res) => {
    const course = store.getCourse(req.params.courseId)
    if (!course) return res.status(404).json({ error: 'Course not found' })
    res.set('Cache-Control', 'private, no-store')
    res.type('image/svg+xml').send(classroomIconSvg(course))
  })
  // Self-enrolment is the product: a student with no credential yet arrives and
  // leaves holding a per-person token. Gating this on a bearer would make the
  // class link the credential, which is exactly the model being removed. The
  // `resolveRegistrationAccess` parameter stays accepted and ignored so older
  // callers keep constructing.
  router.post('/courses/:courseId/register', (req, res) => {
    const preferredName = String(req.body?.preferredName || '').trim()
    const pronouns = String(req.body?.pronouns || '').trim()
    const universityLogin = String(req.body?.universityLogin || '').trim().toLowerCase()
    if (!preferredName || !universityLogin) return res.status(400).json({ error: 'preferredName and universityLogin are required' })
    if (!/^[a-z0-9._-]+$/.test(universityLogin)) return res.status(400).json({ error: 'universityLogin contains unsupported characters' })
    if (!store.getCourse(req.params.courseId)) return res.status(404).json({ error: 'Course not found' })
    const enrollmentToken = crypto.randomBytes(32).toString('hex')
    try {
      const student = store.registerStudent({ courseId: req.params.courseId, preferredName, pronouns, universityLogin, enrollmentToken })
      rememberStudentToken(req, res, enrollmentToken)
      return res.status(201).json({ student, enrollmentToken })
    } catch (error) {
      if (String(error?.code || '').startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ error: 'That university login is already registered for this course' })
      throw error
    }
  })
  // Redeeming is proving possession of the transfer code, which is itself a
  // per-student secret minted against their own row. No bearer is consulted.
  // FIRST-INSTRUCTOR BOOTSTRAP, INSIDE THE ONE BEARER EXCEPTION. The setup
  // CLI mints the first instructor for a course and there is nothing else to
  // authorise it with — no instructor identity exists yet to check membership
  // against. So a bearer caller creating a course with zero instructors mints
  // exactly one instructor row from the setup-supplied identity fields and
  // returns its per-person token once. A bearer caller against a course that
  // already has an instructor mints nothing: re-running setup re-records the
  // course and returns it without a token, so a lost first token is a named
  // one-time recovery, never a silent re-mint. An instructor-identity caller
  // creating a second course gets course-only — their identity already
  // resolves, so there is nothing to bootstrap. This stays inside course
  // creation; the instructors route below still requires a resolving
  // instructor of that course for every later mint.
  //
  // Defined ahead of the principal gate below ON PURPOSE: a bootstrap caller
  // holds only a bearer and no per-person token, so the gate would 401 them
  // before they arrived. The handler takes either an instructor identity (a
  // second course from an existing instructor) or any valid token. Tokens
  // carry no level — the bearer only admits, it grants nothing by itself.
  router.post('/courses', (req, res) => {
    const principal = resolvePrincipal(req, store)
    if (principal) req.classroomPrincipal = principal
    const authorised = principal?.role === 'instructor'
      || !!resolveIdentity(extractToken(req))
    if (!authorised) return res.status(401).json({ error: 'Unauthorized' })
    const { id, title, preferredName, pronouns, instructorDisplayName, instructorUniversityLogin } = req.body || {}
    if (!id || !title || !String(preferredName || '').trim()) return res.status(400).json({ error: 'id, title, and preferredName are required' })
    // A resolving instructor needs no bootstrap: their identity already
    // exists, and minting beside it would attach a second row to a call that
    // asked for a course.
    if (principal) return res.status(201).json(store.upsertCourse({ id, title, preferredName: String(preferredName).trim(), pronouns }))
    // Bootstrap identity is validated BEFORE the course row is touched: a
    // bearer caller that cannot name the first instructor must not create or
    // alter the course on the way to being refused. The refusal below asserts
    // both halves — no row, no mint.
    if (store.getCourse(id) && store.listInstructors(id).length > 0) {
      return res.status(201).json(store.upsertCourse({ id, title, preferredName: String(preferredName).trim(), pronouns }))
    }
    const login = String(instructorUniversityLogin || '').trim().toLowerCase()
    const displayName = String(instructorDisplayName || '').trim()
    if (!displayName || !login) return res.status(400).json({ error: 'instructorDisplayName and instructorUniversityLogin are required to bootstrap the first instructor' })
    if (!/^[a-z0-9._-]+$/.test(login)) return res.status(400).json({ error: 'instructorUniversityLogin contains unsupported characters' })
    const course = store.upsertCourse({ id, title, preferredName: String(preferredName).trim(), pronouns })
    const token = crypto.randomBytes(32).toString('hex')
    try {
      const instructor = store.registerInstructor({ courseId: id, displayName, preferredName: String(preferredName).trim(), pronouns, universityLogin: login, token })
      rememberStudentToken(req, res, token)
      return res.status(201).json({ ...course, instructor, token })
    } catch (error) {
      if (String(error?.code || '').startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ error: 'That university login is already an instructor for this course' })
      throw error
    }
  })
  router.post('/courses/:courseId/device-transfer/redeem', (req, res) => {
    const transferCode = String(req.body?.transferCode || '')
    if (!transferCode) return res.status(400).json({ error: 'transferCode is required' })
    const enrollmentToken = crypto.randomBytes(32).toString('hex')
    const result = store.redeemDeviceTransfer({ courseId: req.params.courseId, transferCode, enrollmentToken })
    if (result.status === 'invalid') return res.status(404).json({ error: 'Transfer link is invalid for this class' })
    if (result.status === 'expired') return res.status(410).json({ error: 'Transfer link has expired' })
    if (result.status === 'used') return res.status(409).json({ error: 'Transfer link has already been used' })
    rememberStudentToken(req, res, enrollmentToken)
    return res.json({ student: result.student, enrollmentToken })
  })
  // Redeeming the instructor's handoff is the browser's first login, so it
  // sits ahead of the principal gate with the device-transfer redeem: there is
  // no classroom identity yet to admit, and the gate would 401 the very call
  // that creates one.
  router.post('/courses/:courseId/instructor-handoff/redeem', (req, res) => {
    const transferCode = String(req.body?.transferCode || '')
    if (!transferCode) return res.status(400).json({ error: 'transferCode is required' })
    const result = store.redeemInstructorBrowserHandoff({ courseId: req.params.courseId, transferCode })
    if (result.status === 'invalid') return res.status(404).json({ error: 'Handoff link is invalid for this class' })
    if (result.status === 'expired') return res.status(410).json({ error: 'Handoff link has expired' })
    if (result.status === 'used') return res.status(409).json({ error: 'Handoff link has already been used' })
    const freshToken = crypto.randomBytes(32).toString('hex')
    store.rotateInstructorToken(result.instructor.id, freshToken)
    rememberStudentToken(req, res, freshToken)
    return res.json({ instructor: { id: result.instructor.id, courseId: result.instructor.courseId, displayName: result.instructor.displayName } })
  })
  router.use((req, res, next) => {
    const principal = resolvePrincipal(req, store)
    if (!principal) return res.status(401).json({ error: 'Unauthorized' })
    req.classroomPrincipal = principal
    next()
  })

  // Membership, not a role string: the principal carries an instructor id, and
  // the store answers whether that id is a member of THIS course's instructors
  // group. A bearer level is never consulted — a shared secret has no members.
  // Course-scoped so one course's instructor is not every course's.
  const instructorOf = courseIdOf => (req, res, next) => {
    const courseId = typeof courseIdOf === 'function' ? courseIdOf(req) : courseIdOf
    return store.isInstructorOf(req.classroomPrincipal, courseId)
      ? next()
      : res.status(403).json({ error: 'Instructor access required' })
  }
  const instructor = instructorOf(req => req.params.courseId ?? req.body?.courseId)

  // The instructor's own first login, in the shape the setup CLI drives.
  //
  // The browser holds no classroom identity yet, so the mint is proved by the
  // minted instructor token itself — carried as the classroom header, in
  // memory, for this one call — and not by the principal gate, which would
  // 401 the very caller this exists for. The response carries only the opaque
  // handoff URL: the code in it is single-use and short-lived, and redeeming
  // it sets the HttpOnly classroom cookie without ever returning any token
  // value. The cookie value is a rotation — same instructor row, fresh secret
  // — so the CLI-held mint, already spent on the same-run gated calls, stops
  // resolving at first redemption; that is the shape that keeps any persisted
  // token material out of the handoff rows entirely.
  const INSTRUCTOR_HANDOFF_TTL_MS = 10 * 60 * 1000
  function instructorHandoffUrl(req, courseId, transferCode, { assignment = '' } = {}) {
    const protocol = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim()
    const origin = `${protocol}://${req.get('host')}`
    const url = new URL('/', origin)
    url.searchParams.delete('classroomToken')
    url.searchParams.delete('name')
    url.searchParams.delete('pwtab')
    url.searchParams.delete('pw')
    url.searchParams.set('workspace', 'classroom-problems')
    if (assignment) url.searchParams.set('assignment', assignment)
    url.searchParams.set('course', courseId)
    url.searchParams.set('handoff', transferCode)
    return url.toString()
  }
  router.post('/courses/:courseId/instructor-handoff', (req, res) => {
    const instructorToken = studentToken(req)
    const instructor = store.instructorForToken ? store.instructorForToken(instructorToken) : null
    if (!instructor || instructor.courseId !== req.params.courseId) return res.status(401).json({ error: 'Unauthorized' })
    const assignment = String(req.body?.assignment || '').trim()
    if (assignment) {
      const row = store.getAssignment(assignment)
      if (!row || row.courseId !== req.params.courseId) return res.status(400).json({ error: 'assignment is not in this course' })
    }
    const createdAt = new Date().toISOString()
    const expiresAt = new Date(Date.parse(createdAt) + INSTRUCTOR_HANDOFF_TTL_MS).toISOString()
    const transferCode = crypto.randomBytes(32).toString('base64url')
    store.createInstructorBrowserHandoff({
      instructorId: instructor.id,
      courseId: req.params.courseId,
      transferCode,
      instructorToken,
      createdAt,
      expiresAt,
    })
    // The handoff code IS the credential in this URL, and it is single-use
    // with a ten-minute expiry — the raw instructor token never appears here.
    res.status(201).json({ handoffUrl: instructorHandoffUrl(req, req.params.courseId, transferCode, { assignment }), expiresAt })
  })
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
    // No bearer in the URL: the transfer code IS the credential, and writing a
    // shared secret into a link that leaves the browser rebuilds what this
    // change removes.
    const transferUrl = deviceTransferUrl(req, principal.courseId, transferCode, {
      returnPath: req.body?.returnPath,
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
   * It carries no bearer at all: the transfer code is the credential, and the
   * student redeems it with no prior identity. The `resolveLinkAccessToken`
   * parameter stays accepted and ignored so older callers keep constructing.
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
    const assignmentId = String(req.body?.assignmentId || '').trim()
    let landingPath = ''
    if (assignmentId) {
      const assignment = store.getAssignment(assignmentId)
      if (!assignment || assignment.courseId !== student.courseId) {
        return res.status(400).json({ error: 'assignment is not in this course' })
      }
      if (!store.getSubmission(assignmentId, student.id)) {
        return res.status(409).json({ error: 'The student has no submitted work for that assignment' })
      }
      landingPath = `/?workspace=classroom-work&assignment=${encodeURIComponent(assignmentId)}`
    }
    const createdAt = new Date().toISOString()
    const expiresAt = new Date(Date.parse(createdAt) + REPAIR_LINK_TTL_MS).toISOString()
    const transferCode = crypto.randomBytes(32).toString('base64url')
    store.createDeviceTransfer({ studentId: student.id, courseId: student.courseId, transferCode, createdAt, expiresAt })
    const repairUrl = deviceTransferUrl(req, student.courseId, transferCode, { project: project || null })
    const landedRepairUrl = landingPath ? (() => { const url = new URL(repairUrl); url.searchParams.set('landing', landingPath); return url.toString() })() : repairUrl
    res.status(201).json({ student, repairUrl: landedRepairUrl, qrSvg: classroomTransferQrSvg(landedRepairUrl), expiresAt })
  })

  // An instructor enrols the way a student does: per-person token, minted once,
  // hashed at rest, returned once. The first instructor for a course arrives
  // over the bootstrap path above; every one after that is minted by an
  // instructor identity already in the group.
  router.post('/courses/:courseId/instructors', instructor, (req, res) => {
    const { displayName, preferredName, pronouns, universityLogin } = req.body || {}
    const login = String(universityLogin || '').trim().toLowerCase()
    if (!displayName || !login) return res.status(400).json({ error: 'displayName and universityLogin are required' })
    if (!/^[a-z0-9._-]+$/.test(login)) return res.status(400).json({ error: 'universityLogin contains unsupported characters' })
    if (!store.getCourse(req.params.courseId)) return res.status(404).json({ error: 'Course not found' })
    const token = crypto.randomBytes(32).toString('hex')
    try {
      const instructorRow = store.registerInstructor({ courseId: req.params.courseId, displayName, preferredName, pronouns, universityLogin: login, token })
      rememberStudentToken(req, res, token)
      return res.status(201).json({ instructor: instructorRow, token })
    } catch (error) {
      if (String(error?.code || '').startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ error: 'That university login is already an instructor for this course' })
      throw error
    }
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
    const { id, title, dueAt, solutionsDocKey, solutionsVersion, sourceDocKey, handoutDocKey, handoutFilter, solutionFilter, bookPageFile } = req.body || {}
    if (!id || !title || !dueAt) return res.status(400).json({ error: 'id, title, and dueAt are required' })
    if (bookPageFile && (String(bookPageFile).startsWith('/') || String(bookPageFile).split('/').includes('..') || !String(bookPageFile).endsWith('.html'))) {
      return res.status(400).json({ error: 'bookPageFile must be a relative HTML path' })
    }
    res.status(201).json(store.upsertAssignment({ id, courseId: req.params.courseId, title, dueAt, solutionsDocKey, solutionsVersion, sourceDocKey, handoutDocKey, handoutFilter, solutionFilter, bookPageFile }))
  })

  router.get('/courses/:courseId/assignments', (req, res) => {
    const p = req.classroomPrincipal
    if (p.role === 'student' && p.courseId !== req.params.courseId) return res.status(403).json({ error: 'Forbidden' })
    if (p.role === 'instructor' && !store.isInstructorOf(p, req.params.courseId)) return res.status(403).json({ error: 'Forbidden' })
    const assignments = store.listAssignments(req.params.courseId)
    if (store.isInstructorOf(p, req.params.courseId)) return res.json({ assignments })
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
    if (p.role === 'instructor' && !store.isInstructorOf(p, req.params.courseId)) return res.status(403).json({ error: 'Forbidden' })
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
  // Assignment-scoped: the course comes from the assignment row, so one
  // course's instructor reads one course's problems.
  const instructorForAssignment = (req, res, next) => {
    const assignment = store.getAssignment(req.params.assignmentId)
    if (!assignment) return res.status(404).json({ error: 'Assignment not found' })
    return store.isInstructorOf(req.classroomPrincipal, assignment.courseId)
      ? next()
      : res.status(403).json({ error: 'Instructor access required' })
  }
  router.get('/assignments/:assignmentId/problems', instructorForAssignment, (req, res) => {
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

  router.put('/assignments/:assignmentId/template', instructorForAssignment, async (req, res) => {
    const { templateDocKey, templateFile = null } = req.body || {}
    if (!templateDocKey) return res.status(400).json({ error: 'templateDocKey is required' })
    try {
      const templateVersion = await resolveTemplateVersion(templateDocKey)
      res.json(store.freezeTemplate(req.params.assignmentId, { templateDocKey, templateVersion, templateFile }))
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
    // The name is the instructor's own, from their own token — the same rule as
    // the student branch above. The course row's name is the course's, and
    // reading it here is what put the instructor's identity on a column that
    // describes somebody else. `?course=` stays as the course being asked
    // about, and a caller asking about a course they are not a member of is
    // refused rather than answered.
    const courseId = String(req.query?.course || p.courseId || '')
    if (!courseId) return res.status(400).json({ error: 'course is required' })
    if (!store.isInstructorOf(p, courseId)) return res.status(403).json({ error: 'Forbidden' })
    const course = store.getCourse(courseId)
    if (!course) return res.status(404).json({ error: 'Course not found' })
    // A MISSING NAME IS A MISSING NAME, NOT A MISSING IDENTITY.
    //
    // This refused the whole call with 409 when `preferred_name` was empty. The
    // column was added by `4a01a1545` with a bare ALTER TABLE and no backfill,
    // so every course predating it was null forever — qtm285 among them, which
    // was every real course on the teaching box. The same commit gave students
    // `COALESCE(preferred_name, display_name)` and gave courses this refusal:
    // same field, same commit, opposite treatment.
    //
    // What it cost was not a badge. `useSolutionChapterMarking` asks who you are
    // before it installs and returns on a null identity, so the solution
    // chapter's marking never installed at all and the only visible trace was a
    // toast about a name.
    //
    // There is nothing to guard now: the store backfills the column and holds it
    // NOT NULL, so a course that exists has a name. The guard is gone rather
    // than kept as a fallback, because a fallback here would be unreachable code
    // standing where the failure used to be.
    res.json({ role: 'instructor', instructorId: p.instructorId, courseId, displayName: p.displayName, preferredName: p.preferredName || p.displayName, pronouns: p.pronouns || null })
  })

  router.get('/assignments/:assignmentId/submissions/:studentId', (req, res) => {
    const { assignmentId, studentId } = req.params
    const assignment = store.getAssignment(assignmentId)
    if (!assignment) return res.status(404).json({ error: 'Assignment not found' })
    if (!canReadStudent(req.classroomPrincipal, assignmentId, studentId, store)) return res.status(403).json({ error: 'Forbidden' })
    const row = store.getSubmission(assignmentId, studentId, { includeDrafts: store.isInstructorOf(req.classroomPrincipal, assignment.courseId) })
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
    const assignment = store.getAssignment(assignmentId)
    if (!assignment) return res.status(404).json({ error: 'Assignment not found' })
    if (!ownsStudent(req.classroomPrincipal, studentId, store, assignment.courseId)) return res.status(403).json({ error: 'Forbidden' })

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

  /**
   * Run a hand-in's build again, when the last one failed.
   *
   * The narrow answer to work that is accepted, stored, and unrenderable. A
   * build is keyed on the source revision, so once a submission's build has
   * failed nothing re-runs it: re-uploading the student's own bytes yields the
   * same revision and the source transaction does nothing, and a submission has
   * no daemon binding for `rebuildLinkedProject` to use. Before this, a hand-in
   * broken by a server bug stayed broken after the bug was fixed, and the only
   * way out was to edit the student's file.
   *
   * SCOPED TO A SUBMISSION ON PURPOSE. The project is read off the submission
   * record rather than taken from the caller, so this cannot name an arbitrary
   * project and cannot become a general rebuild API. It re-runs the revision
   * that is already accepted — it never proposes a new one, and never touches
   * stored source.
   *
   * A build that has not failed is refused rather than re-run, and the refusal
   * says which state it is in: re-running a successful build is a different
   * request and belongs to whoever wants to make it.
   */
  router.post('/assignments/:assignmentId/submissions/:studentId/rerender', instructorForAssignment, async (req, res) => {
    const { assignmentId, studentId } = req.params
    const submission = store.getSubmission(assignmentId, studentId, { includeDrafts: true })
    if (!submission) return res.status(404).json({ error: `${studentId} has not handed in ${assignmentId}, so there is no build to re-run.` })

    const project = submission.contentRef
    const result = await rerunFailedBuild(project)
    if (!result.ok) {
      const at = result.revision ? ` for revision ${result.revision.slice(0, 12)}` : ''
      const detail = {
        'no-accepted-revision': 'it has no accepted revision, so there is nothing to build',
        'no-build-record': `the queue holds no record of a build${at}`,
      }[result.reason] || `its build${at} is ${result.reason}, and only a failed build is re-run`
      return res.status(409).json({ error: `${project} was not re-run: ${detail}.`, state: result.reason })
    }
    res.json({ project, revision: result.revision, state: result.state, previousState: result.previousState })
  })

  router.post('/assignments/:assignmentId/submissions/:studentId/feedback', instructorForAssignment, (req, res) => {
    const { title, text, attached = true } = req.body || {}
    if (!title || !text) return res.status(400).json({ error: 'title and text are required' })
    const id = store.addFeedback({ assignmentId: req.params.assignmentId, studentId: req.params.studentId, title, text, attached })
    res.status(201).json({ id })
  })

  const missingSubmission = error => /submission not found/i.test(error?.message || '')

  router.post('/assignments/:assignmentId/submissions/:studentId/grade', instructorForAssignment, (req, res) => {
    try {
      res.json(store.setStatus(req.params.assignmentId, req.params.studentId, 'graded'))
    } catch (error) {
      if (!missingSubmission(error)) throw error
      res.status(404).json({ error: 'Submission not found' })
    }
  })

  router.post('/assignments/:assignmentId/submissions/:studentId/return', instructorForAssignment, async (req, res) => {
    try {
      const problemId = String(req.body?.problemId || '')
      const layerId = req.body?.layerId == null ? null : String(req.body.layerId)
      const submission = store.getSubmission(req.params.assignmentId, req.params.studentId, { includeDrafts: true })
      if (!submission) return res.status(404).json({ error: 'Submission not found' })
      // How many marks the student can now read. `null` means no problem was
      // named, so no marking layer was copied at all — which is a different
      // answer from 0, and the distinction is the whole point of reporting it.
      // A return that named no problem still marks the submission returned and
      // still answers 200, so for marking ink this response was indistinguishable
      // from one that carried the strokes across. It carried none.
      let returnedMarks = null
      // The recording layer sent with the return, verified rather than trusted:
      // the id must name a stored recording belonging to this answer, or the
      // return is rejected rather than landing with its track silently dropped.
      let returnedLayerId = null
      if (problemId) {
        if (typeof copyRoomStore !== 'function') throw new Error('local-layer store copy is not configured')
        const submissionRoomId = `doc-${submission.contentRef}`
        if (layerId) {
          // A marking layer lives in the BOOK, and only there.
          //
          // Skip, settling where this material belongs: "everything is in the
          // book", and on what we had been filing layers under: "there isn't
          // even really a homework project; it's just a file". `contentRef`
          // names that file's build, so a layer filed there could not be
          // reached from the chapter the student reads -- measured as
          // `recording-draft/<id>` answering 200 under the submission ref and
          // 404 under the chapter, which is why nothing on the chapter could
          // play a mark back.
          //
          // The old location is NOT read as a fallback. Skip: "no compat with
          // misdesigned garbage". A layer recorded under the old filing is not
          // returnable, and that is the intended answer rather than an
          // oversight -- reading both would keep the wrong model alive in the
          // one place that decides where marks come from.
          const recording = readAnswerRecording(store.getAssignment(req.params.assignmentId)?.solutionsDocKey, layerId)
          if (!recording) return res.status(404).json({ error: 'Recording layer not found' })
          const answer = recording.answer ?? null
          if (answer?.submissionRoomId !== submissionRoomId || answer?.problemId !== problemId) {
            return res.status(409).json({ error: 'Recording layer does not belong to this answer' })
          }
          returnedLayerId = layerId
        }
        // The expected identity travels INTO the store callback rather than
        // being recomputed there: the route names the answer from the
        // submission record, and the projection matches only that answer's
        // exact tag. Projection/replace failure throws before `returnFeedback`,
        // so a failed Return leaves the submission unmarked — not recorded
        // with no marks moved.
        returnedMarks = await copyRoomStore(
          gradingDraftRoomId(submissionRoomId, problemId),
          gradingReturnedRoomId(submissionRoomId, problemId),
          {
            assignmentId: req.params.assignmentId,
            studentId: req.params.studentId,
            problemId,
            submissionRoomId,
          },
        )
      } else if (layerId) {
        return res.status(400).json({ error: 'A recording layer needs a problem to belong to' })
      }
      res.json({ ...store.returnFeedback(req.params.assignmentId, req.params.studentId), returnedMarks, returnedLayerId })
    } catch (error) {
      if (!missingSubmission(error)) throw error
      res.status(404).json({ error: 'Submission not found' })
    }
  })

  return router
}
