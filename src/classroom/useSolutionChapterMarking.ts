/**
 * Turning a solution chapter into a marking surface, for an instructor.
 *
 * This is the wiring between three things that already existed separately: the
 * chapter the app serves, the classroom record of who handed in what, and the
 * arrows in `solutionMarking.ts`. It adds no surface of its own — a reader who
 * is not an instructor gets the chapter exactly as it has always rendered, and
 * an instructor gets the same chapter with arrows on its solution callouts.
 *
 * Which assignment a chapter belongs to is asked of the record, not parsed out
 * of the path: `bookPageFile` is what setup wrote on the assignment, and a page
 * is homework because an assignment says so and for no other reason. That is
 * the same rule `assignmentForBookPage` follows on the server.
 */
import { useEffect, useState } from 'react'
import { classroomApi, type Assignment, type ProblemAnswer } from './api'
import { installSolutionMarking, type MarkableAnswer } from './solutionMarking'
import type { SvgDocument } from '../loaders/types'
import type { ActiveMarkingPair } from './MarkingInkOverlay'
import { appendToken } from '../authToken'

/**
 * Whether one of this document's pages is the assignment's book page.
 *
 * `pageFiles` on a project are paths like `app/book/homework/x-solutions.html`,
 * and a page's `src` is that path under the project's base. Comparing by suffix
 * rather than by equality is deliberate: the record stores the project-relative
 * path and the page carries a URL, and the only part that is the same string in
 * both is the tail.
 */
function documentIsAssignmentPage(document: SvgDocument, assignment: Assignment): boolean {
  const page = assignment.bookPageFile
  if (!page) return false
  return document.pages.some(p => {
    try {
      return decodeURIComponent(new URL(p.src, window.location.origin).pathname).endsWith(page)
    } catch {
      return p.src.endsWith(page)
    }
  })
}

/** The rendered page of one student's handed-in work. */
async function submissionPageUrl(contentRef: string): Promise<string | null> {
  const response = await fetch(appendToken(`/api/projects/${encodeURIComponent(contentRef)}`))
  if (!response.ok) return null
  const project = await response.json() as { pageFiles?: string[] }
  const page = project.pageFiles?.[0]
  if (!page) return null
  return appendToken(`/docs/${encodeURIComponent(contentRef)}/${page.split('/').map(encodeURIComponent).join('/')}`)
}

/**
 * One student's answer element, brought into the chapter's document.
 *
 * `importNode` rather than moving it: the answer belongs to a document this one
 * fetched, and adopting the node would empty the source document if it is ever
 * reused. A copy here is not the duplication the chapter avoids — the chapter's
 * own solution is still moved, never cloned; this is somebody else's page.
 */
async function loadAnswer(contentRef: string, exerciseId: string, into: Document): Promise<HTMLElement | null> {
  const url = await submissionPageUrl(contentRef)
  if (!url) return null
  const response = await fetch(url)
  if (!response.ok) return null
  const parsed = new DOMParser().parseFromString(await response.text(), 'text/html')
  const answer = parsed.getElementById(`ans-${exerciseId}`)
  if (!answer) return null
  // Resources in somebody else's document are relative to their page, not ours.
  for (const element of answer.querySelectorAll<HTMLElement>('[src], [href]')) {
    for (const attribute of ['src', 'href']) {
      const value = element.getAttribute(attribute)
      if (!value || value.startsWith('#')) continue
      element.setAttribute(attribute, new URL(value, new URL(url, window.location.origin)).href)
    }
  }
  return into.importNode(answer, true) as HTMLElement
}

function answerOrder(answers: ProblemAnswer[]): ProblemAnswer[] {
  return [...answers].sort((a, b) => a.displayName.localeCompare(b.displayName))
}

/**
 * Install marking on every solution chapter this document renders.
 *
 * Returns nothing and owns its own teardown: when the viewer stops being an
 * instructor, or the document changes, the chapter is put back exactly as it
 * was found. A chapter must never be left holding marking chrome.
 */
