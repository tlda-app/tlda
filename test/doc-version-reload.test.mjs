import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createDocVersionReloadObserver,
  docVersionHashFromRecord,
  hasRenderedPageMismatch,
} from '../src/hooks/docVersionReload.ts'

test('version stamp change reloads mismatched render without a signal', () => {
  let hash = '1111111aaaa'
  let renderHash = '1111111'
  let reloads = 0
  const observer = createDocVersionReloadObserver({
    readHash: () => hash,
    hasMismatchedRender: nextHash =>
      hasRenderedPageMismatch(
        [{ shapeId: 'shape:page-1' }],
        nextHash,
        () => '<svg>old</svg>',
        () => renderHash,
      ),
    reload: () => { reloads += 1 },
  })

  observer()
  assert.equal(reloads, 0)

  hash = '2222222bbbb'
  observer()
  assert.equal(reloads, 1)

  renderHash = '2222222'
  observer()
  assert.equal(reloads, 1)
})

test('only already-rendered page text can be mismatched', () => {
  assert.equal(
    hasRenderedPageMismatch(
      [{ shapeId: 'shape:page-1' }],
      'abcdef12345',
      () => undefined,
      () => undefined,
    ),
    false,
  )
})

test('doc-version hash ignores unknown sentinel records', () => {
  assert.equal(docVersionHashFromRecord({ props: { commitHash: 'unknown' } }), null)
  assert.equal(docVersionHashFromRecord({ props: { commitHash: 'abcdef1' } }), 'abcdef1')
})
