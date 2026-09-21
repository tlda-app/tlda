import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isStampedMarkingShapeType,
  gradingPanePanInteraction,
  isWorkspaceMarkingInput,
  isWorkspaceSubmissionShape,
  markingTag,
  markingTagMatches,
  shapeBelongsToMarkingLayer,
} from '../src/classroom/gradingWorkspace.ts'

const IDENTITY = {
  assignmentId: 'hw1',
  studentId: 'ada',
  problemId: 'ans-exr-one',
  submissionRoomId: 'doc-submission-hw1-ada',
}

function store(shapes) {
  const byId = new Map(shapes.map(shape => [shape.id, shape]))
  return id => byId.get(id)
}

test('a tag matches only its own exact answer identity', () => {
  const tag = markingTag(IDENTITY)
  assert.equal(markingTagMatches(tag, IDENTITY), true)
  assert.equal(markingTagMatches(tag, { ...IDENTITY, studentId: 'bo' }), false)
  assert.equal(markingTagMatches(tag, { ...IDENTITY, problemId: 'ans-exr-two' }), false)
  assert.equal(markingTagMatches({ ...tag, version: 2 }, IDENTITY), false)
  assert.equal(markingTagMatches({ kind: 'marking' }, IDENTITY), false)
  assert.equal(markingTagMatches(undefined, IDENTITY), false)
})

test('only draw, highlight, and math-note shapes are stamped', () => {
  assert.equal(isStampedMarkingShapeType('draw'), true)
  assert.equal(isStampedMarkingShapeType('highlight'), true)
  assert.equal(isStampedMarkingShapeType('math-note'), true)
  assert.equal(isStampedMarkingShapeType('note'), false)
  assert.equal(isStampedMarkingShapeType('html-page'), false)
  assert.equal(isStampedMarkingShapeType('arrow'), false)
})

test('mark tools own the writable submission viewport for their whole session', () => {
  for (const tool of ['draw', 'highlight', 'math-note', 'voice-note']) {
    assert.equal(isWorkspaceMarkingInput(tool), true, `${tool} must stamp shapes even outside pointer-down`)
    assert.equal(gradingPanePanInteraction(true, tool), false, `${tool} must reach TldrawViewport`)
    assert.equal(gradingPanePanInteraction(false, tool), true, 'the solution pane keeps pan interaction')
  }
  assert.equal(isWorkspaceMarkingInput('select'), false)
  assert.equal(gradingPanePanInteraction(true, 'select'), true)
})

test('descendants inherit the nearest tagged ancestor', () => {
  const get = store([
    { id: 'shape:root', parentId: 'page:page', meta: { classroomMarking: markingTag(IDENTITY) } },
    { id: 'shape:child', parentId: 'shape:root', meta: {} },
    { id: 'shape:other', parentId: 'page:page', meta: { classroomMarking: markingTag({ ...IDENTITY, studentId: 'bo' }) } },
    { id: 'shape:plain', parentId: 'page:page', meta: {} },
  ])
  assert.equal(shapeBelongsToMarkingLayer('shape:root', get, IDENTITY), true)
  assert.equal(shapeBelongsToMarkingLayer('shape:child', get, IDENTITY), true)
  assert.equal(shapeBelongsToMarkingLayer('shape:other', get, IDENTITY), false)
  assert.equal(shapeBelongsToMarkingLayer('shape:plain', get, IDENTITY), false)
})

test('the submission predicate accepts the page and the layer, nothing else', () => {
  const get = store([
    { id: 'shape:sub', parentId: 'page:page', meta: {} },
    { id: 'shape:nested', parentId: 'shape:sub', meta: {} },
    { id: 'shape:mark', parentId: 'page:page', meta: { classroomMarking: markingTag(IDENTITY) } },
    { id: 'shape:stale', parentId: 'page:page', meta: { classroomMarking: markingTag({ ...IDENTITY, problemId: 'ans-exr-two' }) } },
    { id: 'shape:sol', parentId: 'page:page', meta: {} },
  ])
  const check = shape => isWorkspaceSubmissionShape(shape, get, 'shape:sub', IDENTITY)
  assert.equal(check({ id: 'shape:sub', parentId: 'page:page', meta: {} }), true)
  assert.equal(check({ id: 'shape:nested', parentId: 'shape:sub', meta: {} }), true)
  assert.equal(check({ id: 'shape:mark', parentId: 'page:page', meta: { classroomMarking: markingTag(IDENTITY) } }), true)
  assert.equal(check({ id: 'shape:stale', parentId: 'page:page', meta: { classroomMarking: markingTag({ ...IDENTITY, problemId: 'ans-exr-two' }) } }), false)
  assert.equal(check({ id: 'shape:sol', parentId: 'page:page', meta: {} }), false)
})
