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
 * The solution keeps the full text column and the answer goes in the margin
 * beside it, so the chapter reads at exactly the width it always did while an
 * answer is up.
 *
 * THE ANSWER IS NOT PUT IN THIS DOCUMENT. It used to be, positioned at
 * `left: 100%`, and that is laid out correctly and clipped unreadable: the
 * chapter is rendered in an iframe and the margin is outside it — measured on
 * his chapter, the answer's right edge at x=1280 against a 624px iframe.
 * Widening the iframe reflows the chapter's own text (620 -> 1100), which is
 * the one thing this layout exists to prevent. So the wrapper is built here and
 * the answer's markup is handed to the parent document, which hosts it beside
 * the iframe where nothing can clip it. See `answerDocument.ts` for why it goes
 * as a document rather than as an element.
 */

const PAIR_CLASS = 'tlda-marking-pair'
const ANSWER_CLASS = 'tlda-marking-answer'
const ARROWS_CLASS = 'tlda-marking-arrows'
const STYLE_ID = 'tlda-marking-style'

/** Where the Return button portals, in the answer's own document. */
export const ANSWER_HEADER_CLASS = `${ANSWER_CLASS}-header`

/**
 * The marking chrome's styling, for the answer's own document.
 *
 * The header, the Return button and the photograph fitting travel with the
 * answer because the answer does: they are ours, not the chapter's, so
 * `answerStyleSources` cannot carry them — it deliberately leaves this
 * stylesheet behind. Kept here beside the markup that uses it rather than in
 * `answerDocument.ts`, which knows how to build a document and nothing about
 * what marking puts in one.
 */
export const ANSWER_DOCUMENT_CSS = `
  .${ANSWER_CLASS} { margin-block-start: 0; }
  /*
   * FULL CONTRAST, and the border alone does the separating.
   *
   * This header carried opacity 0.85 from the version that lived in the
   * chapter, which dims the whole subtree — the student's name and the Return
   * button with it. Beside the chapter's own bright "Solution" header that
   * reads as a step down, and Return is the control he presses: it spent today
   * reporting success while sending nothing, so it is the last thing that
   * should be hard to see. A button he has to hunt for is in the header
   * positionally and not in the sense he asked for.
   */
  .${ANSWER_CLASS} > .${ANSWER_HEADER_CLASS} {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-weight: 600;
    padding: 0.35rem 0.6rem;
    border-bottom: 1px solid currentColor;
  }
  /*
   * A student's photograph is whatever their phone produced — 4032px wide is
   * ordinary. Fit it to the callout by width, keep its aspect ratio, and leave
   * a little room at the edges.
   */
  .${ANSWER_CLASS} img {
    max-width: calc(100% - 1rem);
    height: auto;
    margin-inline: 0.5rem;
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
`

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
  /**
   * Called whenever the shown student changes, including back to nobody.
   *
   * `markup` is the answer, ready to be a document of its own — the parent
   * renders it, because this document's iframe would clip it. It is null
   * exactly when there is nobody to show.
   */
  onShow?: (exerciseId: string, answer: MarkableAnswer | null, pair: HTMLElement | null, markup: string | null) => void
  /**
   * What the pager says at position zero when there IS an answer to show.
   *
   * Defaults to `no answer`, which is what it has always said and what is true
   * for him: he walks a list of students and zero means nobody is selected. A
   * student's list is one entry, their own returned work, so the same words
   * tell them their marked homework does not exist. `docs/classroom.md` says
   * handback returns the marked exercise to the student in the book — a mark
   * they are told is not there has not been returned in any sense that means.
   *
   * Only reached when the list is non-empty, so it can never claim something is
   * there when nothing is.
   */
  collapsedLabel?: string
  /**
   * Open on this student's answer rather than at position zero.
   *
   * The gradebook link is a particular student's cell, so arriving at "no
   * student's answer" and making him page to the one he clicked loses the only
   * thing that link said. An id nobody answered with is not an error — the
   * arrows stay at position zero, which is where they would have been anyway.
   *
   * Position zero remains the default everywhere else: he opens the chapter to
   * read it far more often than to mark one person, and `3a5141394` records that
   * as his 4:18 spec.
   */
  openAt?: string | null
}

