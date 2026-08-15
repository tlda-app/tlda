import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveDocViewTargetShapeId } from '../src/shapes/docViewTarget'

const pages = [{ shapeId: 'shape:page-1' }, { shapeId: 'shape:page-2' }]

test('HTML doc view resolves a valid requested page', () => {
  assert.equal(resolveDocViewTargetShapeId({ format: 'html', pages, page: 2 }), 'shape:page-2')
})

test('HTML doc view without a selected page resolves the first document page', () => {
  assert.equal(resolveDocViewTargetShapeId({ format: 'html', pages, page: 0 }), 'shape:page-1')
})

test('explicit targets and non-HTML documents retain their existing behavior', () => {
  assert.equal(resolveDocViewTargetShapeId({
    format: 'html', pages, page: 1, explicitTargetShapeId: 'shape:explicit',
  }), 'shape:explicit')
  assert.equal(resolveDocViewTargetShapeId({ format: 'svg', pages, page: 1 }), '')
})
