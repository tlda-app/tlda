import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ClassroomStore } from '../server/lib/classroom-store.mjs'

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-classroom-'))
  const store = new ClassroomStore(path.join(dir, 'classroom.db'))
  store.upsertCourse({ id: 'qtm285', title: 'QTM 285' })
  store.upsertStudent({ id: 'ada', courseId: 'qtm285', displayName: 'Ada', enrollmentToken: 'ada-secret' })
  store.upsertStudent({ id: 'grace', courseId: 'qtm285', displayName: 'Grace', enrollmentToken: 'grace-secret' })
  store.upsertAssignment({ id: 'hw1', courseId: 'qtm285', title: 'Homework 1', dueAt: '2026-09-01T20:00:00Z', sourceDocKey: 'hw1-source', bookPageFile: 'homework/hw1.html', handoutFilter: 'homework/assignment-callout.lua', solutionFilter: 'homework/solution-callout.lua', solutionsDocKey: 'hw1-solutions', solutionsVersion: 'abc' })
  return { store, close() { store.close(); fs.rmSync(dir, { recursive: true, force: true }) } }
}

test('gradebook derives missing and ungraded states from roster and submissions', () => {
  const f = fixture()
  try {
    f.store.submit({ assignmentId: 'hw1', studentId: 'ada', contentRef: 'hw1-ada', submittedAt: '2026-08-31T12:00:00Z' })
    const status = f.store.status('qtm285')
    assert.deepEqual(status.counts, { missing: 1, ungraded: 1, graded: 0, returned: 0 })
    assert.equal(status.rows.find(r => r.id === 'ada').assignments[0].state, 'ungraded')
    assert.equal(status.rows.find(r => r.id === 'grace').assignments[0].state, 'not-submitted')
  } finally { f.close() }
})

test('assignment keeps the book page that links a returned student to their work', () => {
  const f = fixture()
  try {
    assert.equal(f.store.getAssignment('hw1').bookPageFile, 'homework/hw1.html')
    f.store.upsertAssignment({ id: 'hw1', courseId: 'qtm285', title: 'Homework 1', dueAt: '2026-09-01T20:00:00Z' })
    assert.equal(f.store.getAssignment('hw1').bookPageFile, 'homework/hw1.html')
  } finally { f.close() }
})

test('course pronouns can be cleared without losing the preferred name', () => {
  const f = fixture()
  try {
    f.store.upsertCourse({ id: 'qtm285', title: 'QTM 285', preferredName: 'skip', pronouns: 'he/him' })
    const cleared = f.store.upsertCourse({ id: 'qtm285', title: 'QTM 285', preferredName: 'skip', pronouns: '' })
    assert.equal(cleared.preferred_name, 'skip')
    assert.equal(cleared.pronouns, null)
  } finally { f.close() }
})

test('a common-layer student is an ordinary roster member through missing, submission, and marking', () => {
  const f = fixture()
  try {
    const demo = f.store.upsertStudent({
      id: 'demo', courseId: 'qtm285', displayName: 'Demo Student', enrollmentToken: 'demo-secret', layerScope: 'common',
    })
    assert.equal(demo.layerScope, 'common')
    assert.equal(f.store.studentForToken('demo-secret').layerScope, 'common')
    assert.equal(f.store.status('qtm285').rows.find(row => row.id === 'demo').assignments[0].state, 'not-submitted')

    f.store.submit({ assignmentId: 'hw1', studentId: 'demo', contentRef: 'hw1-demo', answerIds: ['ans-p1'] })
    assert.equal(f.store.status('qtm285').rows.find(row => row.id === 'demo').assignments[0].state, 'ungraded')
    const answer = f.store.problems('hw1').problems[0].answers.find(row => row.studentId === 'demo')
    assert.equal(answer.layerScope, 'common')
    f.store.setStatus('hw1', 'demo', 'graded')
    assert.equal(f.store.getSubmission('hw1', 'demo').gradingStatus, 'graded')
  } finally { f.close() }
})

test('generated handout reference freezes once per assignment', () => {
  const f = fixture()
  try {
    const frozen = f.store.freezeTemplate('hw1', { templateDocKey: 'hw1-handout', templateVersion: 'handout-build-abc' })
    assert.equal(frozen.templateDocKey, 'hw1-handout')
    assert.equal(frozen.templateVersion, 'handout-build-abc')
    assert.deepEqual(f.store.freezeTemplate('hw1', { templateDocKey: 'hw1-handout', templateVersion: 'handout-build-abc' }), frozen)
    assert.throws(() => f.store.freezeTemplate('hw1', { templateDocKey: 'changed', templateVersion: 'changed' }), /already frozen/)
  } finally { f.close() }
})

