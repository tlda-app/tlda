import { classroomApi, type ProblemAnswer } from './api'

// The local layer: marking built into the solution chapter itself.
//
// Skip, 3:52 AM: "literally it's supposed to be a view *of the solution* where
// on each solution callout, there's a little button that lets me page through
// my students answers. It's just supposed to look like the ordinary solution
// chapter---it is the solution chapter---and it's not a mode. it's just like,
// if you're viewing the solution and you're an instructor, there's a marking
// affordance built in."
//
// So the page is the chapter, unchanged, and this adds one control per solution
// callout. There is no workspace, no shell and no second application: the
// existing `?workspace=classroom-problems` route returns from `App.tsx` before
// the app renders, which is the mode he ruled out.
//
// The direction is the opposite of `useMarkedExerciseHtmlAlignment`, and that
// is the whole difference between them. That hook clones the SOLUTION into the
// student's document, because its journey opens a student's submission. Here
// the solution document is what the instructor already has open, so the
// STUDENT'S ANSWER is what arrives. Same pairing, mirrored, and mirroring it is
// what makes the chapter the page rather than a thing copied out of.
//
// Skip, 4:06 AM, on the pair: "side-by-side alignment is a thing and it should
// be two callouts side-by-side with their tops aligned like, wrapped in a div
// or something so the page flows around the pair."

const PAIR_CLASS = 'tlda-local-layer-pair'
const CONTROL_CLASS = 'tlda-local-layer-control'
const STYLE_ID = 'tlda-local-layer-style'

/** No student's answer — the position every callout starts in. */
export const NO_ANSWER = -1

/**
 * Which exercise a solution callout belongs to.
 *
 * The same derivation `useMarkedExerciseHtmlAlignment` uses, and for the same
 * reason: Quarto anchors the heading (`## Problem 1 {#exr-hearts}` gives
 * `exr-hearts`) and the answer block inside it is `#ans-exr-hearts`, so the
 * exercise id is what relates the two documents.
 */
export function precedingExerciseId(solution: HTMLElement, solutionDocument: Document): string | null {
  const NodeCtor = solutionDocument.defaultView?.Node
  if (!NodeCtor) return null
  let found: string | null = null
  for (const exercise of solutionDocument.querySelectorAll<HTMLElement>('[id^="exr-"]')) {
    if (exercise.compareDocumentPosition(solution) & NodeCtor.DOCUMENT_POSITION_FOLLOWING) found = exercise.id
  }
  return found
}

function makeRelativeResourcesAbsolute(root: HTMLElement, baseUrl: string) {
  for (const element of root.querySelectorAll<HTMLElement>('[src], [href]')) {
    for (const attribute of ['src', 'href']) {
      const value = element.getAttribute(attribute)
      if (!value || value.startsWith('#')) continue
      element.setAttribute(attribute, new URL(value, baseUrl).href)
    }
  }
}

function ensureStyle(solutionDocument: Document) {
  if (solutionDocument.getElementById(STYLE_ID)) return
  const style = solutionDocument.createElement('style')
  style.id = STYLE_ID
  // Tops aligned, one grid, page flowing around the pair — his 4:06 AM words.
  //
  // The image rule is his 3:52 AM one: "pictures should be sized to fit in the
  // callouts by width ... obvs maintaining aspect ratio". A student's answer is
  // very often a photographed page, and at its natural size it covers the place
  // both callouts were meant to be.
  style.textContent = `
    .${PAIR_CLASS} {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 1rem;
      align-items: start;
      margin-block: 1rem;
    }
    .${PAIR_CLASS} > .callout,
    .${PAIR_CLASS} > .callout-answer { margin-block: 0; min-width: 0; }
    .${PAIR_CLASS} img { max-width: 100%; height: auto; padding-inline: 0.25rem; }
    .${CONTROL_CLASS} {
      display: flex; align-items: center; gap: 0.5rem;
      font-size: 0.85em; opacity: 0.85; margin-block-start: 0.35rem;
    }
    .${CONTROL_CLASS} button {
      font: inherit; line-height: 1; padding: 0.15rem 0.5rem; cursor: pointer;
    }
    .${CONTROL_CLASS} button[disabled] { cursor: default; opacity: 0.4; }
  `
  solutionDocument.head.append(style)
}

