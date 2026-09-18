/**
 * Marking a student's work on the solution chapter.
 *
 * The chapter is the surface. It renders exactly as it always does — this file
 * adds nothing to it for a reader, moves nothing, clones nothing, and hides
 * nothing. For an instructor, each solution callout gains forward/back arrows.
 * They start at position zero: no student's answer, and no pair. Paging forward
 * puts one student's answer beside that solution callout, tops aligned, and
 * paging back to zero takes it away again and leaves the callout exactly as it
 * was found.
 *
 * The pair's wrapper is the coordinate frame the instructor's handwriting
 * anchors in, which is why the wrapper exists at all rather than the answer
 * being dropped next to the callout: marks belong to a student and to a place
 * on that student's answer, and both have to survive the page reflowing around
 * them.
 *
 * The solution keeps the full text column and the answer overhangs into the
 * margin, so the chapter reads at exactly the width it always did while an
 * answer is up.
 */

const PAIR_CLASS = 'tlda-marking-pair'
const ANSWER_CLASS = 'tlda-marking-answer'
const ARROWS_CLASS = 'tlda-marking-arrows'
const STYLE_ID = 'tlda-marking-style'

/** One student's answer to one exercise, as the arrows page through them. */
export interface MarkableAnswer {
  studentId: string
  displayName: string
  /** The answer element, already belonging to the chapter's document. */
  element: HTMLElement
}

export interface SolutionMarkingOptions {
  /**
   * The answers to page through for one exercise, in the order the arrows walk
   * them. Returning an empty list is not a failure: it is an exercise nobody
   * has answered, and the arrows stay at position zero with nothing to show.
   */
  answersFor: (exerciseId: string) => Promise<MarkableAnswer[]>
  /** Called whenever the shown student changes, including back to nobody. */
  onShow?: (exerciseId: string, answer: MarkableAnswer | null) => void
}

function installStyle(doc: Document) {
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  // The answer is taken out of flow deliberately. In flow it would either
  // narrow the solution or widen the measure; out of flow at `left: 100%` it
  // begins exactly where the text column ends, so the chapter keeps the width
  // it always had and the answer lives in the margin beside it. `top: 0` is
  // what "tops aligned" means once both are in the wrapper's coordinates.
  style.textContent = `
    .${PAIR_CLASS} { position: relative; }
    .${PAIR_CLASS} > .${ANSWER_CLASS} {
      position: absolute;
      left: 100%;
      top: 0;
      margin-left: 1.5rem;
      width: 100%;
      max-width: 32rem;
      box-sizing: border-box;
    }
    /*
     * A student's photograph is whatever their phone produced — 4032px wide is
     * ordinary. Fit it to the callout by width, keep its aspect ratio, and
     * leave a little room at the edges.
     */
    .${PAIR_CLASS} img {
      max-width: calc(100% - 1rem);
      height: auto;
      margin-inline: 0.5rem;
    }
    .${ARROWS_CLASS} {
      display: inline-flex;
      gap: 0.25rem;
      align-items: center;
      margin-inline-start: 0.5rem;
      font-size: 0.85em;
      user-select: none;
    }
    .${ARROWS_CLASS} button {
      cursor: pointer;
      border: 1px solid currentColor;
      background: transparent;
      color: inherit;
      border-radius: 0.25rem;
      line-height: 1;
      padding: 0.1rem 0.35rem;
    }
    .${ARROWS_CLASS} button[disabled] { opacity: 0.4; cursor: default; }
    .${ARROWS_CLASS} .${ARROWS_CLASS}-label { opacity: 0.8; }
  `
  doc.head.append(style)
}

/**
 * The exercise a solution belongs to: the nearest `exr-` element above it.
 *
 * The chapter puts the solution after its exercise rather than inside it, so
 * position in the document is the only thing that relates them.
 */
export function exerciseIdForSolution(solution: HTMLElement, doc: Document): string | null {
  const NodeCtor = doc.defaultView?.Node
  if (!NodeCtor) return null
  let found: string | null = null
  for (const exercise of doc.querySelectorAll<HTMLElement>('[id^="exr-"]')) {
    if (exercise.compareDocumentPosition(solution) & NodeCtor.DOCUMENT_POSITION_FOLLOWING) found = exercise.id
  }
  return found
}

