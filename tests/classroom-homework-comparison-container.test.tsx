/**
 * What the comparison workspace must actually put on the page.
 *
 * The existing routing test reads `HomeworkComparisonWorkspace.tsx` as text and
 * asserts that certain class names appear in it. That cannot fail for the thing
 * it names: a file can contain `classroomComparisonSubmissions` while rendering
 * no student, the wrong student, or the same student twice. This test renders
 * the component and reads the resulting DOM, so a roster that loses, duplicates,
 * or misidentifies a submission fails it.
 *
 * The payload is shaped to the measured pic-dev `week1-homework` record: a
 * canonical source key reaching the page through `solutionsDocKey`, a roster
 * mixing named and login-only identities, and a student who has not submitted.
 */
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// The component imports its stylesheet the way the bundler expects. Node has no
// loader for that, so stand one in: the test is about the rendered DOM, not the
// styling, and without this the import fails before any assertion runs.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export default {}' }
    return nextLoad(url, context)
  },
})

type Roster = { id: string; displayName: string; universityLogin?: string; contentRef?: string }[]

const ASSIGNMENT = 'week1-homework'
const SOLUTION_KEY = 'qtm285-week1-homework-source'

function statusPayload(roster: Roster) {
  return {
    course: { id: 'qtm285', title: 'QTM 285' },
    assignments: [{
      id: ASSIGNMENT,
      courseId: 'qtm285',
      title: 'Week 1 homework',
      dueAt: '2026-09-15T04:00:00.000Z',
      solutionsDocKey: SOLUTION_KEY,
      solutionsVersion: 'b95e9df',
      sourceDocKey: SOLUTION_KEY,
    }],
    rows: roster.map(student => ({
      id: student.id,
      displayName: student.displayName,
      universityLogin: student.universityLogin,
      layerScope: 'student',
      assignments: [{
        assignmentId: ASSIGNMENT,
        state: student.contentRef ? 'ungraded' : 'not-submitted',
        studentId: student.id,
        contentRef: student.contentRef,
      }],
    })),
    counts: {},
    viewer: { role: 'instructor' },
  }
}

async function renderComparison(roster: Roster) {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<div id="root"></div>', {
    url: `https://example.invalid/?workspace=classroom-comparison&course=qtm285&assignment=${ASSIGNMENT}`,
  })
  const requested: string[] = []
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (input: string) => {
      const url = String(input)
      requested.push(url)
      if (url.includes('/api/classroom/')) {
        return new Response(JSON.stringify(statusPayload(roster)), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.endsWith('page-info.json')) {
        return new Response(JSON.stringify([{ file: 'index.html' }]), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('{}', { status: 404 })
    },
  })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {} } })
  const react = await import('react')
  const { act, createElement } = react
  // The bundler configures the automatic JSX runtime; this runner compiles to
  // classic `React.createElement`, so the component needs React in scope.
  Object.assign(globalThis, { React: react })
  const { createRoot } = await import('react-dom/client')
  const { HomeworkComparisonWorkspace } = await import('../src/classroom/HomeworkComparisonWorkspace')
  const root = createRoot(dom.window.document.getElementById('root')!)
  await act(async () => root.render(createElement(HomeworkComparisonWorkspace)))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return { document: dom.window.document, requested, cleanup: () => { root.unmount(); dom.window.close() } }
}

const CLASS_ROSTER: Roster = [
  { id: 'stu-ana', displayName: 'Ana Ruiz', universityLogin: 'aruiz', contentRef: 'qtm285-week1-ana' },
  { id: 'stu-ben', displayName: 'Ben Okafor', universityLogin: 'bokafor', contentRef: 'qtm285-week1-ben' },
  { id: 'stu-cai', displayName: 'Cai Zhang', contentRef: 'qtm285-week1-cai' },
  { id: 'stu-dee', displayName: 'Dee Patel', universityLogin: 'dpatel' },
]

test('one container holds the official solution and every submitted student exactly once', async () => {
  const { document, cleanup } = await renderComparison(CLASS_ROSTER)
  try {
    const containers = document.querySelectorAll(`[data-homework-comparison="${ASSIGNMENT}"]`)
    assert.equal(containers.length, 1, 'there must be exactly one comparison container')
    const container = containers[0]

    // One logical container, both halves inside it — this is the layout Skip named.
    const solution = container.querySelector('.classroomComparisonSolution')
    const stack = container.querySelector('.classroomComparisonSubmissions')
    assert.ok(solution, 'the official solution pane must be inside the container')
    assert.ok(stack, 'the student stack must be inside the container')

    const solutionFrame = solution!.querySelector('iframe')
    assert.ok(solutionFrame, 'the official solution must actually render a document')
    assert.match(solutionFrame!.getAttribute('src')!, new RegExp(`/docs/${SOLUTION_KEY}/`),
      'the solution pane must resolve the assignment’s canonical document')

    const articles = [...stack!.querySelectorAll('article')]
    const shown = articles.map(article => article.getAttribute('data-student-id'))
    assert.deepEqual(shown, ['stu-ana', 'stu-ben', 'stu-cai'],
      'every submitting student appears once, in roster order, and the non-submitter does not appear')
    assert.equal(new Set(shown).size, shown.length, 'no student appears twice')

    // Correctly identified: the name is on the card, and the login when there is one.
    const ana = articles[0]
    assert.match(ana.textContent!, /Ana Ruiz/)
    assert.match(ana.textContent!, /aruiz/)
    assert.match(articles[2].textContent!, /stu-cai/, 'a student with no login falls back to their id, not to blank')

    // Each card renders that student's own work, beside the solution.
    for (const [index, article] of articles.entries()) {
      const frame = article.querySelector('iframe')
      assert.ok(frame, `submission ${index} must render a document`)
      assert.match(frame!.getAttribute('src')!, new RegExp(`/docs/${CLASS_ROSTER[index].contentRef}/`))
      const marking = article.querySelector('a[href*="markingStudent"]')
      assert.ok(marking, 'each submission keeps its marking-canvas route')
      assert.match(marking!.getAttribute('href')!, new RegExp(`markingStudent=${CLASS_ROSTER[index].id}`))
    }
  } finally { cleanup() }
})

test('positive control: the assertions fail when the roster loses or duplicates a submission', async () => {
  const dropped = CLASS_ROSTER.filter(student => student.id !== 'stu-ben')
  const { document: missing, cleanup: cleanupMissing } = await renderComparison(dropped)
  try {
    const shown = [...missing.querySelectorAll('.classroomComparisonSubmissions article')]
      .map(article => article.getAttribute('data-student-id'))
    assert.deepEqual(shown, ['stu-ana', 'stu-cai'])
    assert.notDeepEqual(shown, ['stu-ana', 'stu-ben', 'stu-cai'],
      'the instrument must notice a missing submission')
  } finally { cleanupMissing() }

  const duplicated = [...CLASS_ROSTER, { id: 'stu-ana-dup', displayName: 'Ana Ruiz', universityLogin: 'aruiz', contentRef: 'qtm285-week1-ana' }]
  const { document: twice, cleanup: cleanupTwice } = await renderComparison(duplicated)
  try {
    const logins = [...twice.querySelectorAll('.classroomComparisonSubmissions article')]
      .map(article => article.textContent!.includes('aruiz'))
      .filter(Boolean)
    assert.equal(logins.length, 2, 'the instrument must notice the same student rendered twice')
  } finally { cleanupTwice() }
})