test('return transaction exposes attached feedback and advances lifecycle', () => {
  const f = fixture()
  try {
    f.store.submit({ assignmentId: 'hw1', studentId: 'ada', contentRef: 'hw1-ada' })
    f.store.addFeedback({ id: 'attached', assignmentId: 'hw1', studentId: 'ada', title: 'Sign', text: 'Check the sign.', attached: true })
    f.store.addFeedback({ id: 'loose', assignmentId: 'hw1', studentId: 'ada', title: 'Later', text: 'Private note.', attached: false })
    f.store.returnFeedback('hw1', 'ada', '2026-09-02T12:00:00Z')
    const student = f.store.getSubmission('hw1', 'ada')
    const instructor = f.store.getSubmission('hw1', 'ada', { includeDrafts: true })
    assert.equal(student.gradingStatus, 'returned')
    assert.deepEqual(student.feedback.map(x => x.id), ['attached'])
    assert.deepEqual(instructor.feedback.map(x => x.id), ['attached', 'loose'])
    assert.equal(instructor.feedback.find(x => x.id === 'loose').visibility, 'instructor-draft')
  } finally { f.close() }
})

test('enrollment tokens resolve server-side and are stored only as hashes', () => {
  const f = fixture()
  try {
    assert.equal(f.store.studentForToken('ada-secret').id, 'ada')
    assert.equal(f.store.studentForToken('wrong'), null)
    const raw = f.store.db.prepare('SELECT enrollment_token_hash FROM students WHERE id=?').get('ada')
    assert.notEqual(raw.enrollment_token_hash, 'ada-secret')
  } finally { f.close() }
})

test('the source project is gated like solutions: a student is refused, an instructor is not', () => {
  // The class link named `<assignment>-source`, whose mainFile is the master QMD
  // with the worked solutions in it, and nothing stopped a student reading it:
  // the gate matched only `solutions_doc_key`, so the OTHER document holding the
  // answers answered {restricted: false, allowed: true} to anybody.
  //
  // Both directions are asserted. A rule that also refuses the instructor, or
  // that refuses the handout students are supposed to open, gets switched off
  // and then catches nothing.
  const f = fixture()
  try {
    const student = { role: 'student', courseId: 'qtm285', studentId: 'ada' }
    const instructor = { role: 'instructor' }

    const refused = f.store.documentAccess('hw1-source', student)
    assert.equal(refused.restricted, true)
    assert.equal(refused.allowed, false)

    const allowed = f.store.documentAccess('hw1-source', instructor)
    assert.equal(allowed.restricted, true)
    assert.equal(allowed.allowed, true)

    // Anonymous is refused too — the leak was reachable without a principal.
    assert.equal(f.store.documentAccess('hw1-source', null).allowed, false)

    // And it does not over-fire: the handout is what students are sent to.
    const handout = f.store.documentAccess('hw1-handout', student)
    assert.equal(handout.restricted, false)
    assert.equal(handout.allowed, true)

    // Solutions are unchanged by the widening.
    assert.equal(f.store.documentAccess('hw1-solutions', student).allowed, false)
    assert.equal(f.store.documentAccess('hw1-solutions', instructor).allowed, true)
  } finally { f.close() }
})

test('handing in opens the source the same way it opens the solutions', () => {
  // The source is gated by the solutions rule rather than by a new one, so it
  // inherits "open once you have handed something in". That is deliberate: the
  // master holds the same worked answers the solutions render does, and gating
  // it more strictly than the solutions themselves would be a different rule
  // than the one Skip gave. Asserted so that changing it is a decision rather
  // than a surprise.
  const f = fixture()
  try {
    const student = { role: 'student', courseId: 'qtm285', studentId: 'ada' }
    assert.equal(f.store.documentAccess('hw1-source', student).allowed, false)
    f.store.submit({ assignmentId: 'hw1', studentId: 'ada', contentRef: 'hw1-ada' })
    assert.equal(f.store.documentAccess('hw1-source', student).allowed, true)
    assert.equal(f.store.documentAccess('hw1-solutions', student).allowed, true)
  } finally { f.close() }
})

test('the frozen template names a file, so it can be the handout QMD rather than the master', () => {
  // classroomTemplateSource could only read the project's mainFile. The handout
  // project's is the rendered HTML, so the only QMD reachable was the master --
  // and the master carries no answer blocks, so missingAnswers extracted zero
  // ids from it and could never fire. Naming the file reaches the generated
  // handout QMD, which `git add --all` already committed in that project.
  const f = fixture()
  try {
    f.store.freezeTemplate('hw1', {
      templateDocKey: 'hw1-handout', templateVersion: 'v1', templateFile: 'hw1.qmd',
    })
    const a = f.store.getAssignment('hw1')
    assert.equal(a.templateDocKey, 'hw1-handout')
    assert.equal(a.templateFile, 'hw1.qmd')
    assert.equal(a.templateVersion, 'v1')
    assert.equal(f.store.listAssignments('qtm285')[0].templateFile, 'hw1.qmd')
  } finally { f.close() }
})

test('an assignment frozen before the column reads its mainFile, as it always did', () => {
  // Absent a file the reader falls back to the project's mainFile, which is what
  // every assignment frozen before this column has. Not a fallback path invented
  // here -- it is the only behaviour that ever existed, kept for rows that
  // predate the field.
  const f = fixture()
  try {
    f.store.freezeTemplate('hw1', { templateDocKey: 'hw1-source', templateVersion: 'v0' })
    assert.equal(f.store.getAssignment('hw1').templateFile, null)
  } finally { f.close() }
})
