import assert from 'node:assert/strict'
import test from 'node:test'
import { NO_BUILD, rowState, span } from '../src/panels/tocRowState.ts'

const EDITED = Date.parse('2026-09-19T11:47:00Z')
const RENDERED = Date.parse('2026-09-19T11:48:00Z')

const QUIET = NO_BUILD
const FAILED = { status: 'error', lastBuild: '2026-09-19T11:50:00.000Z', logModified: '2026-09-19T11:54:00.000Z' }
const RUNNING = { status: 'building', lastBuild: '2026-09-19T11:50:00.000Z', logModified: null }
const CANCELLED = { status: 'cancelled', lastBuild: '2026-09-19T11:50:00.000Z', logModified: '2026-09-19T11:51:00.000Z' }

const CURRENT_ROW = {
  stage: 'preview',
  why: 'on preview, not yet on the class site',
  currency: 'current',
  sourceEditedAt: EDITED,
  renderedAt: RENDERED,
  behindMs: null,
  flipMs: RENDERED - EDITED,
}

// The order is the order things go wrong in: a build that did not succeed,
// then a page the build never wrote, then a page older than its source, then a
// build still running, and only then the class site.

test('a build that did not succeed is red with a caution glyph and names no cause', () => {
  const state = rowState(CURRENT_ROW, FAILED)
  assert.equal(state.light, 'red')
  assert.equal(state.caution, true)
  assert.match(state.title, /did not succeed/)
  assert.match(state.title, /does not record why/)
  assert.equal(state.timing, null)
})

test('a cancelled build is not drawn as a failure — the row falls through to its render', () => {
  const state = rowState(CURRENT_ROW, CANCELLED)
  assert.equal(state.light, 'preview')
  assert.equal(state.caution, false)
})

test('a page nothing rendered is red, with the edit time when there is one', () => {
  const state = rowState(
    { stage: null, why: '', currency: 'unrendered', sourceEditedAt: EDITED, renderedAt: null, behindMs: null, flipMs: null },
    QUIET,
  )
  assert.equal(state.light, 'red')
  assert.equal(state.caution, true)
  assert.match(state.title, /No render of this page exists/)
  assert.match(state.title, /edited/)
})

test('a stale page is yellow with how far behind it is, on the row and in the sentence', () => {
  const behindMs = 4 * 3600_000 + 12 * 60_000
  const state = rowState(
    { stage: 'here-only', why: 'not on preview yet', currency: 'stale', sourceEditedAt: EDITED, renderedAt: EDITED - behindMs, behindMs, flipMs: null },
    QUIET,
  )
  assert.equal(state.light, 'yellow')
  assert.equal(state.caution, true)
  assert.equal(state.timing, '4h 12m behind')
  assert.match(state.title, /Older than what you wrote/)
  assert.match(state.title, /4h 12m behind/)
})

test('a build in flight is yellow without caution, and the failed build beats it', () => {
  const running = rowState(CURRENT_ROW, RUNNING)
  assert.equal(running.light, 'yellow')
  assert.equal(running.caution, false)
  assert.match(running.title, /A build is running/)
  const failed = rowState(
    { ...CURRENT_ROW, currency: 'stale', behindMs: 60_000, flipMs: null },
    FAILED,
  )
  assert.equal(failed.light, 'red')
})

test('a quiet current row keeps its stage and carries the turnaround', () => {
  const state = rowState(CURRENT_ROW, QUIET)
  assert.equal(state.light, 'preview')
  assert.equal(state.caution, false)
  assert.match(state.title, /on preview, not yet on the class site/)
  assert.match(state.title, /Rendered 1m after you saved/)
  assert.equal(state.timing, '1m')
})

test('a turnaround past the window is not news — no span, no sentence', () => {
  const state = rowState({ ...CURRENT_ROW, flipMs: 7 * 24 * 3600_000 }, QUIET)
  assert.equal(state.light, 'preview')
  assert.equal(state.timing, null)
  assert.doesNotMatch(state.title, /after you saved/)
})

test('a row with no stage but a current render is green, stated weakly', () => {
  const state = rowState({ ...CURRENT_ROW, stage: null }, QUIET)
  assert.equal(state.light, 'green')
  assert.match(state.title, /Not detectably stale/)
})

test('a row with no stage and nothing current draws nothing', () => {
  assert.equal(rowState({ ...CURRENT_ROW, stage: null, currency: 'unknown' }, QUIET), null)
  assert.equal(rowState(undefined, QUIET), null)
})

test('spans read down a column', () => {
  assert.equal(span(5_000), '5s')
  assert.equal(span(61_000), '1m')
  assert.equal(span(63_000), '1m')
  assert.equal(span(4 * 3600_000 + 12 * 60_000), '4h 12m')
  assert.equal(span(26 * 3600_000), '1d 2h')
})
