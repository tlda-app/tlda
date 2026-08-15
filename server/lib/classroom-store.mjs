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
        id TEXT PRIMARY KEY, title TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS students (
        id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL, enrollment_token_hash TEXT UNIQUE NOT NULL, active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS assignments (
        id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        title TEXT NOT NULL, due_at TEXT NOT NULL, solutions_doc_key TEXT,
        solutions_version TEXT, template_doc_key TEXT, template_version TEXT
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
    const assignmentColumns = new Set(this.db.pragma('table_info(assignments)').map(column => column.name))
    if (!assignmentColumns.has('template_doc_key')) this.db.exec('ALTER TABLE assignments ADD COLUMN template_doc_key TEXT')
    // The answer ids a submission actually contains. Problem-by-problem marking
    // pairs one exercise across every student, so the join key has to survive
    // upload rather than being re-derived by reparsing each archive.
    const submissionColumns = new Set(this.db.pragma('table_info(submissions)').map(column => column.name))
    if (!submissionColumns.has('answer_ids')) this.db.exec('ALTER TABLE submissions ADD COLUMN answer_ids TEXT')
    const studentColumns = new Set(this.db.pragma('table_info(students)').map(column => column.name))
    if (!studentColumns.has('university_login')) this.db.exec('ALTER TABLE students ADD COLUMN university_login TEXT')
    if (!studentColumns.has('layer_scope')) this.db.exec("ALTER TABLE students ADD COLUMN layer_scope TEXT NOT NULL DEFAULT 'student' CHECK (layer_scope IN ('student','common'))")
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_students_course_login ON students(course_id, university_login) WHERE university_login IS NOT NULL')
  }

  close() { this.db.close() }

  upsertCourse({ id, title }) {
    this.db.prepare(`INSERT INTO courses(id,title) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title`).run(id, title)
    return this.getCourse(id)
  }

  getCourse(id) { return this.db.prepare('SELECT * FROM courses WHERE id=?').get(id) || null }

  upsertStudent({ id, courseId, displayName, enrollmentToken, active = true, layerScope = 'student' }) {
    if (!STUDENT_LAYER_SCOPES.has(layerScope)) throw new Error(`invalid student layer scope: ${layerScope}`)
    const tokenHash = hashEnrollmentToken(enrollmentToken)
    this.db.prepare(`INSERT INTO students(id,course_id,display_name,enrollment_token_hash,active,layer_scope) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET course_id=excluded.course_id, display_name=excluded.display_name,
      enrollment_token_hash=excluded.enrollment_token_hash, active=excluded.active, layer_scope=excluded.layer_scope`)
      .run(id, courseId, displayName, tokenHash, active ? 1 : 0, layerScope)
    return this.getStudent(id)
  }

  registerStudent({ courseId, displayName, universityLogin, enrollmentToken }) {
    const id = `${courseId}:${universityLogin}`
    const tokenHash = hashEnrollmentToken(enrollmentToken)
    this.db.prepare(`INSERT INTO students(id,course_id,display_name,enrollment_token_hash,active,university_login)
      VALUES (?,?,?,?,1,?)`).run(id, courseId, displayName, tokenHash, universityLogin)
    return this.getStudent(id)
  }

  getStudent(id) { return this.db.prepare('SELECT id, course_id AS courseId, display_name AS displayName, active, layer_scope AS layerScope FROM students WHERE id=?').get(id) || null }
  studentForToken(token) {
    if (!token) return null
    return this.db.prepare(`SELECT id, course_id AS courseId, display_name AS displayName, layer_scope AS layerScope FROM students
      WHERE enrollment_token_hash=? AND active=1`).get(hashEnrollmentToken(token)) || null
  }
  listStudents(courseId) { return this.db.prepare('SELECT id, course_id AS courseId, display_name AS displayName, university_login AS universityLogin, layer_scope AS layerScope FROM students WHERE course_id=? AND active=1 ORDER BY display_name').all(courseId) }

  upsertAssignment({ id, courseId, title, dueAt, solutionsDocKey = null, solutionsVersion = null, templateDocKey = null, templateVersion = null }) {
    this.db.prepare(`INSERT INTO assignments(id,course_id,title,due_at,solutions_doc_key,solutions_version,template_doc_key,template_version)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET course_id=excluded.course_id,title=excluded.title,due_at=excluded.due_at,
      solutions_doc_key=excluded.solutions_doc_key,solutions_version=excluded.solutions_version,
      template_doc_key=COALESCE(assignments.template_doc_key,excluded.template_doc_key),
      template_version=COALESCE(assignments.template_version,excluded.template_version)`)
      .run(id, courseId, title, dueAt, solutionsDocKey, solutionsVersion, templateDocKey, templateVersion)
    return this.getAssignment(id)
  }
  getAssignment(id) { return this.db.prepare(`SELECT id,course_id AS courseId,title,due_at AS dueAt,solutions_doc_key AS solutionsDocKey,
    solutions_version AS solutionsVersion,template_doc_key AS templateDocKey,template_version AS templateVersion FROM assignments WHERE id=?`).get(id) || null }
  listAssignments(courseId) { return this.db.prepare(`SELECT id,course_id AS courseId,title,due_at AS dueAt,solutions_doc_key AS solutionsDocKey,
    solutions_version AS solutionsVersion,template_doc_key AS templateDocKey,template_version AS templateVersion FROM assignments WHERE course_id=? ORDER BY due_at`).all(courseId) }

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

  status(courseId) {
    const students = this.listStudents(courseId)
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
