import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const gradebook = readFileSync(new URL('../src/classroom/GradebookWorkspace.tsx', import.meta.url), 'utf8')
const lifecycle = readFileSync(new URL('../src/classroom/MarkingLifecycle.tsx', import.meta.url), 'utf8')
const comparison = readFileSync(new URL('../src/classroom/HomeworkComparisonWorkspace.tsx', import.meta.url), 'utf8')

test('gradebook submission links use the project route and the return link clears it', () => {
  assert.match(gradebook, /next\.set\('project', contentRef\)/)
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
