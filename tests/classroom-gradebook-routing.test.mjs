import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const gradebook = readFileSync(new URL('../src/classroom/GradebookWorkspace.tsx', import.meta.url), 'utf8')
const lifecycle = readFileSync(new URL('../src/classroom/MarkingLifecycle.tsx', import.meta.url), 'utf8')
const comparison = readFileSync(new URL('../src/classroom/HomeworkComparisonWorkspace.tsx', import.meta.url), 'utf8')
const toc = readFileSync(new URL('../src/panels/TocTab.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

// These assertions read the SOURCE TEXT. That catches a line being changed or
// dropped and proves nothing about what the link does when clicked — the route
// it builds is checked in the app, not here.

test('the gradebook opens the solution chapter, not the mode Skip rejected', () => {
  // "It's just supposed to look like the ordinary solution chapter — it is the
  // solution chapter — and it's not a mode." The link sent him to
  // `?workspace=classroom-problems`, which is that mode.
  // The code, not the word: the comment above the fix names the mode it removed,
  // and a bare /classroom-problems/ matches that comment and fails on the fix.
  assert.doesNotMatch(gradebook, /next\.set\('workspace', 'classroom-problems'\)/)
  // `course` is what the chapter needs to resolve an identity before it installs
  // the marking layer; this deleted it, so the link that opened marking also
  // guaranteed there was none.
  assert.match(gradebook, /next\.set\('course', courseId\)/)
  // And the student whose cell he clicked, so the arrows open on that person.
  assert.match(gradebook, /next\.set\('student', studentId\)/)
  assert.doesNotMatch(gradebook, /next\.set\('doc', contentRef\)/)
  assert.match(lifecycle, /\['project', 'compareDoc', 'markingCourse', 'markingAssignment', 'markingStudent'\]/)
})

test('gradebook exposes one assignment comparison containing the official solution and every submitted roster row', () => {
  assert.match(gradebook, /workspace=classroom-comparison/)
  assert.match(comparison, /data-homework-comparison=/)
  assert.match(comparison, /className="classroomComparisonSolution"/)
  assert.match(comparison, /className="classroomComparisonSubmissions"/)
  assert.match(comparison, /data-student-id=/)
  assert.match(comparison, /Open marking canvas/)
})

test('a standalone grading link loads the student page and its comparison page', () => {
  assert.match(app, /get\('compareDoc'\)/)
  assert.match(app, /Promise\.all\(\[\s*fetch\(`\$\{fullBasePath\}page-info\.json`\)/)
  assert.match(app, /group: 'marked-exercise', url: compareBasePath \+ solutionPages\[0\]\.file/)
})

test('gradebook files emailed work through the existing instructor upload and returns its student link', () => {
  assert.match(gradebook, /classroomApi\.uploadForStudent\(assignmentId, studentId, file\)/)
  assert.match(gradebook, /classroomApi\.createRepairLink\(courseId, studentId, undefined, assignmentId\)/)
  assert.match(gradebook, /File emailed work/)
})

test('the book homework occurrence links returned students to their own work', () => {
  assert.match(toc, /homeworkByPage\.get\(h\.targetFile\)/)
  assert.match(toc, /homework\?\.returned/)
  assert.match(toc, /workspace=classroom-work&assignment=/)
})
