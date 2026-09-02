import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const gradebook = readFileSync(new URL('../src/classroom/GradebookWorkspace.tsx', import.meta.url), 'utf8')
const lifecycle = readFileSync(new URL('../src/classroom/MarkingLifecycle.tsx', import.meta.url), 'utf8')

test('gradebook submission links use the project route and the return link clears it', () => {
  assert.match(gradebook, /next\.set\('project', contentRef\)/)
  assert.doesNotMatch(gradebook, /next\.set\('doc', contentRef\)/)
  assert.match(lifecycle, /\['project', 'compareDoc', 'markingCourse', 'markingAssignment', 'markingStudent'\]/)
})