/**
 * The paging control on one solution callout.
 *
 * Skip, 4:18 AM: "the paging affordance is like, fwd/back arrows on the
 * solution callout itself [with 'no student's answer' being the starting
 * position] / maybe a little like...let's make sure the student's name is on
 * the header for their answer".
 *
 * Rebuilt in place rather than replaced, so the instructor's focus survives a
 * step. The handlers are re-bound each pass because the index they close over
 * is what changed.
 */
function renderControl(
  solutionDocument: Document,
  callout: HTMLElement,
  exerciseId: string,
  answers: readonly ProblemAnswer[],
  index: number,
  onStep: (exerciseId: string, next: number) => void,
) {
  let control = callout.querySelector<HTMLElement>(`.${CONTROL_CLASS}`)
  if (!control) {
    control = solutionDocument.createElement('div')
    control.className = CONTROL_CLASS
    control.dataset.tldaExercise = exerciseId
    callout.append(control)
  }
  const label = index === NO_ANSWER
    ? "No student's answer"
    : `${answers[index]?.displayName ?? 'Unknown'} · ${index + 1} of ${answers.length}`

  // Rebuild only on an actual change.
  //
  // This runs from a MutationObserver on the chapter's document, so a pass that
  // writes unconditionally is a pass that schedules itself: replaceChildren is a
  // mutation, the observer fires on it, and the control rebuilds forever. The
  // rendered state is recorded on the element and compared, which is what makes
  // an unchanged pass do nothing at all.
  const rendered = `${label} ${answers.length}`
  if (control.dataset.tldaRendered === rendered && control.childElementCount === 3) return
  control.dataset.tldaRendered = rendered

  control.replaceChildren()
  const back = solutionDocument.createElement('button')
  back.type = 'button'
  back.textContent = '←'
  back.setAttribute('aria-label', `Previous student's answer for ${exerciseId}`)
  back.disabled = answers.length === 0
  back.addEventListener('click', () => onStep(exerciseId, index === NO_ANSWER ? answers.length - 1 : index - 1))

  const name = solutionDocument.createElement('span')
  name.textContent = label

  const forward = solutionDocument.createElement('button')
  forward.type = 'button'
  forward.textContent = '→'
  forward.setAttribute('aria-label', `Next student's answer for ${exerciseId}`)
  forward.disabled = answers.length === 0
  forward.addEventListener('click', () => onStep(exerciseId, index === NO_ANSWER ? 0 : index + 1))

  control.append(back, name, forward)
}

/**
 * Normalize a step into a position, wrapping through "no student's answer".
 *
 * `NO_ANSWER` is a real position rather than a null state, because it is the one
 * the callout starts in and stepping back from the first answer has to reach it
 * again. With N answers the cycle has N+1 places.
 */
export function stepPosition(index: number, count: number): number {
  if (count === 0) return NO_ANSWER
  if (index < NO_ANSWER) return count - 1
  if (index >= count) return NO_ANSWER
  return index
}

/** Open a collapsed callout, so stepping never shows an answer behind a closed one. */
function openCallout(callout: HTMLElement) {
  // Skip, 11:19 AM: "hitting fwd/back like shoudld open the fking callout if
  // it's closed like; you don't see a sudent solution with the fking callout
  // closed".
  callout.querySelector<HTMLElement>('.callout-collapse')?.classList.add('show')
  const header = callout.querySelector<HTMLElement>('.callout-header')
  header?.classList.remove('collapsed')
  header?.setAttribute('aria-expanded', 'true')
}

/**
 * Place one student's answer beside its solution callout, or take it away.
 *
 * Returns the answer element that is now on screen for this exercise, or null
 * when the position is "no student's answer". The caller needs it to know
 * whether the local layer has anything to be a layer over.
 */
