import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCanvasClipShapePredicate } from '../src/canvas-clip-shape-predicate.ts'
import { isProjectMapShape } from '../src/panels/project-map-shape-predicate.ts'

const shape = (type) => ({ id: `shape:${type}`, type })

test('read-only canvas clips honor a host shape predicate', () => {
  const predicate = createCanvasClipShapePredicate({
    lockCamera: false,
    readOnly: true,
    hostShapePredicate: (candidate) => candidate.type === 'svg-page',
  })

  assert.equal(predicate(shape('svg-page')), true)
  assert.equal(predicate(shape('fleet-docview')), false)
  assert.equal(predicate(shape('fleet-chat')), false)
})

test('read-only canvas clips without a host predicate keep legacy all-shape rendering', () => {
  const predicate = createCanvasClipShapePredicate({
    lockCamera: false,
    readOnly: true,
  })

  assert.equal(predicate(shape('fleet-docview')), true)
})

test('Project tab map clips render document page shapes only', () => {
  assert.equal(isProjectMapShape(shape('svg-page')), true)
  assert.equal(isProjectMapShape(shape('html-page')), true)
  assert.equal(isProjectMapShape(shape('fleet-docview')), false)
  assert.equal(isProjectMapShape(shape('fleet-chat')), false)
})
