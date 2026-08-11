import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  SHAPE_RENDER_ERROR_EVENT,
  errorFromShapeRenderEvent,
  shapeRenderErrorMessage,
} from '../src/shape-error-surface.ts'

test('shape render error events produce the app error-screen message', () => {
  assert.equal(
    shapeRenderErrorMessage({ shapeType: 'fleet-chat', message: 'boom' }),
    'Shape fleet-chat crashed: boom',
  )

  const error = errorFromShapeRenderEvent(new CustomEvent(SHAPE_RENDER_ERROR_EVENT, {
    detail: {
      shapeType: 'fleet-chat',
      message: 'boom',
      stack: 'Error: boom',
      componentStack: 'at FleetChat',
    },
  }))
  assert.equal(error?.message, 'Shape fleet-chat crashed: boom')
  assert.equal(error?.stack, 'Error: boom')
})

test('shape boundary feeds the existing app error boundary surface', () => {
  const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const svgSource = readFileSync(new URL('../src/SvgDocument.tsx', import.meta.url), 'utf8')

  assert.match(appSource, /window\.addEventListener\(SHAPE_RENDER_ERROR_EVENT, this\.handleShapeRenderError\)/)
  assert.match(appSource, /this\.setState\(\{ hasError: true, error \}\)/)
  assert.match(appSource, /<div className="ErrorScreen">/)
  assert.match(svgSource, /dispatchShapeRenderError\(detail\)/)
})