export function useSolutionChapterMarking(document: SvgDocument | null, editorMounted: number) {
  const [activePair, setActivePair] = useState<ActiveMarkingPair | null>(null)
  useEffect(() => {
    if (!document || document.format !== 'html' || !editorMounted) return
    let cancelled = false
    let stop: (() => void) | null = null
    const removers: Array<() => void> = []

    void (async () => {
      const identity = await classroomApi.me().catch(() => null)
      if (cancelled || !identity) return

      const { assignments } = await classroomApi.assignments(identity.courseId).catch(() => ({ assignments: [] as Assignment[] }))
      const assignment = assignments.find(candidate => documentIsAssignmentPage(document, candidate))
      // A chapter no assignment claims is an ordinary chapter. No arrows, no
      // fetches, nothing said — he is reading, not marking.
      if (cancelled || !assignment) return

      let problems: Awaited<ReturnType<typeof classroomApi.problems>> | null = null
      const ownSubmission = identity.role === 'student'
        ? await classroomApi.mySubmission(assignment.id).catch(() => null)
        : null
      if (identity.role === 'student' && ownSubmission?.gradingStatus !== 'returned') return

      // One factory per frame, so an answer is imported into the document that
      // actually holds the solution it will sit beside. Built per frame rather
      // than looked up inside `load`, because "which document is this" is known
      // at install time and guessing it later is how the wrong page gets edited.
      const answersForFrame = (frameDocument: Document) => async (exerciseId: string): Promise<MarkableAnswer[]> => {
        if (identity.role === 'student') {
          if (!ownSubmission) return []
          return [{
            studentId: identity.studentId,
            displayName: identity.displayName ?? identity.preferredName,
            contentRef: ownSubmission.contentRef,
            load: () => loadAnswer(ownSubmission.contentRef, exerciseId, frameDocument),
          }]
        }
        problems ??= await classroomApi.problems(assignment.id)
        const problem = problems.problems.find(candidate => candidate.problemId === `ans-${exerciseId}`)
        if (!problem) return []
        return answerOrder(problem.answers).map(answer => ({
          studentId: answer.studentId,
          displayName: answer.displayName,
          contentRef: answer.contentRef,
          load: () => loadAnswer(answer.contentRef, exerciseId, frameDocument),
        }))
      }

      // Each rendered page is its own document inside an iframe, so the arrows
      // are installed per frame rather than once for the shape.
      //
      // Asked repeatedly rather than once, because a frame's document arrives
      // after this effect runs and there is no event here that says when. A
      // single pass finds nothing, installs nothing, and never looks again —
      // which is a race that passes whenever the page happens to be warm and
      // fails whenever it is not. `installSolutionMarking` skips a callout that
      // already carries arrows, so running it repeatedly is idempotent.
      const installed = new WeakSet<Document>()
      const install = () => {
        for (const frame of Array.from(window.document.querySelectorAll<HTMLIFrameElement>('iframe'))) {
          const frameDocument = frame.contentDocument
          if (!frameDocument || installed.has(frameDocument)) continue
          if (!frameDocument.querySelector('.callout-solution')) continue
          if (identity.role === 'student') {
            for (const toggle of frameDocument.querySelectorAll('.tlda-own-work-toggle')) toggle.remove()
          }
          const result = installSolutionMarking(frameDocument, {
            answersFor: answersForFrame(frameDocument),
            // Which student the gradebook link named, if it came from one. An
            // instructor clicked a particular person's cell; landing him at
            // "no student's answer" throws that away and makes him page back to
            // where he already said he was going.
            openAt: identity.role === 'instructor'
              ? new URLSearchParams(window.location.search).get('student')
              : null,
            onShow: (exerciseId, answer, wrapper) => {
              setActivePair(current => {
                if (answer && wrapper) return {
                  exerciseId,
                  studentId: answer.studentId,
                  contentRef: answer.contentRef,
                  assignmentId: assignment.id,
                  viewerRole: identity.role,
                  wrapper,
                }
                return current?.exerciseId === exerciseId && current.wrapper.ownerDocument === frameDocument
                  ? null
                  : current
              })
            },
          })
          if (!result.installed) continue
          installed.add(frameDocument)
          removers.push(result.remove)
        }
      }
      install()
      const observer = new MutationObserver(install)
      observer.observe(window.document.body, { childList: true, subtree: true })
      const interval = window.setInterval(install, 250)
      stop = () => { observer.disconnect(); window.clearInterval(interval) }
    })()

    return () => {
      cancelled = true
      setActivePair(null)
      stop?.()
      for (const remove of removers) remove()
    }
  }, [document, editorMounted])
  return activePair
}
