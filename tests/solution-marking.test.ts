/**
 * The arrows on a solution callout, and what paging does to the chapter.
 *
 * These assertions are all structure and state. jsdom has no layout, so
 * nothing here can tell you the answer sits in the margin with its top aligned
 * or that a photograph fits its callout — those are checked on the rendered
 * chapter in the app, and a green run here is not evidence of them.
 */
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import type { MarkableAnswer } from '../src/classroom/solutionMarking'

// Imported the same way its sibling test imports the module it covers: a
// top-level dynamic import, which is what makes vitest treat this file as a
// suite rather than reporting "no test suite found" while node:test happily
// prints ticks beside it.
const { installSolutionMarking, exerciseIdForSolution } = await import('../src/classroom/solutionMarking')

// Each chapter gets its own JSDOM rather than a bare `createHTMLDocument`,
// because a document made that way has no `defaultView` — and the code under
// test reaches through it for `Node`, exactly as it does in the browser.
const windows: JSDOM[] = []
before(() => {})
after(() => { for (const w of windows) w.window.close() })

// The shape the course's own `solution-callout.lua` produces: the exercise
// callout, then the solution callout after it, with a header to hang arrows on.
const CHAPTER = `
  <div id="exr-a" class="callout callout-exercise"><p>question a</p></div>
  <div class="callout callout-solution"><div class="callout-header">Solution</div><p>solution a</p></div>
  <div id="exr-b" class="callout callout-exercise"><p>question b</p></div>
  <div class="callout callout-solution"><div class="callout-header">Solution</div><p>solution b</p></div>
`

function chapter() {
  const jsdom = new JSDOM(`<!doctype html><html><head></head><body>${CHAPTER}</body></html>`)
  windows.push(jsdom)
  return jsdom.window.document
}

function answersFor(doc: Document, names: string[]): (id: string) => Promise<MarkableAnswer[]> {
  return async () => names.map(name => ({
    studentId: name,
    displayName: name,
    contentRef: `submission-${name}`,
    // Loaded when that student is shown, which is what the arrows do.
    load: async () => {
      const element = doc.createElement('div')
      element.className = 'callout callout-answer'
      element.textContent = `${name}'s answer`
      return element
    },
  }))
}

test('a solution callout is matched to the exercise above it', () => {
  const doc = chapter()
  const [first, second] = doc.querySelectorAll<HTMLElement>('.callout-solution')
  assert.equal(exerciseIdForSolution(first, doc), 'exr-a')
  assert.equal(exerciseIdForSolution(second, doc), 'exr-b')
})

test('arrows arrive on every solution, and start at no answer with no pair', () => {
  const doc = chapter()
  const { installed } = installSolutionMarking(doc, { answersFor: answersFor(doc, ['ana']) })

  assert.equal(installed, 2, 'both solutions carry arrows')
  assert.equal(doc.querySelectorAll('.tlda-marking-arrows').length, 2)
  assert.equal(doc.querySelectorAll('.tlda-marking-pair').length, 0, 'position zero forms no pair')
  const label = doc.querySelector('.tlda-marking-arrows .tlda-marking-arrows-label')
  assert.equal(label?.textContent, 'no answer')
  assert.equal(doc.querySelector<HTMLButtonElement>('.tlda-marking-arrows button')?.disabled, true, 'back is dead at zero')
})

test('a late callout header does not acquire a second pager', () => {
  const jsdom = new JSDOM('<!doctype html><html><head></head><body><div id="exr-a"></div><div class="callout-solution">solution</div></body></html>')
  windows.push(jsdom)
  const doc = jsdom.window.document
  installSolutionMarking(doc, { answersFor: answersFor(doc, ['ana']) })
  const solution = doc.querySelector<HTMLElement>('.callout-solution')!
  const header = doc.createElement('div')
  header.className = 'callout-header'
  solution.prepend(header)

  const second = installSolutionMarking(doc, { answersFor: answersFor(doc, ['ana']) })

  assert.equal(second.installed, 0)
  assert.equal(solution.querySelectorAll('.tlda-marking-arrows').length, 1)
})

