import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { ClassroomStore } from '../server/lib/classroom-store.mjs'

// Opening the store finishes a migration that was left half-done.
//
// `4a01a1545` added `courses.preferred_name` with a bare ALTER TABLE — nullable,
// no backfill — on a field the app treats as required, and had `/me` answer 409
// when it was missing. Every course predating it was null forever, and the 409
// stopped the solution chapter's marking from installing at all.
//
// These build the OLD shape by hand rather than asking the store for it, because
// the store now produces the new shape: a test that let it create the table
// would be asserting against the fix instead of against the defect.

function legacyDatabase(dir) {
  const dbPath = path.join(dir, 'classroom.db')
  const db = new Database(dbPath)
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE courses (
      id TEXT PRIMARY KEY, title TEXT NOT NULL,
      preferred_name TEXT, pronouns TEXT
    );
    CREATE TABLE students (
      id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      display_name TEXT NOT NULL, enrollment_token_hash TEXT UNIQUE NOT NULL, active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE assignments (
      id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      title TEXT NOT NULL, due_at TEXT NOT NULL, solutions_doc_key TEXT,
      solutions_version TEXT, template_doc_key TEXT, template_version TEXT,
      source_doc_key TEXT, handout_filter TEXT, solution_filter TEXT,
      book_page_file TEXT
    );
  `)
  return { db, dbPath }
}

test('a course left with no preferred name gets one, and the column stops being nullable', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-classroom-preferred-name-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const { db, dbPath } = legacyDatabase(dir)
  db.prepare('INSERT INTO courses(id,title,preferred_name,pronouns) VALUES (?,?,?,?)').run('qtm285', 'Prediction, Inference, and Causality', null, null)
  db.prepare('INSERT INTO courses(id,title,preferred_name,pronouns) VALUES (?,?,?,?)').run('blank', 'Blank', '   ', null)
  db.prepare('INSERT INTO courses(id,title,preferred_name,pronouns) VALUES (?,?,?,?)').run('named', 'Named', 'Skip', 'he/him')
  db.close()

  const store = new ClassroomStore(dbPath)
  t.after(() => store.close())

  // The null and the whitespace-only row both get the generic; a real name is
  // never overwritten.
  assert.equal(store.getCourse('qtm285').preferred_name, 'Instructor')
  assert.equal(store.getCourse('blank').preferred_name, 'Instructor')
  assert.equal(store.getCourse('named').preferred_name, 'Skip')
  // NOT the course title. This field is displayed as a person's name, and
  // "Logged in as Prediction, Inference, and Causality" is a worse answer than
  // a generic one.
  assert.notEqual(store.getCourse('qtm285').preferred_name, 'Prediction, Inference, and Causality')

  const column = store.db.pragma('table_info(courses)').find(candidate => candidate.name === 'preferred_name')
  assert.equal(column.notnull, 1, 'the column is still nullable, so the next course can repeat this')
  assert.throws(
    () => store.db.prepare('INSERT INTO courses(id,title,preferred_name) VALUES (?,?,?)').run('x', 'X', null),
    /NOT NULL/,
    'a null preferred name is still insertable',
  )
})

// THE REBUILD MUST NOT TAKE THE CLASS WITH IT.
//
// `students` and `assignments` reference `courses(id)` ON DELETE CASCADE, and the
// store turns foreign keys on in its constructor. A rebuild that drops the old
// `courses` table with them enforced deletes every student and every assignment
// of every course — as a cascade, silently, inside the migration that runs on
// open. This is the assertion that fails if the pragma is ever dropped.
test('rebuilding courses does not cascade away the students and assignments', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-classroom-preferred-name-fk-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const { db, dbPath } = legacyDatabase(dir)
  db.prepare('INSERT INTO courses(id,title,preferred_name,pronouns) VALUES (?,?,?,?)').run('qtm285', 'QTM 285', null, null)
  db.prepare('INSERT INTO students(id,course_id,display_name,enrollment_token_hash) VALUES (?,?,?,?)').run('skipper', 'qtm285', 'Skipper', 'hash-skipper')
  db.prepare('INSERT INTO students(id,course_id,display_name,enrollment_token_hash) VALUES (?,?,?,?)').run('ada', 'qtm285', 'Ada', 'hash-ada')
  db.prepare('INSERT INTO assignments(id,course_id,title,due_at) VALUES (?,?,?,?)').run('hw1', 'qtm285', 'Homework 1', '2026-09-01T20:00:00Z')
  db.close()

  const store = new ClassroomStore(dbPath)
  t.after(() => store.close())

  assert.equal(store.db.prepare('SELECT count(*) AS n FROM students').get().n, 2, 'the students were cascaded away by the rebuild')
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM assignments').get().n, 1, 'the assignments were cascaded away by the rebuild')
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM courses').get().n, 1)
  // Enforcement is back on afterwards, or the next cascade silently does nothing.
  assert.equal(store.db.pragma('foreign_keys', { simple: true }), 1)
  assert.deepEqual(store.db.pragma('foreign_key_check'), [])
})

test('opening an already-migrated store leaves it alone', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-classroom-preferred-name-idempotent-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'classroom.db')

  const first = new ClassroomStore(dbPath)
  first.upsertCourse({ id: 'qtm285', title: 'QTM 285', preferredName: 'Skip' })
  first.close()

  const second = new ClassroomStore(dbPath)
  t.after(() => second.close())
  assert.equal(second.getCourse('qtm285').preferred_name, 'Skip')
  assert.equal(second.db.pragma('table_info(courses)').find(c => c.name === 'preferred_name').notnull, 1)
})

// NOTHING FORCED THE ISSUE, WHICH IS WHY IT LASTED THREE WEEKS.
//
// The backfill above repairs the rows that exist. This is what stops the next
// one: creating a course with no instructor's name fails at the caller that
// omitted it, rather than storing a row that reads fine and disables marking
// for whoever opens the chapter later.
test('a course cannot be created without an instructor name, and keeps it once it has one', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-classroom-preferred-name-required-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const store = new ClassroomStore(path.join(dir, 'classroom.db'))
  t.after(() => store.close())

  assert.throws(() => store.upsertCourse({ id: 'c', title: 'C' }), /without an instructor's preferred name/)
  assert.throws(() => store.upsertCourse({ id: 'c', title: 'C', preferredName: '   ' }), /without an instructor's preferred name/)
  assert.equal(store.getCourse('c'), null, 'the refused course was stored anyway')

  assert.equal(store.upsertCourse({ id: 'c', title: 'C', preferredName: 'Skip' }).preferred_name, 'Skip')
  // An update that names nobody carries no opinion about the name: it leaves the
  // stored one alone rather than refusing, so a title can be changed without
  // having to know the instructor.
  const renamed = store.upsertCourse({ id: 'c', title: 'C renamed' })
  assert.equal(renamed.preferred_name, 'Skip')
  assert.equal(renamed.title, 'C renamed')
  // And a later name replaces it.
  assert.equal(store.upsertCourse({ id: 'c', title: 'C renamed', preferredName: 'Professor Example' }).preferred_name, 'Professor Example')
})