export function pairStudentAnswer(
  solutionDocument: Document,
  exerciseId: string,
  answerDocument: Document | null,
  answerUrl: string,
  displayName: string,
): HTMLElement | null {
  ensureStyle(solutionDocument)
  const callout = solutionDocument.querySelector<HTMLElement>(`[data-tlda-solution-for="${exerciseId}"]`)
  if (!callout) return null

  const existingPair = callout.parentElement?.classList.contains(PAIR_CLASS) ? callout.parentElement : null

  // Taking the answer away puts the callout back exactly where it was, so a
  // chapter stepped back to the start is the chapter again — not a chapter with
  // empty grid cells in it.
  if (!answerDocument) {
    if (existingPair) {
      existingPair.parentNode?.insertBefore(callout, existingPair)
      existingPair.remove()
    }
    return null
  }

  const source = answerDocument.getElementById(`ans-${exerciseId}`)
  if (!source) return null

  const answer = source.cloneNode(true) as HTMLElement
  // Ids would collide with the solution document's own; the pair is identified
  // by data attributes instead.
  answer.removeAttribute('id')
  answer.querySelectorAll<HTMLElement>('[id]').forEach(element => element.removeAttribute('id'))
  answer.dataset.tldaExercise = exerciseId
  answer.dataset.tldaLayerScope = 'student'
  answer.setAttribute('aria-label', `Student answer for ${exerciseId}`)
  makeRelativeResourcesAbsolute(answer, answerUrl)

  // His name on the header, so paging never leaves the instructor guessing
  // whose work is on screen.
  const header = answer.querySelector<HTMLElement>('.callout-title-container, .callout-header')
  if (header) header.textContent = displayName
  else {
    const caption = answerDocument.createElement('div')
    caption.className = 'callout-title-container'
    caption.textContent = displayName
    answer.prepend(caption)
  }

  openCallout(callout)

  const pair = existingPair ?? solutionDocument.createElement('div')
  if (!existingPair) {
    pair.className = PAIR_CLASS
    callout.parentNode?.insertBefore(pair, callout)
  }
  pair.dataset.tldaExercise = exerciseId
  pair.replaceChildren(callout, answer)
  return answer
}

/**
 * Mark every instructor solution callout in the chapter and hang a control on it.
 *
 * Returns the exercise ids found, in document order. Idempotent: it is driven
 * from a MutationObserver, because the chapter's iframe re-renders under it.
 */
export function installLocalLayerControls(
  solutionDocument: Document,
  answersByExercise: ReadonlyMap<string, readonly ProblemAnswer[]>,
  positions: ReadonlyMap<string, number>,
  onStep: (exerciseId: string, next: number) => void,
): string[] {
  ensureStyle(solutionDocument)
  const found: string[] = []
  for (const callout of solutionDocument.querySelectorAll<HTMLElement>('.callout.callout-solution')) {
    const exerciseId = precedingExerciseId(callout, solutionDocument)
    if (!exerciseId) continue
    // Guarded for the same reason the control below is: an unconditional
    // attribute write is a mutation the observer that called us would see.
    if (callout.dataset.tldaSolutionFor !== exerciseId) callout.dataset.tldaSolutionFor = exerciseId
    found.push(exerciseId)
    renderControl(
      solutionDocument,
      callout,
      exerciseId,
      answersByExercise.get(exerciseId) ?? [],
      positions.get(exerciseId) ?? NO_ANSWER,
      onStep,
    )
  }
  return found
}

/** Take every control and pairing back out, leaving the chapter as it was. */
export function removeLocalLayerControls(solutionDocument: Document) {
  for (const pair of solutionDocument.querySelectorAll<HTMLElement>(`.${PAIR_CLASS}`)) {
    const callout = pair.querySelector<HTMLElement>('[data-tlda-solution-for]')
    if (callout) pair.parentNode?.insertBefore(callout, pair)
    pair.remove()
  }
  for (const control of solutionDocument.querySelectorAll<HTMLElement>(`.${CONTROL_CLASS}`)) control.remove()
  for (const callout of solutionDocument.querySelectorAll<HTMLElement>('[data-tlda-solution-for]')) {
    delete callout.dataset.tldaSolutionFor
  }
  solutionDocument.getElementById(STYLE_ID)?.remove()
}

