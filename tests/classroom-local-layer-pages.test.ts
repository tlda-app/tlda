import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

import { readyPageDocuments } from '../src/classroom/localLayer'

// The rule that replaced `pages[0]`.
//
// The layer used to be handed `document.pages[0]?.shapeId` and could never look
// anywhere else, so marking worked only where the solutions happened to be the
// first page. On the 84-page course the classroom grades, page 0 is the index:
// no solution callouts, no controls, and paging did not help because nothing
// re-targeted. Skip: "DO NOT BUILD AROUND DESIGN FLAWS: NOBODY FUCKING ASKED
// FOR GRADING TO ONLY WORK ON SPECIAL GRADING PROJECTS."
//
// The verdict on the feature is still the chapter open in the app with a paging
// control on its callouts. What this holds is the one property that was wrong.

function mount(dom: JSDOM, shapeId: string, body: string | null) {
  const host = dom.window.document.createElement('div')
  host.setAttribute('data-shape-id', shapeId)
  const frame = dom.window.document.createElement('iframe')
  host.append(frame)
  dom.window.document.body.append(host)
  // A frame with no body models one that is still loading: `contentDocument`
  // exists and `body` is null, and handing that to the installer throws into
  // the error boundary.
  if (body === null) {
    Object.defineProperty(frame, 'contentDocument', { value: { body: null }, configurable: true })
    return frame
  }
  frame.contentDocument!.write(`<!doctype html><html><body>${body}</body></html>`)
  frame.contentDocument!.close()
  return frame
}

test('a solutions page that is not the first page is still found', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  mount(dom, 'shape:course-page-0', '<h1>Index</h1>')
  mount(dom, 'shape:course-page-9', '<div class="callout callout-solution" id="exr-count-n2">answer</div>')

  const found = readyPageDocuments(
    ['shape:course-page-0', 'shape:course-page-9'],
    dom.window.document,
    new Map(),
  )
  assert.equal(found.length, 2, 'both mounted pages are available to the layer')
  // The page carrying the solutions is reachable — the whole point.
  const withSolutions = found.filter(d => d.querySelector('.callout.callout-solution'))
  assert.equal(withSolutions.length, 1)
  assert.ok(withSolutions[0].getElementById('exr-count-n2'), 'the solutions page is the one found')

  // The control: bound to the first page, the solutions page is unreachable.
  const firstOnly = readyPageDocuments(['shape:course-page-0'], dom.window.document, new Map())
  assert.equal(firstOnly.length, 1)
  assert.equal(firstOnly[0].querySelector('.callout.callout-solution'), null,
    'page 0 carries no solutions — this is the state the old binding was stuck in')
})

test('a page still loading is skipped rather than handed over with a null body', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  mount(dom, 'shape:course-page-0', null)
  mount(dom, 'shape:course-page-9', '<div class="callout callout-solution">answer</div>')

  const found = readyPageDocuments(
    ['shape:course-page-0', 'shape:course-page-9'],
    dom.window.document,
    new Map(),
  )
  assert.equal(found.length, 1, 'the loading frame is not returned')
  assert.ok(found[0].querySelector('.callout.callout-solution'))
})

test('one shape mounted twice yields each distinct document once', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  // The grading surface mounts a page more than once — main canvas plus panes.
  mount(dom, 'shape:course-page-9', '<div class="callout callout-solution">a</div>')
  const second = mount(dom, 'shape:course-page-9', '<div class="callout callout-solution">a</div>')

  const found = readyPageDocuments(['shape:course-page-9'], dom.window.document, new Map())
  assert.equal(found.length, 2, 'both mounts are real documents and both get controls')

  // The registry names only the last writer, so it must not be the only source.
  const registryOnly = readyPageDocuments(
    ['shape:course-page-9'],
    new JSDOM('<!doctype html><html><body></body></html>').window.document,
    new Map([['shape:course-page-9', second as unknown as HTMLIFrameElement]]),
  )
  assert.equal(registryOnly.length, 1, 'the registry still contributes when the DOM has none')
})

// The pager shows answers, and a student who has not handed in has none.
//
// `problems()` returns a row per ENROLLED student, with `contentRef: null` for
// anyone who has not submitted. On the live course three of four are in that
// state, so the first press of → read "Fall Readiness Tester · 1 of 4" over no
// work and the app said "null has not finished rendering" — the feature reading
// as broken on first contact, because of who was in the list.
test('students who have not handed in are not in the pager', async () => {
  const { answersByExercise } = await import('../src/classroom/localLayer')
  const view = {
    problems: [{
      problemId: 'ans-exr-count-n2',
      answers: [
        { studentId: 'qtm285:fall-readiness-tester', displayName: 'Fall Readiness Tester', contentRef: null, gradingStatus: 'not-submitted' },
        { studentId: 'qtm285:fall-role-probe-read', displayName: 'Fall Role Probe read', contentRef: null, gradingStatus: 'not-submitted' },
        { studentId: 'qtm285:skipper', displayName: 'Skipper', contentRef: 'submission-week1-homework-qtm285:skipper', gradingStatus: 'ungraded' },
      ],
    }],
  }
  const grouped = answersByExercise(view as never)
  const answers = grouped.get('exr-count-n2')!
  assert.equal(answers.length, 1, 'only the student who handed in is pageable')
  assert.equal(answers[0].studentId, 'qtm285:skipper')
  // The key drops the `ans-` prefix, because the callouts are keyed by exercise.
  assert.ok(grouped.has('exr-count-n2'))
})

