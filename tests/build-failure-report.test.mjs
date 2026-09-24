import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BUILD_FAILURE_SHAPE_TYPE,
  dispatchBuildFailureReport,
  isBuildFailureReport,
  shapeRenderErrorMessage,
} from '../src/shape-error-surface.ts'

// A failed newest build over a still-served older render reports through the
// existing shape-error event plumbing: the same event, the same log channel,
// no bespoke surface. The report is recorded, not shown — the stale pages
// stay up, and only a render crash takes the screen.

test('a build-failure report classifies apart from a render crash', () => {
  assert.equal(
    isBuildFailureReport({ shapeType: BUILD_FAILURE_SHAPE_TYPE, message: 'x' }),
    true,
  )
  assert.equal(
    isBuildFailureReport({ shapeType: 'html-page', message: 'x' }),
    false,
  )
  assert.equal(isBuildFailureReport(null), false)
  assert.equal(isBuildFailureReport({}), false)
})

test('a build-failure report reads as a build failure, not a crash', () => {
  assert.equal(
    shapeRenderErrorMessage({ shapeType: BUILD_FAILURE_SHAPE_TYPE, message: 'DVI file not created' }),
    'Build failed: DVI file not created',
  )
  assert.equal(
    shapeRenderErrorMessage({ shapeType: 'html-page', message: 'boom' }),
    'Shape html-page crashed: boom',
  )
})

test('dispatching a build-failure report emits the shape-error event', () => {
  // The module talks to window or no-ops; stand in a minimal emitter.
  const listeners = {}
  const realWindow = globalThis.window
  globalThis.window = {
    addEventListener: (type, handler) => { (listeners[type] ??= []).push(handler) },
    removeEventListener: (type, handler) => {
      listeners[type] = (listeners[type] || []).filter(entry => entry !== handler)
    },
    dispatchEvent: event => { for (const handler of listeners[event.type] || []) handler(event) },
  }
  const seen = []
  const handler = event => seen.push(event.detail)
  window.addEventListener('tlda-shape-render-error', handler)
  try {
    dispatchBuildFailureReport('executor revision mismatch')
  } finally {
    window.removeEventListener('tlda-shape-render-error', handler)
    if (realWindow === undefined) delete globalThis.window
    else globalThis.window = realWindow
  }
  assert.equal(seen.length, 1)
  assert.equal(seen[0].shapeType, BUILD_FAILURE_SHAPE_TYPE)
  assert.equal(seen[0].message, 'executor revision mismatch')
})