function installStyle(doc: Document) {
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  // The chapter's own side of the marking chrome, and nothing else. Everything
  // the ANSWER needs is in `ANSWER_DOCUMENT_CSS`, because the answer is not in
  // this document.
  //
  // `position: relative` on the wrapper is not layout here — it is the
  // coordinate origin the instructor's strokes are stored against. Nothing in
  // this stylesheet moves the chapter, which is the whole point: he is reading
  // the page at the width it has always had while he marks it.
  style.textContent = `
    .${PAIR_CLASS} { position: relative; }
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
 * Make this solution a pair, creating the wrapper if it is not there.
 *
 * The solution element is *moved* into the wrapper, never copied: a clone would
 * be a second thing that could disagree with the chapter, and the instructor is
 * marking the real page.
 *
 * The wrapper is all this makes. Nothing is appended to it and nothing beside
 * it moves — it exists to be the origin a stroke is stored against and the box
 * the parent positions the answer from. An answer inserted here would be in the
 * chapter's iframe, which is the clipping this design removes.
 */
function pair(solution: HTMLElement, doc: Document) {
  const existing = solution.closest<HTMLElement>(`.${PAIR_CLASS}`)
  if (existing) return
  const wrapper = doc.createElement('div')
  wrapper.className = PAIR_CLASS
  solution.parentNode?.insertBefore(wrapper, solution)
  wrapper.append(solution)
}

/**
 * One student's answer, as the markup the parent will render as a document.
 *
 * Whose work this is is said on the answer itself rather than only in the
 * pager: he is marking one student among forty and the name has to be beside
 * the work while he reads it, not in a control he looked at a moment ago. Built
 * here rather than trusted from the student's document, which is somebody
 * else's HTML and says nothing about who handed it in.
 *
 * The element is not modified — it is somebody else's page and this is the only
 * thing we take from it. A copy is marked up and serialized.
 */
export function answerMarkup(answer: HTMLElement, displayName: string, doc: Document): string {
  const copy = answer.cloneNode(true) as HTMLElement
  copy.classList.add(ANSWER_CLASS)
  // THEIR ANSWER IS NOT SUBHEADED "Template".
  //
  // A submission is rendered from the handout template, so the answer callout
  // arrives carrying that document's own `.callout-header` — measured on the
  // walk copy, it reads "Answer" then "Template". Beneath the header we
  // prepend, which already says whose work this is, that told a student reading
  // their own marked homework that they were looking at a blank.
  //
  // Removed rather than renamed: the header below carries the name, and a
  // second one saying "Answer" over an answer is chrome even when it is not
  // wrong. The body is untouched — what they wrote is theirs.
  copy.querySelector(':scope > .callout-header')?.remove()
  // A PHOTOGRAPH MUST NOT COME BACK AS A NEGATIVE.
  //
  // The answer's document inverts with the chapter, which is what makes its
  // text readable on a dark canvas — and it inverts the student's photograph
  // with it, so a picture of their handwriting arrives white-on-black. He is
  // marking the handwriting in that picture. `darkmode-invariant` is the book's
  // own counter-inversion, shipped in the same injected stylesheet, so this
  // uses the mechanism that already exists for exactly this rather than
  // inventing a rule.
  for (const image of copy.querySelectorAll('img')) image.classList.add('darkmode-invariant')
  const header = doc.createElement('div')
  header.className = ANSWER_HEADER_CLASS
  header.textContent = displayName
  copy.prepend(header)
  return copy.outerHTML
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
      // AT POSITION ZERO, "no answer" AND "not showing one" ARE DIFFERENT
      // THINGS, and saying the first when the second is true is a lie to
      // whoever is reading.
      //
      // For him they coincide: he pages through a list of students and zero
      // means he has landed on nobody. For a student the list is one entry —
      // their own returned work — so the page was telling them there is no
      // answer while their marked homework sat one click away. `collapsedLabel`
      // is what to say when there IS something and it is not open; the default
      // leaves his pager exactly as it was.
      label.textContent = current
        ? `${current.displayName} ${index + 1}/${answers!.length}`
        : answers?.length ? options.collapsedLabel ?? 'no answer' : 'no answer'
      back.disabled = index < 0
      forward.disabled = answers !== null && index >= answers.length - 1
      if (!current) {
        unpair(solution)
        options.onShow?.(exerciseId, null, null, null)
        return
      }
      const shown = index
      const element = await current.load()
      // He can page again while a fetch is in flight. Only the answer that is
      // still the current one is allowed to land, or a slow student's work
      // appears beside the solution after he has already moved past them.
      if (shown !== index) return
      if (element) pair(solution, doc)
      else unpair(solution)
      options.onShow?.(
        exerciseId,
        current,
        solution.closest<HTMLElement>(`.${PAIR_CLASS}`),
        element ? answerMarkup(element, current.displayName, doc) : null,
      )
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
    // Opening on a named student asks for the answers up front, which is exactly
    // what `step` avoids doing for a chapter he is only reading — so it happens
    // only when a student was actually named.
    void (async () => {
      if (!options.openAt) return void render()
      answers ??= await options.answersFor(exerciseId)
      const at = answers.findIndex(answer => answer.studentId === options.openAt)
      if (at >= 0) index = at
      await render()
    })()

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
