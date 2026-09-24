import test from 'node:test'
import assert from 'node:assert/strict'

import { surfaceServesPublishRawApp } from './publish-capability.mjs'

test('a surface advertising the raw-app route serves the canvas half', () => {
  assert.equal(surfaceServesPublishRawApp({ files: [], publishRawApp: true }), true)
})

test('anything else is a surface the preview publish refuses', () => {
  assert.equal(surfaceServesPublishRawApp({ files: [] }), false)
  assert.equal(surfaceServesPublishRawApp({ files: [], publishRawApp: false }), false)
  assert.equal(surfaceServesPublishRawApp({ files: [], publishRawApp: 'yes' }), false)
  assert.equal(surfaceServesPublishRawApp(null), false)
  assert.equal(surfaceServesPublishRawApp(undefined), false)
})