/**
 * Which assignment this chapter is the solutions for, if any.
 *
 * Asked of the course rather than the URL: the instructor arrives at the
 * chapter by reading the book, so nothing in the address says "this is homework
 * 2's solutions". `solutionsDocKey` is the only place that relation is
 * recorded.
 *
 * A reader with no classroom credential gets 401 from `assignments` and this
 * returns null, which is what leaves an ordinary chapter ordinary.
 */
export async function assignmentForSolutionsDoc(courseId: string, docKey: string): Promise<string | null> {
  const { assignments } = await classroomApi.assignments(courseId)
  return assignments.find(assignment => assignment.solutionsDocKey === docKey)?.id ?? null
}

/**
 * The answers for one assignment, grouped by the exercise they answer.
 *
 * `problems()` keys by `problemId`, which is the ANSWER id (`ans-exr-hearts`);
 * the chapter's callouts are keyed by exercise (`exr-hearts`). Dropping the
 * prefix here means every caller downstream speaks one of the two, not both.
 */
export function answersByExercise(view: { problems: { problemId: string; answers: ProblemAnswer[] }[] }): Map<string, ProblemAnswer[]> {
  const grouped = new Map<string, ProblemAnswer[]>()
  for (const problem of view.problems) {
    // A student who has not handed in has nothing to page through, so they are
    // not in the pager. `problems()` returns a row per ENROLLED student —
    // `contentRef: null` for anyone who has not submitted — and paging those
    // put three phantoms in front of the one real answer on the live course:
    // the first press of → read "Fall Readiness Tester · 1 of 4" over no work,
    // and the app said "null has not finished rendering". The count on the
    // control is read the same way, so filtering here fixes the label and the
    // stepping together.
    //
    // Who has NOT submitted is a real question and the gradebook answers it.
    // This control is the one Skip specified on the solution callout — "a
    // little button that lets me page through my students answers" — and an
    // absent answer is not one of those.
    grouped.set(
      problem.problemId.replace(/^ans-/, ''),
      problem.answers.filter(answer => answer.contentRef),
    )
  }
  return grouped
}

/**
 * Every mounted, ready page document among `shapeIds`.
 *
 * Extracted from the hook so the rule can be tested rather than asserted. The
 * rule it replaces was `pages[0]`, which made marking work only where the
 * solutions happened to be the first page — on an 84-page course that is the
 * index, so the controls had nothing to attach to and paging did not help,
 * because nothing re-targeted.
 *
 * AGGREGATED FROM THE DOM, with the registry as a supplement. One shape can
 * mount more than once — main canvas plus a pane or HUD — and the registry
 * holds only the last writer, so trusting it alone puts the controls in an
 * arbitrary copy. That is not hypothetical: a feedback badge once rendered into
 * the editor's mount and was missing from the pane the instructor was reading,
 * while every DOM count reported success, because a count cannot see "in the
 * wrong document".
 *
 * A frame still loading has a `documentElement` and a NULL `body`, and handing
 * that to an installer throws into the error boundary — hence the `body` test.
 * Frames that become ready later are picked up when the caller runs this again.
 */
export function readyPageDocuments(
  shapeIds: readonly string[],
  root: Document,
  registry: Map<string, HTMLIFrameElement>,
): Document[] {
  const documents: Document[] = []
  for (const shapeId of shapeIds) {
    const frames = Array.from(root.querySelectorAll<HTMLIFrameElement>(`[data-shape-id="${shapeId}"] iframe`))
    const registered = registry.get(shapeId)
    if (registered && !frames.includes(registered)) frames.push(registered)
    for (const frame of frames) {
      const contentDocument = frame.contentDocument
      if (contentDocument?.body && !documents.includes(contentDocument)) documents.push(contentDocument)
    }
  }
  return documents
}