test('Quarto callout body markup does not acquire a second pager', () => {
  const jsdom = new JSDOM(`<!doctype html><html><head></head><body>
    <div id="exr-a"></div>
    <div class="callout callout-solution">
      <div class="callout-header">Solution</div>
      <div class="callout-body-container callout-body">
        <div class="callout-solution">solution body</div>
      </div>
    </div>
  </body></html>`)
  windows.push(jsdom)
  const doc = jsdom.window.document

  const result = installSolutionMarking(doc, { answersFor: answersFor(doc, ['ana']) })

  assert.equal(result.installed, 1)
  assert.equal(doc.querySelectorAll('.tlda-marking-arrows').length, 1)
  assert.equal(doc.querySelector('.callout-header .tlda-marking-arrows')?.textContent, '‹no answer›')
})

test('paging forward pairs one answer with its own solution, and back removes it again', async () => {
  const doc = chapter()
  installSolutionMarking(doc, { answersFor: answersFor(doc, ['ana', 'bo']) })
  const arrows = doc.querySelectorAll('.tlda-marking-arrows')[0]
  const [back, forward] = arrows.querySelectorAll<HTMLButtonElement>('button')

  forward.click()
  await new Promise(resolve => setTimeout(resolve, 5))

  const pairs = doc.querySelectorAll('.tlda-marking-pair')
  assert.equal(pairs.length, 1, 'only the solution he paged forms a pair')
  assert.equal(pairs[0].querySelectorAll('.tlda-marking-answer').length, 1)
  assert.match(pairs[0].querySelector('.tlda-marking-answer')!.textContent!, /ana/)
  assert.equal(arrows.querySelector('.tlda-marking-arrows-label')?.textContent, 'ana 1/2')
  // The solution is moved, not copied — one of it, still the chapter's own.
  assert.equal(doc.querySelectorAll('.callout-solution').length, 2)

  back.click()
  await new Promise(resolve => setTimeout(resolve, 5))

  assert.equal(doc.querySelectorAll('.tlda-marking-pair').length, 0, 'back to zero leaves no wrapper behind')
  assert.equal(doc.querySelectorAll('.callout-solution').length, 2)
  assert.equal(arrows.querySelector('.tlda-marking-arrows-label')?.textContent, 'no answer')
})

// OPENING ON THE STUDENT THE GRADEBOOK NAMED.
//
// The gradebook link is one student's cell. Landing at "no student's answer"
// throws away the only thing that link said and makes him page back to the
// person he had already chosen.
test('a named student is already paired when the chapter opens', async () => {
  const doc = chapter()
  installSolutionMarking(doc, { answersFor: answersFor(doc, ['ana', 'bo']), openAt: 'bo' })
  await new Promise(resolve => setTimeout(resolve, 5))

  const arrows = doc.querySelectorAll('.tlda-marking-arrows')[0]
  assert.equal(arrows.querySelector('.tlda-marking-arrows-label')?.textContent, 'bo 2/2')
  const pairs = doc.querySelectorAll('.tlda-marking-pair')
  assert.equal(pairs.length, 2, 'every solution opens on the named student, not only the first')
  assert.match(pairs[0].querySelector('.tlda-marking-answer')!.textContent!, /bo/)
  // Not the first answer in the list, or this would pass against an install that
  // simply stepped forward once.
  assert.doesNotMatch(pairs[0].querySelector('.tlda-marking-answer')!.textContent!, /ana/)
})

test('a student nobody answered with leaves the arrows where they were', async () => {
  const doc = chapter()
  installSolutionMarking(doc, { answersFor: answersFor(doc, ['ana', 'bo']), openAt: 'nobody' })
  await new Promise(resolve => setTimeout(resolve, 5))

  const arrows = doc.querySelectorAll('.tlda-marking-arrows')[0]
  assert.equal(arrows.querySelector('.tlda-marking-arrows-label')?.textContent, 'no answer')
  assert.equal(doc.querySelectorAll('.tlda-marking-pair').length, 0)
})

