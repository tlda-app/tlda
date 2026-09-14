import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

// tldraw opens an internal MessagePort when its runtime is imported. Capture
// only the handles this dynamic import introduces, then close them so the Node
// test worker finishes naturally instead of timing out.
const handlesBeforeTldraw = new Set((process as any)._getActiveHandles())
const { pairMarkedExerciseCallouts } = await import('../src/classroom/useMarkedExerciseHtmlAlignment')
const tldrawHandles = (process as any)._getActiveHandles().filter((h: any) => !handlesBeforeTldraw.has(h))
after(() => {
  for (const handle of tldrawHandles) {
    if (handle.constructor?.name === 'MessagePort' && 'close' in handle) handle.close()
  }
})

/**
 * What the return value means, and why it is not the number of pairs created.
 *
 * The caller hides the official-solution pane when this is above zero and puts
 * it back when it is zero, so the question it is answering is "is a pairing on
 * screen" — asked again every 250ms against the same document.
 *
 * Pairing is idempotent: an answer already inside a pair is skipped. So a count
 * of additions is right once and wrong on every repeat, which would take the
 * solution pane away and hand it back a quarter-second later while the pairing
 * sat there the whole time.
 */

const STUDENT = `
  <div id="exr-a">question a</div>
  <div id="ans-exr-a">the student's answer to a</div>
  <div id="exr-b">question b</div>
  <div id="ans-exr-b">the student's answer to b</div>
`

// Only exercise a has a solution: b is the unmatched problem.
const SOLUTIONS = `
  <div id="exr-a">question a</div>
  <div class="callout callout-solution">
    <div class="callout-header"></div>
    <div class="callout-collapse">the instructor's solution to a</div>
  </div>
  <div id="exr-b">question b</div>
`

function documents() {
  const student = new JSDOM(`<!doctype html><html><head></head><body>${STUDENT}</body></html>`)
  const solutions = new JSDOM(`<!doctype html><html><head></head><body>${SOLUTIONS}</body></html>`)
  return { student: student.window.document, solutions: solutions.window.document }
}

test('a repeat pass over an already-paired document still reports the pairing', () => {
  const { student, solutions } = documents()
  const pair = (id: string) => pairMarkedExerciseCallouts(student, solutions, 'https://example.com/s.html', id)

  assert.equal(pair('exr-a'), 1, 'the first pass pairs exercise a')
  assert.equal(pair('exr-a'), 1, 'the repeat pass adds nothing but the pairing is still there')
})

test('the marking journey, matched to matched to unmatched and back', () => {
  const { student, solutions } = documents()
  const pair = (id: string) => pairMarkedExerciseCallouts(student, solutions, 'https://example.com/s.html', id)

  assert.equal(pair('exr-a'), 1, 'matched')
  assert.equal(pair('exr-a'), 1, 'same problem again — the pane must stay hidden')
  assert.equal(pair('exr-b'), 0, 'exercise b has no solution, so the pane must come back')
  assert.equal(pair('exr-a'), 1, 'back to a — paired again')
})

test('leaving an exercise takes its pair apart and leaves the answer in place', () => {
  const { student, solutions } = documents()
  pairMarkedExerciseCallouts(student, solutions, 'https://example.com/s.html', 'exr-a')
  pairMarkedExerciseCallouts(student, solutions, 'https://example.com/s.html', 'exr-b')

  assert.equal(student.querySelectorAll('.tlda-marked-exercise-callout-pair').length, 0)
  assert.ok(student.getElementById('ans-exr-a'), "the student's answer survives unpairing")
})