/**
 * Where the arrows go on a callout.
 *
 * A filtered solution callout has a header to sit in. An unfiltered one is a
 * bare div with no header at all, and rather than inventing chrome the chapter
 * does not have, the arrows go at the top of the callout itself.
 */
function arrowHost(solution: HTMLElement): HTMLElement {
  return solution.querySelector<HTMLElement>('.callout-header') ?? solution
}

/** Take the pair apart, leaving the solution callout exactly as it was found. */
function unpair(solution: HTMLElement) {
  const pair = solution.closest(`.${PAIR_CLASS}`)
  if (!pair?.parentNode) return
  pair.parentNode.insertBefore(solution, pair)
  pair.remove()
}

/**
 * Put one answer beside this solution, creating the wrapper if it is not there.
 *
 * The solution element is *moved* into the wrapper, never copied: a clone would
 * be a second thing that could disagree with the chapter, and the instructor is
 * marking the real page.
 */
function pair(solution: HTMLElement, answer: HTMLElement, doc: Document) {
  let wrapper = solution.closest<HTMLElement>(`.${PAIR_CLASS}`)
  if (!wrapper) {
    wrapper = doc.createElement('div')
    wrapper.className = PAIR_CLASS
    solution.parentNode?.insertBefore(wrapper, solution)
    wrapper.append(solution)
  }
  wrapper.querySelector(`.${ANSWER_CLASS}`)?.remove()
  answer.classList.add(ANSWER_CLASS)
  wrapper.append(answer)
}

/**
 * Install the arrows on every solution callout in a document.
 *
 * Returns how many callouts carry arrows, and a function that removes every
 * trace of them — used when the viewer stops being an instructor, or the
 * document goes away, so the chapter is never left holding marking chrome.
 */
export function installSolutionMarking(doc: Document, options: SolutionMarkingOptions): { installed: number; remove: () => void } {
  installStyle(doc)
  const solutions = Array.from(doc.querySelectorAll<HTMLElement>('.callout-solution'))
  const cleanups: Array<() => void> = []

  for (const solution of solutions) {
    const exerciseId = exerciseIdForSolution(solution, doc)
    if (!exerciseId) continue
    const host = arrowHost(solution)
    if (host.querySelector(`.${ARROWS_CLASS}`)) continue

    // Position zero is "no student's answer", which is where every callout
    // starts and what `back` from the first student returns to.
    let index = -1
    let answers: MarkableAnswer[] | null = null

    const arrows = doc.createElement('span')
    arrows.className = ARROWS_CLASS
    arrows.dataset.tldaExercise = exerciseId
    const back = doc.createElement('button')
    back.type = 'button'
    back.textContent = '‹'
    back.setAttribute('aria-label', `Previous student's answer for ${exerciseId}`)
    const label = doc.createElement('span')
    label.className = `${ARROWS_CLASS}-label`
    const forward = doc.createElement('button')
    forward.type = 'button'
    forward.textContent = '›'
    forward.setAttribute('aria-label', `Next student's answer for ${exerciseId}`)
    arrows.append(back, label, forward)

    const render = () => {
      const current = index >= 0 && answers ? answers[index] ?? null : null
      label.textContent = current
        ? `${current.displayName} ${index + 1}/${answers!.length}`
        : 'no answer'
      back.disabled = index < 0
      forward.disabled = answers !== null && index >= answers.length - 1
      if (current) pair(solution, current.element, doc)
      else unpair(solution)
      options.onShow?.(exerciseId, current)
    }

    const step = async (delta: number) => {
      if (answers === null) {
        // Asked for only when he first pages: a chapter he is reading should
        // not fetch the whole class.
        answers = await options.answersFor(exerciseId)
      }
      const next = index + delta
      if (next < -1 || next > answers.length - 1) return
      index = next
      render()
    }

    back.addEventListener('click', () => { void step(-1) })
    forward.addEventListener('click', () => { void step(1) })
    host.append(arrows)
    render()

    cleanups.push(() => {
      unpair(solution)
      arrows.remove()
    })
  }

  return {
    installed: cleanups.length,
    remove: () => {
      for (const cleanup of cleanups) cleanup()
      doc.getElementById(STYLE_ID)?.remove()
    },
  }
}