// The default is unchanged, and this is what says so: he opens the chapter to
// read it far more often than to mark one person.
test('no named student still opens at no answer', async () => {
  const doc = chapter()
  installSolutionMarking(doc, { answersFor: answersFor(doc, ['ana', 'bo']) })
  await new Promise(resolve => setTimeout(resolve, 5))

  const arrows = doc.querySelectorAll('.tlda-marking-arrows')[0]
  assert.equal(arrows.querySelector('.tlda-marking-arrows-label')?.textContent, 'no answer')
  assert.equal(doc.querySelectorAll('.tlda-marking-pair').length, 0)
})

test('removing the marking leaves the chapter as it was found', async () => {
  const doc = chapter()
  const before = doc.body.innerHTML
  const { remove } = installSolutionMarking(doc, { answersFor: answersFor(doc, ['ana']) })
  const forward = doc.querySelectorAll<HTMLButtonElement>('.tlda-marking-arrows button')[1]
  forward.click()
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(doc.querySelectorAll('.tlda-marking-pair').length, 1)

  remove()

  assert.equal(doc.querySelectorAll('.tlda-marking-arrows').length, 0)
  assert.equal(doc.querySelectorAll('.tlda-marking-pair').length, 0)
  assert.equal(doc.body.innerHTML, before, 'the chapter is byte-identical to before marking')
})

test('an exercise nobody answered leaves the arrows at zero rather than failing', async () => {
  const doc = chapter()
  installSolutionMarking(doc, { answersFor: async () => [] })
  const forward = doc.querySelectorAll<HTMLButtonElement>('.tlda-marking-arrows button')[1]

  forward.click()
  await new Promise(resolve => setTimeout(resolve, 5))

  assert.equal(doc.querySelectorAll('.tlda-marking-pair').length, 0)
  assert.equal(doc.querySelector('.tlda-marking-arrows-label')?.textContent, 'no answer')
})

test('a slow answer that lands after he has paged on does not appear', async () => {
  // He pages faster than the network. Without the guard, the first student's
  // answer resolves late and is pasted beside the solution he has already moved
  // past — one student's work shown under another's name, which is the worst
  // failure this surface has available to it.
  const doc = chapter()
  const delays: Record<string, number> = { ana: 40, bo: 0 }
  installSolutionMarking(doc, {
    answersFor: async () => ['ana', 'bo'].map(name => ({
      studentId: name,
      displayName: name,
      contentRef: `submission-${name}`,
      load: async () => {
        await new Promise(resolve => setTimeout(resolve, delays[name]))
        const element = doc.createElement('div')
        element.className = 'callout callout-answer'
        element.textContent = `${name}'s answer`
        return element
      },
    })),
  })
  const arrows = doc.querySelectorAll('.tlda-marking-arrows')[0]
  const [, forward] = arrows.querySelectorAll<HTMLButtonElement>('button')

  forward.click()   // ana, slow
  await new Promise(resolve => setTimeout(resolve, 5))
  forward.click()   // bo, fast — lands first
  await new Promise(resolve => setTimeout(resolve, 80))

  const shown = doc.querySelector('.tlda-marking-answer')
  assert.ok(shown, 'somebody is shown')
  assert.match(shown!.textContent!, /bo/, 'the student he is on, not the one he paged past')
  assert.equal(doc.querySelectorAll('.tlda-marking-answer').length, 1, 'and only one of them')
})

test("the answer carries the student's name on itself, not only in the pager", async () => {
  // He is marking one student among forty. The name has to be beside the work
  // while he reads it, not in a control he glanced at a moment ago.
  const doc = chapter()
  installSolutionMarking(doc, { answersFor: answersFor(doc, ['ana', 'bo']) })
  const forward = doc.querySelectorAll<HTMLButtonElement>('.tlda-marking-arrows button')[1]

  forward.click()
  await new Promise(resolve => setTimeout(resolve, 5))

  const header = doc.querySelector('.tlda-marking-answer > .tlda-marking-answer-header')
  assert.equal(header?.textContent, 'ana')
  // And it moves with the paging rather than sticking to the first student.
  forward.click()
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(doc.querySelector('.tlda-marking-answer > .tlda-marking-answer-header')?.textContent, 'bo')
  assert.equal(doc.querySelectorAll('.tlda-marking-answer-header').length, 1, 'one name, not an accumulating pile')
})
