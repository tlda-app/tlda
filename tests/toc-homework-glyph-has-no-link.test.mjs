import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// A structural assertion about the component, not about a rendered tree: the
// claim being protected is that a code path does not exist. Rendering TocTab
// needs an editor, a book context and a project, and none of that would make
// the absence of a branch any more visible than reading for it.
const source = readFileSync(new URL('../src/panels/TocTab.tsx', import.meta.url), 'utf8')

const renderItem = source.match(/function renderFoldableItem[\s\S]*?\n  }\n/)?.[0] || ''

test('the item renderer was found, so the assertions below are about something', () => {
  // Without this the absence assertions below pass against an empty string.
  assert.ok(renderItem.length > 0, 'renderFoldableItem not found in TocTab.tsx')
  assert.match(renderItem, /toc-item-type--/)
})

test('a matched assignment row carries the glyph', () => {
  assert.match(renderItem, /\(homework \|\| itemType\) && \(/)
  assert.match(renderItem, /COURSE_ITEM_BADGE\[homework \? 'homework' : itemType!\]/)
})

test('a matched page is presence only — the row carries no assignment payload', () => {
  assert.match(renderItem, /homeworkPages\.has\(/)
  assert.doesNotMatch(source, /HomeworkEntry/)
  assert.doesNotMatch(source, /assignmentId/)
})

test('no returned-student link leaves the table of contents', () => {
  assert.doesNotMatch(renderItem, /workspace=classroom-work/)
  assert.doesNotMatch(renderItem, /Open your returned homework/)
  assert.doesNotMatch(renderItem, /<a\b/)
})

test('nothing in the panel consults whether work was returned', () => {
  // A returned-student payload and an unreturned one reach the same branch,
  // because the panel never looks at grading state at all.
  assert.doesNotMatch(source, /gradingStatus/)
  assert.doesNotMatch(renderItem, /returned/)
})