test('an exercise nobody has handed in yields an empty pager, not a phantom', async () => {
  const { answersByExercise, stepPosition, NO_ANSWER } = await import('../src/classroom/localLayer')
  const view = {
    problems: [{
      problemId: 'ans-exr-untouched',
      answers: [{ studentId: 'a', displayName: 'A', contentRef: null, gradingStatus: 'not-submitted' }],
    }],
  }
  const answers = answersByExercise(view as never).get('exr-untouched')!
  assert.equal(answers.length, 0)
  // An empty list steps to NO_ANSWER rather than to a student with no work.
  assert.equal(stepPosition(0, answers.length), NO_ANSWER)
})

// THE GUARD FOR THE DEFECT ITSELF, and the reason it is written against
// `installAcrossPages` rather than against the collection helper.
//
// The first version of this file tested only which documents were collected,
// while the traversal lived as a loop in the hook. Restricting that loop to the
// first document — `.slice(0, 1)`, exactly the bug — left the suite green,
// because nothing here reached the loop. A guard that cannot fail for the thing
// it guards is worse than no guard, because it gets cited.
test('a solution callout on the SECOND page still gets its control', async () => {
  const { installAcrossPages } = await import('../src/classroom/localLayer')
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  // Page 0 is the course index — no solutions, exactly as on qtm285-course.
  mount(dom, 'shape:course-page-0', '<h1>Prediction, Inference, and Causality</h1>')
  // The shape Quarto renders: `## Problem {#exr-count-n2}` becomes a heading
  // carrying the id, and the solution callout FOLLOWS it. `precedingExerciseId`
  // relates the two by document order, so a callout nested under the heading
  // would not resolve.
  mount(dom, 'shape:course-page-9', `
    <h2 id="exr-count-n2">Problem</h2>
    <div class="callout callout-solution"><div class="callout-header"></div>
      <div class="callout-body">worked solution</div>
    </div>`)

  const answers = new Map([['exr-count-n2', [
    { studentId: 'qtm285:skipper', displayName: 'Skipper', contentRef: 'submission-x', gradingStatus: 'ungraded' },
  ]]])
  const installed = installAcrossPages(
    ['shape:course-page-0', 'shape:course-page-9'],
    dom.window.document,
    new Map(),
    answers as never,
    new Map(),
    () => {},
  )

  assert.equal(installed.length, 2, 'both ready pages were installed into')
  const solutions = installed.find(d => d.querySelector('.callout.callout-solution'))!
  assert.ok(solutions, 'the solutions page is among them')
  // The control exists on the page that carries the solutions, which is not
  // page 0. Restrict the traversal to the first page and this goes red.
  assert.ok(
    solutions.querySelector('.tlda-local-layer-control'),
    'no control on the solutions page — the layer is bound to the wrong page again',
  )
  // And the index is left alone rather than decorated.
  const index = installed.find(d => d !== solutions)!
  assert.equal(index.querySelector('.tlda-local-layer-control'), null)
})

// The pairing half of the same defect, and its symptom is worse than a missing
// control: pairing against the wrong page makes the layer report that the
// student did not answer — a false claim about their work, produced by the
// layer's own scope. Restricting the pairing lookup to the first document used
// to pass this file 6/6, because the lookup lived in the hook where no test
// reached it.
test('an exercise whose solution is on a later page resolves to that page', async () => {
  const { installAcrossPages, resolveExercisePages } = await import('../src/classroom/localLayer')
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  mount(dom, 'shape:course-page-0', '<h1>Index</h1>')
  mount(dom, 'shape:course-page-9', `
    <h2 id="exr-count-n2">Problem</h2>
    <div class="callout callout-solution"><div class="callout-header"></div>
      <div class="callout-body">worked solution</div>
    </div>`)

  const shapeIds = ['shape:course-page-0', 'shape:course-page-9']
  const answers = new Map([['exr-count-n2', [
    { studentId: 'qtm285:skipper', displayName: 'Skipper', contentRef: 'submission-x', gradingStatus: 'ungraded' },
  ]]])
  // `data-tlda-solution-for` is stamped by the installer, so pairing can only
  // resolve a page that has been installed into — the real order of events.
  installAcrossPages(shapeIds, dom.window.document, new Map(), answers as never, new Map(), () => {})

  const pages = resolveExercisePages(shapeIds, dom.window.document, new Map(), ['exr-count-n2'])
  const page = pages.get('exr-count-n2')
  assert.ok(page, 'the exercise resolved to no page — pairing would report the student did not answer')
  assert.ok(page!.querySelector('[data-tlda-solution-for="exr-count-n2"]'))
  // It is the second page, not the index.
  assert.equal(page!.querySelector('h1')?.textContent ?? null, null)
})

test('an exercise on no mounted page resolves to nothing rather than to the wrong one', async () => {
  const { resolveExercisePages } = await import('../src/classroom/localLayer')
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  mount(dom, 'shape:course-page-0', '<h1>Index</h1>')

  const pages = resolveExercisePages(['shape:course-page-0'], dom.window.document, new Map(), ['exr-absent'])
  assert.equal(pages.size, 0, 'a missing exercise must not fall back to some other page')
})
