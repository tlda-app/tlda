import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

// The relation the local layer rests on, checked against the REAL documents a
// running tlda serves: the solutions chapter, and a real submission to it.
//
// Fetched at run time rather than copied into the repo. AGENTS.md forbids both
// halves of the alternative — "NEVER SAVE A COPY" and "Stop making fixtures ...
// a fixture exercises a path no user is on, so every verdict reached on it
// measures the fixture". So this reads what the app itself would read, and when
// no server is up it says so and skips rather than quietly measuring nothing.
//
// This is a DIAGNOSTIC. The verdict on the feature is the chapter open in the
// app with the paging control on its callouts. What this can do that the
// browser cannot do quickly is fail precisely: if a build renames an anchor, or
// a submission renders without its answer blocks, an instructor sees a callout
// that pages through nothing, and the cause is one line here instead of an
// afternoon.

const BASE = process.env.TLDA_TEST_SERVER || 'https://localhost:5190'
const COURSE = process.env.TLDA_TEST_COURSE || 'qtm285'
const ASSIGNMENT = process.env.TLDA_TEST_ASSIGNMENT || 'week1-homework'

// The test server is a local HTTPS listener with a self-signed certificate.
// Scoped to this process and stated, rather than left as an ambient surprise.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

async function getJson(path) {
  const response = await fetch(`${BASE}${path}`)
  if (!response.ok) throw new Error(`GET ${path} → HTTP ${response.status}`)
  return response.json()
}

async function firstPageDocument(docKey) {
  const base = `/docs/${encodeURIComponent(docKey)}/`
  const pages = await getJson(`${base}page-info.json`)
  const file = pages[0]?.file
  if (!file) throw new Error(`${docKey} has no rendered page`)
  const response = await fetch(`${BASE}${base}${file}`)
  if (!response.ok) throw new Error(`GET ${base}${file} → HTTP ${response.status}`)
  return new JSDOM(await response.text()).window.document
}

/**
 * The chapter and one real submission to it, or the reason there are none.
 *
 * Every failure to reach the data comes back as a skip carrying what was tried
 * and what answered, because the reader of that message is the one who does not
 * know which server is up.
 */
async function liveDocuments() {
  try {
    const view = await getJson(`/api/classroom/assignments/${encodeURIComponent(ASSIGNMENT)}/problems`)
    const solutionsDocKey = view.assignment?.solutionsDocKey
    if (!solutionsDocKey) return { skip: `${ASSIGNMENT} on ${BASE} has no solutionsDocKey` }
    const answer = view.problems.flatMap(problem => problem.answers)[0]
    if (!answer) return { skip: `${ASSIGNMENT} on ${BASE} has no submissions to pair` }
    return {
      solution: await firstPageDocument(solutionsDocKey),
      answer: await firstPageDocument(answer.contentRef),
      who: `${answer.displayName} (${answer.contentRef})`,
      solutionsDocKey,
    }
  } catch (error) {
    return { skip: `No live course data at ${BASE} for ${COURSE}/${ASSIGNMENT}: ${error.message}` }
  }
}

const live = await liveDocuments()
const skip = live.skip || false

function precedingExerciseId(solution, solutionDocument) {
  const NodeCtor = solutionDocument.defaultView.Node
  let found = null
  for (const exercise of solutionDocument.querySelectorAll('[id^="exr-"]')) {
    if (exercise.compareDocumentPosition(solution) & NodeCtor.DOCUMENT_POSITION_FOLLOWING) found = exercise.id
  }
  return found
}

test('every solution callout in the chapter resolves to an exercise', { skip }, () => {
  const callouts = [...live.solution.querySelectorAll('.callout.callout-solution')]
  assert.ok(callouts.length > 0, `${live.solutionsDocKey} has no solution callouts at all`)
  const unresolved = callouts.filter(callout => !precedingExerciseId(callout, live.solution))
  assert.deepEqual(unresolved.map(c => c.outerHTML.slice(0, 80)), [], 'solution callouts with no preceding exercise id')
})

test('every exercise in the chapter has a matching answer block in the submission', { skip }, () => {
  const exercises = [...live.solution.querySelectorAll('[id^="exr-"]')].map(element => element.id)
  assert.ok(exercises.length > 0, `${live.solutionsDocKey} has no exercises`)
  const missing = exercises.filter(id => !live.answer.getElementById(`ans-${id}`))
  assert.deepEqual(missing, [], `exercises with no answer block in ${live.who}`)
})

test('the answer blocks carry content, not just an empty shell', { skip }, () => {
  const empty = [...live.solution.querySelectorAll('[id^="exr-"]')]
    .map(element => live.answer.getElementById(`ans-${element.id}`))
    .filter(block => block && block.textContent.trim().length === 0)
  assert.deepEqual(empty.map(block => block.id), [], `answer blocks that would pair as visibly empty in ${live.who}`)
})

// The control: the same check aimed at an exercise id that is not in the
// submission must fail. Without it a green run above could equally mean the
// lookup always answers yes.
test('the pairing check can fail', { skip }, () => {
  assert.equal(live.answer.getElementById('ans-exr-not-a-real-exercise'), null)
  const exercises = [...live.solution.querySelectorAll('[id^="exr-"]')].map(element => element.id)
  const withOneBogus = [...exercises, 'exr-not-a-real-exercise']
  const missing = withOneBogus.filter(id => !live.answer.getElementById(`ans-${id}`))
  assert.deepEqual(missing, ['exr-not-a-real-exercise'], 'the missing-answer check did not detect a known-absent answer')
})
