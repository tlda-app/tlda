import test from 'node:test'
import assert from 'node:assert/strict'
import { migrateLegacyMarkingSnapshot, projectMarkingSnapshot } from '../server/lib/classroom-marking-layer.mjs'

const IDENTITY = {
  assignmentId: 'hw1',
  studentId: 'ada',
  problemId: 'ans-exr-one',
  submissionRoomId: 'doc-submission-hw1-ada',
}

const TAG = { version: 1, ...IDENTITY }

function doc(state, clock = 1) {
  return { state, lastChangedClock: clock }
}

function snapshot(states) {
  return { documents: states.map(s => doc(s)), documentClock: states.length }
}

const SUBMISSION = { id: 'shape:sub', typeName: 'shape', type: 'html-page', parentId: 'page:page', meta: {} }
const SOLUTION = { id: 'shape:sol', typeName: 'shape', type: 'html-page', parentId: 'page:page', meta: {} }
const PAGE = { id: 'page:page', typeName: 'page', parentId: 'document:doc', meta: {} }
const INSTANCE = { id: 'instance:one', typeName: 'instance', parentId: null, meta: {} }
const POINTER = { id: 'pointer:pointer', typeName: 'pointer', parentId: null, meta: {} }
const CAMERA = { id: 'camera:one', typeName: 'camera', parentId: null, meta: {} }
const DOCUMENT = { id: 'document:doc', typeName: 'document', parentId: null, meta: {} }

test('return carries only the matching roots, their descendants, and needed parents', () => {
  const root = { id: 'shape:mark', typeName: 'shape', type: 'draw', parentId: 'page:page', meta: { classroomMarking: TAG } }
  const child = { id: 'shape:kid', typeName: 'shape', type: 'draw', parentId: 'shape:mark', meta: {} }
  const other = {
    id: 'shape:stale', typeName: 'shape', type: 'draw', parentId: 'page:page',
    meta: { classroomMarking: { ...TAG, studentId: 'bo' } },
  }
  const { snapshot: out, markCount } = projectMarkingSnapshot(
    snapshot([SUBMISSION, SOLUTION, PAGE, INSTANCE, POINTER, CAMERA, DOCUMENT, root, child, other]),
    IDENTITY,
  )
  const ids = out.documents.map(d => d.state.id)
  assert.equal(markCount, 2)
  assert.ok(ids.includes('shape:mark'))
  assert.ok(ids.includes('shape:kid'))
  assert.ok(ids.includes('page:page'), 'parent page travels with the marks')
  assert.ok(!ids.includes('shape:sub'), 'frozen submitted page stays behind')
  assert.ok(!ids.includes('shape:sol'), 'solution page stays behind')
  assert.ok(!ids.includes('shape:stale'), 'another answer stays behind')
  assert.ok(!ids.includes('instance:one'), 'presence stays behind')
  assert.ok(!ids.includes('pointer:pointer'), 'pointer session state stays behind')
  assert.ok(!ids.includes('camera:one'), 'camera session state stays behind')
  assert.ok(ids.includes('document:doc'), 'the document record travels')
})

test('mismatched identity selects nothing and counts zero', () => {
  const root = { id: 'shape:mark', typeName: 'shape', type: 'draw', parentId: 'page:page', meta: { classroomMarking: TAG } }
  const { snapshot: out, markCount } = projectMarkingSnapshot(
    snapshot([PAGE, root]),
    { ...IDENTITY, problemId: 'ans-exr-two' },
  )
  assert.equal(markCount, 0)
  assert.deepEqual(out.documents.map(d => d.state.id), [])
})

test('a binding to an excluded shape fails the return closed', () => {
  const root = { id: 'shape:mark', typeName: 'shape', type: 'draw', parentId: 'page:page', meta: { classroomMarking: TAG } }
  const arrow = {
    id: 'binding:one', typeName: 'binding', parentId: 'page:page',
    fromId: 'shape:mark', toId: 'shape:sub', meta: {},
  }
  assert.throws(
    () => projectMarkingSnapshot(snapshot([PAGE, SUBMISSION, root, arrow]), IDENTITY),
    /outside the marking layer/,
  )
})

test('legacy migration tags untagged annotations once and never touches pages', () => {
  const mark = { id: 'shape:old', typeName: 'shape', type: 'draw', parentId: 'page:page', meta: {} }
  const kid = { id: 'shape:old-kid', typeName: 'shape', type: 'draw', parentId: 'shape:old', meta: {} }
  const foreign = {
    id: 'shape:foreign', typeName: 'shape', type: 'draw', parentId: 'page:page',
    meta: { classroomMarking: { version: 1, assignmentId: 'hw1', studentId: 'bo', problemId: 'ans-exr-one', submissionRoomId: 'doc-other' } },
  }
  const foreignChild = {
    id: 'shape:foreign-child', typeName: 'shape', type: 'draw', parentId: 'shape:foreign', meta: {},
  }
  const source = snapshot([DOCUMENT, SUBMISSION, SOLUTION, PAGE, INSTANCE, POINTER, mark, kid, foreign, foreignChild])
  const first = migrateLegacyMarkingSnapshot(source, IDENTITY)
  assert.equal(first.migrated, 2)
  assert.deepEqual(mark.meta.classroomMarking, TAG)
  assert.deepEqual(kid.meta.classroomMarking, TAG)
  assert.equal(SUBMISSION.meta.classroomMarking, undefined, 'source page untouched')
  assert.equal(foreign.meta.classroomMarking.studentId, 'bo', 'foreign tag untouched')
  assert.equal(foreignChild.meta.classroomMarking, undefined, 'a foreign layer descendant is not retagged')
  assert.equal(DOCUMENT.meta.classroomMarkingMigrated, 1)

  // Idempotent: a second pass changes nothing, and a shape materialized after
  // the marker (a locked page arriving late) is never classified.
  const late = { id: 'shape:late', typeName: 'shape', type: 'html-page', parentId: 'page:page', meta: {} }
  const second = migrateLegacyMarkingSnapshot({ documents: [...source.documents, doc(late)], documentClock: 99 }, IDENTITY)
  assert.equal(second.migrated, 0)
  assert.equal(late.meta.classroomMarking, undefined)
})

test('internal bindings and referenced assets travel with the marks', () => {
  const a = { id: 'shape:a', typeName: 'shape', type: 'draw', parentId: 'page:page', meta: { classroomMarking: TAG } }
  const b = { id: 'shape:b', typeName: 'shape', type: 'image', parentId: 'page:page', meta: { classroomMarking: TAG }, props: { assetId: 'asset:pic' } }
  const arrow = {
    id: 'binding:one', typeName: 'binding', parentId: 'page:page',
    fromId: 'shape:a', toId: 'shape:b', meta: {},
  }
  const asset = { id: 'asset:pic', typeName: 'asset', parentId: null, props: { src: 'x' } }
  const { snapshot: out, markCount } = projectMarkingSnapshot(
    snapshot([PAGE, a, b, arrow, asset]),
    IDENTITY,
  )
  const ids = out.documents.map(d => d.state.id)
  assert.equal(markCount, 2)
  assert.ok(ids.includes('binding:one'))
  assert.ok(ids.includes('asset:pic'))
})
