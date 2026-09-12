import Database from 'better-sqlite3'
import crypto from 'crypto'
import os from 'os'
import path from 'path'
import fs from 'fs'

const DEFAULT_DB = process.env.TLDA_CLASSROOM_DB
  || (process.env.TLDA_FLEET_DB ? path.join(path.dirname(process.env.TLDA_FLEET_DB), 'classroom.db') : null)
  || path.join(os.homedir(), '.config', 'tlda', 'classroom.db')
const STATUSES = new Set(['ungraded', 'graded', 'returned'])
const STUDENT_LAYER_SCOPES = new Set(['student', 'common'])

export function hashEnrollmentToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

export class ClassroomStore {
  constructor(dbPath = DEFAULT_DB) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('journal_mode = WAL')
    this.#migrate()
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS courses (
        id TEXT PRIMARY KEY, title TEXT NOT NULL,
        preferred_name TEXT, pronouns TEXT
      );
      CREATE TABLE IF NOT EXISTS students (
        id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL, enrollment_token_hash TEXT UNIQUE NOT NULL, active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS student_device_credentials (
        id TEXT PRIMARY KEY,
        student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        transfer_code_hash TEXT UNIQUE NOT NULL,
        device_token_hash TEXT UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        redeemed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS assignments (
        id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        title TEXT NOT NULL, due_at TEXT NOT NULL, solutions_doc_key TEXT,
        solutions_version TEXT, template_doc_key TEXT, template_version TEXT,
        source_doc_key TEXT, handout_filter TEXT, solution_filter TEXT,
        book_page_file TEXT
      );
      CREATE TABLE IF NOT EXISTS submissions (
        assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
        student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        content_ref TEXT NOT NULL, submitted_at TEXT NOT NULL,
        grading_status TEXT NOT NULL DEFAULT 'ungraded' CHECK (grading_status IN ('ungraded','graded','returned')),
        graded_at TEXT, returned_at TEXT,
        PRIMARY KEY (assignment_id, student_id)
      );
      CREATE TABLE IF NOT EXISTS feedback_marks (
        id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL, student_id TEXT NOT NULL,
        title TEXT NOT NULL, text TEXT NOT NULL, attached INTEGER NOT NULL DEFAULT 1,
        visibility TEXT NOT NULL DEFAULT 'instructor-draft' CHECK (visibility IN ('instructor-draft','returned')),
        created_at TEXT NOT NULL, returned_at TEXT,
        FOREIGN KEY (assignment_id, student_id) REFERENCES submissions(assignment_id, student_id) ON DELETE CASCADE
      );
    `)
    const courseColumns = new Set(this.db.pragma('table_info(courses)').map(column => column.name))
    if (!courseColumns.has('preferred_name')) this.db.exec('ALTER TABLE courses ADD COLUMN preferred_name TEXT')
    if (!courseColumns.has('pronouns')) this.db.exec('ALTER TABLE courses ADD COLUMN pronouns TEXT')
    const assignmentColumns = new Set(this.db.pragma('table_info(assignments)').map(column => column.name))
    if (!assignmentColumns.has('template_doc_key')) this.db.exec('ALTER TABLE assignments ADD COLUMN template_doc_key TEXT')
    if (!assignmentColumns.has('source_doc_key')) this.db.exec('ALTER TABLE assignments ADD COLUMN source_doc_key TEXT')
    if (!assignmentColumns.has('handout_filter')) this.db.exec('ALTER TABLE assignments ADD COLUMN handout_filter TEXT')
    if (!assignmentColumns.has('solution_filter')) this.db.exec('ALTER TABLE assignments ADD COLUMN solution_filter TEXT')
    if (!assignmentColumns.has('book_page_file')) this.db.exec('ALTER TABLE assignments ADD COLUMN book_page_file TEXT')
    // The answer ids a submission actually contains. Problem-by-problem marking
    // pairs one exercise across every student, so the join key has to survive
    // upload rather than being re-derived by reparsing each archive.
    const submissionColumns = new Set(this.db.pragma('table_info(submissions)').map(column => column.name))
    if (!submissionColumns.has('answer_ids')) this.db.exec('ALTER TABLE submissions ADD COLUMN answer_ids TEXT')
    const studentColumns = new Set(this.db.pragma('table_info(students)').map(column => column.name))
    if (!studentColumns.has('preferred_name')) this.db.exec('ALTER TABLE students ADD COLUMN preferred_name TEXT')
    if (!studentColumns.has('pronouns')) this.db.exec('ALTER TABLE students ADD COLUMN pronouns TEXT')
    if (!studentColumns.has('university_login')) this.db.exec('ALTER TABLE students ADD COLUMN university_login TEXT')
    if (!studentColumns.has('layer_scope')) this.db.exec("ALTER TABLE students ADD COLUMN layer_scope TEXT NOT NULL DEFAULT 'student' CHECK (layer_scope IN ('student','common'))")
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_students_course_login ON students(course_id, university_login) WHERE university_login IS NOT NULL')
  }

  close() { this.db.close() }

  upsertCourse({ id, title, preferredName, pronouns }) {
    const existing = this.getCourse(id)
    const nextPreferredName = preferredName === undefined ? (existing?.preferred_name || null) : preferredName
    const nextPronouns = pronouns === undefined ? (existing?.pronouns || null) : (String(pronouns ?? '').trim() || null)
    this.db.prepare(`INSERT INTO courses(id,title,preferred_name,pronouns) VALUES (?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, preferred_name=excluded.preferred_name, pronouns=excluded.pronouns`)
      .run(id, title, nextPreferredName, nextPronouns)
    return this.getCourse(id)
  }

  getCourse(id) { return this.db.prepare('SELECT * FROM courses WHERE id=?').get(id) || null }

  upsertStudent({ id, courseId, displayName, preferredName, pronouns, enrollmentToken, active = true, layerScope = 'student' }) {
    if (!STUDENT_LAYER_SCOPES.has(layerScope)) throw new Error(`invalid student layer scope: ${layerScope}`)
    const existing = this.getStudent(id)
    const nextPreferredName = String(preferredName ?? displayName ?? '').trim()
    if (!nextPreferredName) throw new Error('preferred name is required')
    const nextPronouns = pronouns === undefined ? (existing?.pronouns || null) : (String(pronouns ?? '').trim() || null)
    const tokenHash = hashEnrollmentToken(enrollmentToken)
    this.db.prepare(`INSERT INTO students(id,course_id,display_name,preferred_name,pronouns,enrollment_token_hash,active,layer_scope) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET course_id=excluded.course_id, display_name=excluded.display_name,
      preferred_name=excluded.preferred_name, pronouns=excluded.pronouns,
      enrollment_token_hash=excluded.enrollment_token_hash, active=excluded.active, layer_scope=excluded.layer_scope`)
      .run(id, courseId, nextPreferredName, nextPreferredName, nextPronouns, tokenHash, active ? 1 : 0, layerScope)
    return this.getStudent(id)
  }

  registerStudent({ courseId, preferredName, pronouns = null, universityLogin, enrollmentToken }) {
    const id = `${courseId}:${universityLogin}`
    const tokenHash = hashEnrollmentToken(enrollmentToken)
    this.db.prepare(`INSERT INTO students(id,course_id,display_name,preferred_name,pronouns,enrollment_token_hash,active,university_login)
      VALUES (?,?,?,?,?,?,1,?)`).run(id, courseId, preferredName, preferredName, pronouns || null, tokenHash, universityLogin)
    return this.getStudent(id)
  }

  getStudent(id) { return this.db.prepare('SELECT id, course_id AS courseId, COALESCE(preferred_name,display_name) AS displayName, preferred_name AS preferredName, pronouns, active, layer_scope AS layerScope FROM students WHERE id=?').get(id) || null }
  studentForToken(token) {
    if (!token) return null
    const tokenHash = hashEnrollmentToken(token)
    const primary = this.db.prepare(`SELECT id, course_id AS courseId, COALESCE(preferred_name,display_name) AS displayName, preferred_name AS preferredName, pronouns, layer_scope AS layerScope FROM students
      WHERE enrollment_token_hash=? AND active=1`).get(tokenHash)
    if (primary) return primary
    return this.db.prepare(`SELECT st.id, st.course_id AS courseId, COALESCE(st.preferred_name,st.display_name) AS displayName, st.preferred_name AS preferredName, st.pronouns, st.layer_scope AS layerScope
      FROM student_device_credentials dc JOIN students st ON st.id=dc.student_id
      WHERE dc.device_token_hash=? AND dc.redeemed_at IS NOT NULL AND st.active=1`).get(tokenHash) || null
  }
  listStudents(courseId) { return this.db.prepare('SELECT id, course_id AS courseId, display_name AS displayName, university_login AS universityLogin, layer_scope AS layerScope FROM students WHERE course_id=? AND active=1 ORDER BY display_name').all(courseId) }

  createDeviceTransfer({ id = crypto.randomUUID(), studentId, courseId, transferCode, createdAt = new Date().toISOString(), expiresAt }) {
    const student = this.getStudent(studentId)
    if (!student || !student.active || student.courseId !== courseId) throw new Error('student not found in course')
    this.db.prepare(`INSERT INTO student_device_credentials(id,student_id,transfer_code_hash,created_at,expires_at)
      VALUES (?,?,?,?,?)`).run(id, studentId, hashEnrollmentToken(transferCode), createdAt, expiresAt)
    return { id, studentId, courseId, createdAt, expiresAt }
  }

  redeemDeviceTransfer({ courseId, transferCode, enrollmentToken, now = new Date().toISOString() }) {
    return this.db.transaction(() => {
      const row = this.db.prepare(`SELECT dc.id,dc.student_id AS studentId,dc.expires_at AS expiresAt,dc.redeemed_at AS redeemedAt,
        st.course_id AS courseId,st.active
        FROM student_device_credentials dc JOIN students st ON st.id=dc.student_id
        WHERE dc.transfer_code_hash=?`).get(hashEnrollmentToken(transferCode))
      if (!row || row.courseId !== courseId || !row.active) return { status: 'invalid' }
      if (row.redeemedAt) return { status: 'used' }
      if (new Date(row.expiresAt).getTime() <= new Date(now).getTime()) return { status: 'expired' }
      const result = this.db.prepare(`UPDATE student_device_credentials
        SET device_token_hash=?,redeemed_at=? WHERE id=? AND redeemed_at IS NULL`)
        .run(hashEnrollmentToken(enrollmentToken), now, row.id)
      if (!result.changes) return { status: 'used' }
      return { status: 'redeemed', student: this.getStudent(row.studentId) }
    })()
  }

  upsertAssignment({ id, courseId, title, dueAt, solutionsDocKey = null, solutionsVersion = null, templateDocKey = null, templateVersion = null, sourceDocKey = null, handoutFilter = null, solutionFilter = null, bookPageFile = null }) {
    this.db.prepare(`INSERT INTO assignments(id,course_id,title,due_at,solutions_doc_key,solutions_version,template_doc_key,template_version,source_doc_key,handout_filter,solution_filter,book_page_file)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET course_id=excluded.course_id,title=excluded.title,due_at=excluded.due_at,
      solutions_doc_key=excluded.solutions_doc_key,solutions_version=excluded.solutions_version,
      template_doc_key=COALESCE(assignments.template_doc_key,excluded.template_doc_key),
      template_version=COALESCE(assignments.template_version,excluded.template_version),
      source_doc_key=excluded.source_doc_key,handout_filter=excluded.handout_filter,solution_filter=excluded.solution_filter,
      book_page_file=COALESCE(excluded.book_page_file,assignments.book_page_file)`)
      .run(id, courseId, title, dueAt, solutionsDocKey, solutionsVersion, templateDocKey, templateVersion, sourceDocKey, handoutFilter, solutionFilter, bookPageFile)
    return this.getAssignment(id)
  }
  getAssignment(id) { return this.db.prepare(`SELECT id,course_id AS courseId,title,due_at AS dueAt,solutions_doc_key AS solutionsDocKey,
    solutions_version AS solutionsVersion,template_doc_key AS templateDocKey,template_version AS templateVersion,
    source_doc_key AS sourceDocKey,handout_filter AS handoutFilter,solution_filter AS solutionFilter,
    book_page_file AS bookPageFile FROM assignments WHERE id=?`).get(id) || null }
  listAssignments(courseId) { return this.db.prepare(`SELECT id,course_id AS courseId,title,due_at AS dueAt,solutions_doc_key AS solutionsDocKey,
    solutions_version AS solutionsVersion,template_doc_key AS templateDocKey,template_version AS templateVersion,
    source_doc_key AS sourceDocKey,handout_filter AS handoutFilter,solution_filter AS solutionFilter,
    book_page_file AS bookPageFile FROM assignments WHERE course_id=? ORDER BY due_at`).all(courseId) }
  assignmentsForSolutionsDoc(docKey) {
    if (!docKey) return []
    return this.db.prepare(`SELECT id,course_id AS courseId,title,due_at AS dueAt,solutions_doc_key AS solutionsDocKey,
      solutions_version AS solutionsVersion,template_doc_key AS templateDocKey,template_version AS templateVersion,
      source_doc_key AS sourceDocKey,handout_filter AS handoutFilter,solution_filter AS solutionFilter,
      book_page_file AS bookPageFile
      FROM assignments WHERE solutions_doc_key=? ORDER BY due_at`).all(docKey)
  }

  /**
   * The assignment a book page IS, if it is one.
   *
   * Setup records the rendered page on its assignment, so a chapter of the book
   * and a piece of homework are the same thing named two ways. Asked of the
   * record rather than parsed out of the path, because a page is homework
   * because an assignment says so and for no other reason.
   */
  assignmentForBookPage(bookPageFile, courseId) {
    if (!bookPageFile || !courseId) return null
    return this.db.prepare(`SELECT id,course_id AS courseId,title,due_at AS dueAt,solutions_doc_key AS solutionsDocKey,
      solutions_version AS solutionsVersion,template_doc_key AS templateDocKey,template_version AS templateVersion,
      source_doc_key AS sourceDocKey,handout_filter AS handoutFilter,solution_filter AS solutionFilter,
      book_page_file AS bookPageFile
      FROM assignments WHERE book_page_file=? AND course_id=?`).get(bookPageFile, courseId) || null
  }

  solutionDocumentAccess(docKey, principal) {
    const assignments = this.assignmentsForSolutionsDoc(docKey)
    if (assignments.length === 0) return { restricted: false, allowed: true, assignments }
    if (principal?.role === 'instructor') return { restricted: true, allowed: true, assignments }
    if (principal?.role !== 'student') return { restricted: true, allowed: false, assignments }
    const allowed = assignments.some(assignment =>
      assignment.courseId === principal.courseId
      && this.getSubmission(assignment.id, principal.studentId)
    )
    return { restricted: true, allowed, assignments }
  }

  /**
   * Whose handed-in work this document is, or null when it is not a submission.
   *
   * Read off `content_ref` — the string the submit path wrote, and the same one
   * the document is served under. Deliberately not parsed out of the name: it is
   * `submission-<assignment>-<student>`, both halves may contain a `-`, and no
   * parse can recover the split.
   */
  submissionDocumentOwner(docKey) {
    if (!docKey) return null
    return this.db.prepare(`SELECT s.assignment_id AS assignmentId,s.student_id AS studentId,a.course_id AS courseId
      FROM submissions s JOIN assignments a ON a.id=s.assignment_id WHERE s.content_ref=?`).get(docKey) || null
  }

  /**
   * Whether a caller may read one classroom document — solutions or submission.
   *
   * One answer, because `/docs` and `/api/projects/:name` each have a single
   * place to ask. Solutions open once you have handed something in; a submission
   * is the student's own and opens to nobody else in the class.
   *
   * Skip, on what needs gating at all: "we just need to make sure acces to
   * student jnfo is token gated." `classroomRoomAccess` in
   * `shared/classroom-rooms.mjs` applies that to the sync rooms and refuses one
   * student a look at another's layer. A handed-in assignment is the same
   * student information over HTTP — measured on the live course box, the shared
   * read token every classmate holds returned another student's rendered
   * homework and the photograph attached to it.
   */
  documentAccess(docKey, principal) {
    const submission = this.submissionDocumentOwner(docKey)
    if (!submission) return this.solutionDocumentAccess(docKey, principal)
    return { restricted: true, allowed: this.mayReadStudentWork(principal, submission), submission }
  }

  /**
   * Whether a caller may read one student's work for one assignment.
   *
   * The rule already existed as `canReadStudent` in `routes/classroom.mjs`,
   * deciding it for the submission ROW. The document, the index, the history and
   * the sync room now ask the same question, so it lives here and that function
   * calls it — one encoding, rather than a second one that drifts.
   *
   * A classmate reaches it only where the roster already says so: the owner's
   * `layerScope` is `common`, which is an explicit opt-in and never the default.
   * Narrowing that to owner-and-instructor would have been a product change
   * smuggled in under a privacy fix.
   */
  mayReadStudentWork(principal, { studentId, courseId }) {
    if (principal?.role === 'instructor') return true
    if (principal?.role !== 'student') return false
    if (principal.studentId === studentId) return true
    const owner = this.getStudent(studentId)
    return owner?.active === 1
      && owner.courseId === principal.courseId
      && courseId === principal.courseId
      && owner.layerScope === 'common'
  }

  freezeTemplate(assignmentId, { templateDocKey, templateVersion }) {
    if (!templateDocKey || !templateVersion) throw new Error('templateDocKey and templateVersion are required')
    const assignment = this.getAssignment(assignmentId)
    if (!assignment) throw new Error('assignment not found')
    if (assignment.templateDocKey || assignment.templateVersion) {
      if (assignment.templateDocKey === templateDocKey && assignment.templateVersion === templateVersion) return assignment
      throw new Error('assignment template is already frozen')
    }
    this.db.prepare('UPDATE assignments SET template_doc_key=?,template_version=? WHERE id=?')
      .run(templateDocKey, templateVersion, assignmentId)
    return this.getAssignment(assignmentId)
  }

  submit({ assignmentId, studentId, contentRef, answerIds = null, submittedAt = new Date().toISOString() }) {
    this.db.prepare(`INSERT INTO submissions(assignment_id,student_id,content_ref,submitted_at,grading_status,answer_ids)
      VALUES (?,?,?,?, 'ungraded', ?) ON CONFLICT(assignment_id,student_id) DO UPDATE SET
      content_ref=excluded.content_ref, submitted_at=excluded.submitted_at, grading_status='ungraded', graded_at=NULL, returned_at=NULL,
      answer_ids=excluded.answer_ids`)
      .run(assignmentId, studentId, contentRef, submittedAt, answerIds ? JSON.stringify(answerIds) : null)
    // Deliberately without drafts. Submitting is student-callable and its
    // return value goes straight back to them, so asking for his unreturned
    // marks here handed them over in the response body — and re-uploading is
    // not an edge case, the student guide tells them they may do it as often
    // as they like before the deadline.
    //
    // Nothing needs them: the caller has just created a submission and there
    // is nothing of his to show yet. Removing the flag from the path is
    // stronger than getting each route that touches it right.
    return this.getSubmission(assignmentId, studentId)
  }

  /**
   * The assignment seen the way he marks it: one row per exercise, and for each
   * exercise every student's answer to it, in roster order.
   *
   * A student who did not answer a problem still appears, because "nobody
   * attempted question 4" is the thing worth seeing, and a list that silently
   * omits them hides it.
   */
  problems(assignmentId) {
    const assignment = this.getAssignment(assignmentId)
    if (!assignment) return null
    // Driven by the roster, not by the submissions table. Selecting from
    // submissions drops anyone who handed in nothing, so the class silently
    // shrinks: the flick-through reads "1 of 1" while the roster holds two, and
    // the student who submitted nothing is the one most worth arriving at.
    const rows = this.db.prepare(`SELECT st.id AS studentId, st.display_name AS displayName, st.layer_scope AS layerScope,
      s.content_ref AS contentRef, s.grading_status AS gradingStatus, s.answer_ids AS answerIds
      FROM students st LEFT JOIN submissions s
        ON s.student_id = st.id AND s.assignment_id = ?
      WHERE st.course_id = ? AND st.active = 1
      ORDER BY st.display_name`).all(assignmentId, assignment.courseId)

    const parsed = rows.map(row => ({ ...row, answerIds: row.answerIds ? JSON.parse(row.answerIds) : [] }))
    // Order follows first appearance in a submission, which is the template's
    // order — every student's copy came from the same handout.
    const problemIds = []
    for (const row of parsed) for (const id of row.answerIds) if (!problemIds.includes(id)) problemIds.push(id)

    return {
      assignment,
      problems: problemIds.map(problemId => ({
        problemId,
        answers: parsed.map(row => ({
          studentId: row.studentId,
          displayName: row.displayName,
          layerScope: row.layerScope,
          contentRef: row.contentRef,
          // Same word the gradebook uses, so the two surfaces do not describe
          // the same student differently.
          gradingStatus: row.gradingStatus ?? 'not-submitted',
          // The anchor into that student's rendered page. Anchoring beats
          // slicing their HTML apart: the id is a contract the template sets,
          // the surrounding markup is Quarto's business.
          anchor: row.answerIds.includes(problemId) ? problemId : null,
        })),
      })),
    }
  }

  addFeedback({ id = crypto.randomUUID(), assignmentId, studentId, title, text, attached = true, createdAt = new Date().toISOString() }) {
    this.db.prepare(`INSERT INTO feedback_marks(id,assignment_id,student_id,title,text,attached,visibility,created_at)
      VALUES (?,?,?,?,?,?, 'instructor-draft',?)`).run(id, assignmentId, studentId, title, text, attached ? 1 : 0, createdAt)
    return id
  }

  setStatus(assignmentId, studentId, status, now = new Date().toISOString()) {
    if (!STATUSES.has(status)) throw new Error(`invalid grading status: ${status}`)
    const result = this.db.prepare(`UPDATE submissions SET grading_status=?, graded_at=CASE WHEN ? IN ('graded','returned') THEN COALESCE(graded_at,?) ELSE graded_at END,
      returned_at=CASE WHEN ?='returned' THEN ? ELSE returned_at END WHERE assignment_id=? AND student_id=?`)
      .run(status, status, now, status, now, assignmentId, studentId)
    if (!result.changes) throw new Error('submission not found')
    return this.getSubmission(assignmentId, studentId, { includeDrafts: true })
  }

  returnFeedback(assignmentId, studentId, now = new Date().toISOString()) {
    return this.db.transaction(() => {
      this.db.prepare(`UPDATE feedback_marks SET visibility='returned', returned_at=?
        WHERE assignment_id=? AND student_id=? AND attached=1 AND visibility='instructor-draft'`).run(now, assignmentId, studentId)
      return this.setStatus(assignmentId, studentId, 'returned', now)
    })()
  }

  getSubmission(assignmentId, studentId, { includeDrafts = false } = {}) {
    const row = this.db.prepare(`SELECT assignment_id AS assignmentId,student_id AS studentId,content_ref AS contentRef,
      submitted_at AS submittedAt,grading_status AS gradingStatus,graded_at AS gradedAt,returned_at AS returnedAt
      FROM submissions WHERE assignment_id=? AND student_id=?`).get(assignmentId, studentId)
    if (!row) return null
    const marks = this.db.prepare(`SELECT id,title,text,attached,visibility,created_at AS createdAt,returned_at AS returnedAt
      FROM feedback_marks WHERE assignment_id=? AND student_id=? ${includeDrafts ? '' : "AND visibility='returned'"} ORDER BY created_at`)
      .all(assignmentId, studentId).map(mark => ({ ...mark, attached: !!mark.attached }))
    return { ...row, feedback: marks }
  }

  // `studentId` narrows the same query to one person rather than being a second
  // one. Everything below — cells, states, counts — is then computed by the code
  // that computes it for the whole class, so a student's view of their own
  // status cannot drift from what the instructor is looking at.
  status(courseId, { studentId = null } = {}) {
    const students = this.listStudents(courseId).filter(student => studentId === null || student.id === studentId)
    const assignments = this.listAssignments(courseId)
    const lookup = this.db.prepare(`SELECT assignment_id AS assignmentId,student_id AS studentId,content_ref AS contentRef,
      submitted_at AS submittedAt,grading_status AS gradingStatus FROM submissions
      WHERE assignment_id IN (SELECT id FROM assignments WHERE course_id=?)`).all(courseId)
    const byKey = new Map(lookup.map(row => [`${row.assignmentId}\0${row.studentId}`, row]))
    const rows = students.map(student => ({
      ...student,
      assignments: assignments.map(assignment => {
        const submission = byKey.get(`${assignment.id}\0${student.id}`)
        return submission ? { assignmentId: assignment.id, state: submission.gradingStatus, ...submission } : { assignmentId: assignment.id, state: 'not-submitted' }
      }),
    }))
    const cells = rows.flatMap(row => row.assignments)
    return { course: this.getCourse(courseId), assignments, rows, counts: {
      missing: cells.filter(x => x.state === 'not-submitted').length,
      ungraded: cells.filter(x => x.state === 'ungraded').length,
      graded: cells.filter(x => x.state === 'graded').length,
      returned: cells.filter(x => x.state === 'returned').length,
    } }
  }
}
