import { useEffect, type MutableRefObject } from 'react'
import { createShapeId, type Editor } from 'tldraw'
import type { SvgDocument } from '../svgDocumentLoader'
import { htmlIframeElements } from '../htmlIframeRegistry'

const PAIR_CLASS = 'tlda-marked-exercise-callout-pair'
const STYLE_ID = 'tlda-marked-exercise-callout-style'
const HANDLE_ID = createShapeId('marked-exercise-alignment-handle')
const HANDLE_GAP = 12

export function collapseMarkedExerciseSolutions() {
  for (const frame of window.document.querySelectorAll<HTMLIFrameElement>('iframe')) {
    for (const solution of frame.contentDocument?.querySelectorAll<HTMLElement>('[aria-label^="Instructor solution for "]') ?? []) {
      solution.querySelector<HTMLElement>('.callout-collapse')?.classList.remove('show')
      const toggle = solution.querySelector<HTMLElement>('.callout-header')
      toggle?.classList.add('collapsed')
      toggle?.setAttribute('aria-expanded', 'false')
    }
  }
}

function precedingExerciseId(solution: HTMLElement, solutionDocument: Document): string | null {
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

/** Put each instructor solution beside the answer with the matching exercise id. */
export function pairMarkedExerciseCallouts(studentDocument: Document, solutionDocument: Document, solutionUrl: string, selectedExerciseId?: string): number {
  if (!studentDocument.getElementById(STYLE_ID)) {
    const style = studentDocument.createElement('style')
    style.id = STYLE_ID
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
    `
    studentDocument.head.append(style)
  }

  for (const pair of studentDocument.querySelectorAll<HTMLElement>(`.${PAIR_CLASS}`)) {
    if (!selectedExerciseId || pair.dataset.tldaExercise === selectedExerciseId) continue
    const answer = pair.querySelector<HTMLElement>('[aria-label^="Student answer for "]')
    if (answer) pair.parentNode?.insertBefore(answer, pair)
    pair.remove()
  }
  for (const solution of solutionDocument.querySelectorAll<HTMLElement>('.callout.callout-solution')) {
    const exerciseId = precedingExerciseId(solution, solutionDocument)
    if (!exerciseId || (selectedExerciseId && exerciseId !== selectedExerciseId)) continue
    const answer = studentDocument.getElementById(`ans-${exerciseId}`)
    if (!answer || answer.parentElement?.classList.contains(PAIR_CLASS)) continue

    const displayedSolution = solution.cloneNode(true) as HTMLElement
    displayedSolution.removeAttribute('id')
    displayedSolution.querySelectorAll<HTMLElement>('[id]').forEach(element => element.removeAttribute('id'))
    displayedSolution.querySelectorAll<HTMLElement>('[data-bs-toggle], [data-bs-target], [aria-controls]')
      .forEach(element => {
        element.removeAttribute('data-bs-toggle')
        element.removeAttribute('data-bs-target')
        element.removeAttribute('aria-controls')
        element.setAttribute('aria-expanded', 'false')
        element.classList.add('collapsed')
      })
    displayedSolution.querySelectorAll<HTMLElement>('.callout-collapse').forEach(element => {
      element.classList.remove('show')
    })
    const toggle = displayedSolution.querySelector<HTMLElement>('.callout-header')
    const collapsible = displayedSolution.querySelector<HTMLElement>('.callout-collapse')
    toggle?.addEventListener('click', () => {
      const open = collapsible?.classList.toggle('show') ?? false
      toggle.classList.toggle('collapsed', !open)
      toggle.setAttribute('aria-expanded', String(open))
    })
    displayedSolution.dataset.tldaExercise = exerciseId
    displayedSolution.dataset.tldaLayerScope = 'common'
    displayedSolution.setAttribute('aria-label', `Instructor solution for ${exerciseId}`)
    makeRelativeResourcesAbsolute(displayedSolution, solutionUrl)

    const pair = studentDocument.createElement('div')
    pair.className = PAIR_CLASS
    pair.dataset.tldaExercise = exerciseId
    answer.setAttribute('aria-label', `Student answer for ${exerciseId}`)
    answer.parentNode?.insertBefore(pair, answer)
    pair.append(answer, displayedSolution)
  }
  // How many pairs are PRESENT, not how many this pass added.
  //
  // The loop above skips an answer that is already inside a pair, so a second
  // pass over an already-paired document adds none. Returning additions would
  // tell the caller the pairing had gone away, and it would put the official
  // solution pane back over a pairing that is still on screen.
  //
  // The unpairing loop at the top has already removed every pair that is not
  // the selected exercise, so what remains is this selection's pairs.
  return studentDocument.querySelectorAll(`.${PAIR_CLASS}`).length
}

// Which marking journey is on screen, or none.
//
// `SvgDocumentEditor` calls the hook below for EVERY document it renders, so
// without this check the callout path runs on any HTML document with two or
// more pages and hides the second one — an ordinary two-page book loses a page
// with nothing reporting it.
//
// Two journeys reach the hook and want different things:
//
//   `?workspace=classroom-problems`  the problem-by-problem marking view.
//       Each solution callout is placed beside the student's matching answer
//       and the source solution page is hidden, because the solution is being
//       shown inline rather than as a second pane. `GradebookWorkspace.open()`
//       builds this URL and `App.tsx` renders `ProblemMarking` from it.
//
//   `?compareDoc=`                   the side-by-side comparison canvas, which
//       keeps a drag handle and moves the second page with it. Still reachable
//       from `HomeworkComparisonWorkspace`, so it keeps its own behaviour.
//
// Neither present means an ordinary document: do nothing at all.
function markedExerciseContext(): 'problems' | 'compare' | null {
  const params = new URLSearchParams(window.location.search)
  if (params.get('workspace') === 'classroom-problems' || params.get('workspace') === 'classroom-work') return 'problems'
  if (params.get('compareDoc')) return 'compare'
  return null
}

export function useMarkedExerciseHtmlAlignment(
  editorRef: MutableRefObject<Editor | null>,
  document: SvgDocument,
  editorMounted: number,
) {
  // The problem-marking journey: pair callouts into the student's document and
  // hide the solution page it took them from.
  useEffect(() => {
    const editor = editorRef.current
    const studentId = document.pages[0]?.shapeId
    const solutionId = document.pages[1]?.shapeId
    if (markedExerciseContext() !== 'problems') return
    if (document.format !== 'html' || document.pages.length < 2 || !editorMounted || !editor || !studentId || !solutionId) return

    // Put the solution back exactly as main leaves it, attribute included.
    //
    // Every path that stops showing a pairing comes through here. Switching to
    // a problem the solution document has no callout for is the one that bites:
    // `pairMarkedExerciseCallouts` unpairs the previous exercise BEFORE it tries
    // the new one, so a bare early return would leave the old pair dismantled
    // and the solution page still hidden — the instructor would have neither
    // copy. Unmounting takes the same path, since the hiding is only ever
    // correct while a pairing is on screen.
    const restore = () => {
      delete window.document.body.dataset.tldaMarkedExercisePaired
      for (const solutionShape of window.document.querySelectorAll<HTMLElement>(`[data-shape-id="${solutionId}"]`)) {
        solutionShape.style.removeProperty('visibility')
        solutionShape.style.removeProperty('pointer-events')
        solutionShape.removeAttribute('aria-hidden')
      }
    }

    const install = () => {
      const registeredStudentFrame = htmlIframeElements.get(studentId)
      const registeredSolutionFrame = htmlIframeElements.get(solutionId)
      const studentFrames = Array.from(window.document.querySelectorAll<HTMLIFrameElement>(`[data-shape-id="${studentId}"] iframe`))
      const solutionFrames = Array.from(window.document.querySelectorAll<HTMLIFrameElement>(`[data-shape-id="${solutionId}"] iframe`))
      if (registeredStudentFrame && !studentFrames.includes(registeredStudentFrame)) studentFrames.push(registeredStudentFrame)
      if (registeredSolutionFrame && !solutionFrames.includes(registeredSolutionFrame)) solutionFrames.push(registeredSolutionFrame)
      const solutionFrame = solutionFrames.find(candidate => candidate.contentDocument?.body && candidate.src)
      const solutionDocument = solutionFrame?.contentDocument
      if (!solutionDocument?.body || !solutionFrame?.src || !studentFrames.some(candidate => candidate.contentDocument?.body)) {
        return
      }
      // Hide the solution page only once its callouts have actually been placed
      // somewhere. `pairMarkedExerciseCallouts` returns how many it moved; if it
      // moved none, hiding the page would remove content and put nothing in its
      // place.
      let paired = 0
      for (const studentFrame of studentFrames) {
        if (studentFrame.contentDocument?.body) {
          const selectedExerciseId = new URLSearchParams(window.location.search).get('problem')?.replace(/^ans-/, '')
          paired += pairMarkedExerciseCallouts(studentFrame.contentDocument, solutionDocument, solutionFrame.src, selectedExerciseId)
          studentFrame.contentWindow?.dispatchEvent(new Event('resize'))
        }
      }
      if (paired === 0) {
        restore()
        return
      }
      window.document.body.dataset.tldaMarkedExercisePaired = 'true'
      for (const solutionShape of window.document.querySelectorAll<HTMLElement>(`[data-shape-id="${solutionId}"]`)) {
        solutionShape.style.visibility = 'hidden'
        solutionShape.style.pointerEvents = 'none'
        solutionShape.setAttribute('aria-hidden', 'true')
      }
    }
    const observer = new MutationObserver(install)
    observer.observe(window.document.body, { childList: true, subtree: true })
    const interval = window.setInterval(install, 250)
    install()
    return () => {
      window.clearInterval(interval)
      observer.disconnect()
      restore()
    }
  }, [document, editorMounted, editorRef])

  // The side-by-side comparison canvas, unchanged from main: a drag handle the
  // instructor moves, with the second page following it.
  useEffect(() => {
    const editor = editorRef.current
    if (markedExerciseContext() !== 'compare') return
    if (document.format !== 'html' || document.pages.length < 2 || !editorMounted || !editor) return

    const comparisonId = document.pages[1].shapeId

    const ensureHandle = () => {
      const comparison = editor.getShape(comparisonId)
      if (!comparison || editor.getShape(HANDLE_ID)) return
      editor.createShape({
        id: HANDLE_ID,
        type: 'line' as any,
        x: comparison.x - HANDLE_GAP,
        y: comparison.y,
        opacity: 0.1,
        props: {
          points: {
            a1: { id: 'a1', index: 'a1', x: 0, y: 0 },
            a2: { id: 'a2', index: 'a2', x: 0, y: Number((comparison.props as any)?.h) || 1000 },
          },
          color: 'grey', dash: 'solid', size: 's', spline: 'line', scale: 1,
        },
        meta: { classroomMarkedExerciseAlignment: true },
      })
    }

    const alignComparison = (handle = editor.getShape(HANDLE_ID)) => {
      const comparison = editor.getShape(comparisonId)
      if (!comparison || !handle) return
      editor.store.put([{ ...comparison, x: handle.x + HANDLE_GAP, y: handle.y }])
    }

    let frame = 0
    let lastHandleX: number | null = null
    let lastHandleY: number | null = null
    const sync = () => {
      ensureHandle()
      const handle = editor.getShape(HANDLE_ID)
      const comparison = editor.getShape(comparisonId)
      if (handle && comparison && (handle.x !== lastHandleX || handle.y !== lastHandleY)) {
        lastHandleX = handle.x
        lastHandleY = handle.y
        alignComparison(handle)
      }
      frame = requestAnimationFrame(sync)
    }
    frame = requestAnimationFrame(sync)
    return () => cancelAnimationFrame(frame)
  }, [document, editorMounted, editorRef])
}
