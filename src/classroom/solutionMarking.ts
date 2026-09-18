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

/**
 * One student's answer to one exercise, as the arrows page through them.
 *
 * The element is fetched when that student is shown, not when the list is
 * built. A class is forty-odd people and each answer lives in its own rendered
 * document; loading all of them to display one would put forty fetches behind
 * a single click on a machine that is already the bottleneck.
 */
export interface MarkableAnswer {
  studentId: string
  displayName: string
  contentRef: string
  /** Resolves the answer element, in the chapter's document. Null if it has none. */
  load: () => Promise<HTMLElement | null>
}

export interface SolutionMarkingOptions {
  /**
   * The answers to page through for one exercise, in the order the arrows walk
   * them. Returning an empty list is not a failure: it is an exercise nobody
   * has answered, and the arrows stay at position zero with nothing to show.
   */
  answersFor: (exerciseId: string) => Promise<MarkableAnswer[]>
  /** Called whenever the shown student changes, including back to nobody. */
  onShow?: (exerciseId: string, answer: MarkableAnswer | null, pair: HTMLElement | null) => void
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
      /*
       * The answer arrives as a callout and callouts carry a top margin, which
       * pushes its border box below the point it is positioned at — measured at
       * 21px, and the whole of the tops-aligned failure. Zeroed here rather than
       * compensated for in the offset, because this element is the copy we place
       * and its margin means nothing where we put it.
       */
      margin-block-start: 0;
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
    .${PAIR_CLASS} > .${ANSWER_CLASS} > .${ANSWER_CLASS}-header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-weight: 600;
      padding: 0.35rem 0.6rem;
      border-bottom: 1px solid currentColor;
      opacity: 0.85;
    }
    .tlda-marking-return { margin-inline-start: auto; }
    .tlda-marking-return button {
      cursor: pointer;
      border: 1px solid currentColor;
      background: transparent;
      color: inherit;
      border-radius: 0.25rem;
      padding: 0.1rem 0.45rem;
    }
    .tlda-marking-return button[disabled] { opacity: 0.4; cursor: default; }
    .tlda-marking-return-status { font-size: 0.85em; font-weight: 400; }
    .tlda-marking-return-error { color: #9a3c32; }
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
function pair(solution: HTMLElement, answer: HTMLElement, displayName: string, doc: Document) {
  let wrapper = solution.closest<HTMLElement>(`.${PAIR_CLASS}`)
  if (!wrapper) {
    wrapper = doc.createElement('div')
    wrapper.className = PAIR_CLASS
    solution.parentNode?.insertBefore(wrapper, solution)
    wrapper.append(solution)
  }
  wrapper.querySelector(`.${ANSWER_CLASS}`)?.remove()
  answer.classList.add(ANSWER_CLASS)
  // Whose work this is, said on the answer itself rather than only in the
  // pager. He is marking one student among forty and the name has to be beside
  // the work while he reads it, not in a control he looked at a moment ago.
  // Built here rather than trusted from the student's document, which is
  // somebody else's HTML and says nothing about who handed it in.
  const header = doc.createElement('div')
  header.className = `${ANSWER_CLASS}-header`
  header.textContent = displayName
  answer.prepend(header)
  wrapper.append(answer)
  // Align the answer's top with the SOLUTION's top, not the wrapper's.
  //
  // The answer is positioned against the wrapper, whose top is the solution's
  // margin box — so `top: 0` lands above the solution's border box by whatever
  // margin the chapter gives it, measured at 21px here. Zeroing that margin
  // would align them by moving the solution, which shifts the chapter while he
  // marks; the chapter staying exactly itself is the constraint. So the offset
  // is measured and applied to the answer instead, and nothing about the
  // chapter's own layout changes.
  answer.style.top = `${solution.offsetTop}px`
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
    .filter(solution => !solution.parentElement?.closest('.callout-solution'))
  const cleanups: Array<() => void> = []

  for (const solution of solutions) {
    const exerciseId = exerciseIdForSolution(solution, doc)
    if (!exerciseId) continue
    // The iframe can be observed once while Quarto is still finishing the
    // callout header and again after it exists. The owner is the solution, not
    // whichever host happened to exist on that pass; otherwise one pager lands
    // on the bare callout and a second lands in its eventual header.
    if (solution.querySelector(`.${ARROWS_CLASS}`)) continue
    const host = arrowHost(solution)

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

    const render = async () => {
      const current = index >= 0 && answers ? answers[index] ?? null : null
      label.textContent = current
        ? `${current.displayName} ${index + 1}/${answers!.length}`
        : 'no answer'
      back.disabled = index < 0
      forward.disabled = answers !== null && index >= answers.length - 1
      if (!current) {
        unpair(solution)
        options.onShow?.(exerciseId, null, null)
        return
      }
      const shown = index
      const element = await current.load()
      // He can page again while a fetch is in flight. Only the answer that is
      // still the current one is allowed to land, or a slow student's work
      // appears beside the solution after he has already moved past them.
      if (shown !== index) return
      if (element) pair(solution, element, current.displayName, doc)
      else unpair(solution)
      options.onShow?.(exerciseId, current, solution.closest<HTMLElement>(`.${PAIR_CLASS}`))
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
      await render()
    }

    back.addEventListener('click', () => { void step(-1) })
    forward.addEventListener('click', () => { void step(1) })
    host.append(arrows)
    void render()

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
