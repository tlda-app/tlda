import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Editor } from 'tldraw'
import { classroomApi, type ProblemAnswer } from './api'
import { htmlIframeElements } from '../htmlIframeRegistry'
import { StudentAnnotationOverlay } from './StudentAnnotationOverlay'
import { gradingDraftRoomId } from '../../shared/classroom-rooms.mjs'
import {
  NO_ANSWER,
  answersByExercise,
  assignmentForSolutionsDoc,
  installLocalLayerControls,
  pairStudentAnswer,
  readyPageDocuments,
  removeLocalLayerControls,
  stepPosition,
} from './localLayer'

// The local layer, mounted on the solution chapter.
//
// Skip named it at 12:13 PM: "naming: let 's call this the 'local' layer". It
// is one more layer of the kind the book already has — `useDocumentLayers`
// mounts one per student for an instructor and one for a student's own marks —
// and he said so himself at 12:02 PM: "isn't this a marking/glass layer for me
// and for students, store per question swapped out, with copying of the entire
// store? ... that's like how multiple layers already work no?"
//
// What makes it local rather than one of those: its store is not a property of
// the reader, it is a property of the problem x student pair currently on
// screen. Opening a pair mounts one; stepping away tears it down. Skip, 4:51
// AM: "a layer per problem per student might be a bit much so i was thinking of
// it as a kind of on-demand layer."
//
// The camera is the book's, which is the mode `StudentAnnotationOverlay` was
// written for and has always worked in. That is the whole of the scroll
// question on this surface: there is no pane, no viewport of its own and no
// wheel handler, so scrolling the chapter is scrolling the chapter.

/** One open pair: whose answer is beside which solution, and the room its marks live in. */
export interface OpenPair {
  exerciseId: string
  answer: ProblemAnswer
  roomId: string
}

interface AnswerDocument {
  document: Document
  url: string
}

/**
 * Fetch a student's rendered submission as a document.
 *
 * The answer is HTML the build already produced, so this reads the same file
 * the app would render rather than asking the server for a second
 * representation of it.
 */
async function loadAnswerDocument(contentRef: string): Promise<AnswerDocument> {
  const basePath = `/docs/${encodeURIComponent(contentRef)}/`
  const info = await fetch(`${basePath}page-info.json`)
  if (!info.ok) throw new Error(`${contentRef} has not finished rendering`)
  const pages = await info.json()
  const file = pages[0]?.file
  if (!file) throw new Error(`${contentRef} has no rendered page`)
  const url = basePath + file
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${contentRef} could not be read`)
  return { document: new DOMParser().parseFromString(await response.text(), 'text/html'), url }
}

export function useLocalLayer({
  documentKey,
  pageShapeIds,
  documentRoomId,
  editor,
  editorMounted,
}: {
  /** The chapter's document key, which is what relates it to an assignment. */
  documentKey: string
  /**
   * EVERY page shape of the document, not the one being read.
   *
   * This was `pageShapeId: document.pages[0]`, and that single binding was the
   * defect: the layer could only ever see the first page, so marking worked on
   * a project whose first page happened to be the solutions chapter and nowhere
   * else. On an 84-page course, page 0 is the index — no solution callouts, no
   * controls, and no amount of paging changed it, because nothing re-targeted.
   *
   * Skip, on being shown the one-page-project workaround: "DO NOT BUILD AROUND
   * DESIGN FLAWS: NOBODY FUCKING ASKED FOR GRADING TO ONLY WORK ON SPECIAL
   * GRADING PROJECTS." So the layer takes the whole document and attaches
   * wherever the solutions actually are.
   */
  pageShapeIds: readonly string[]
  /** The chapter's own room — the common layer, and the camera owner. */
  documentRoomId: string
  editor: Editor | null
  editorMounted: number
}) {
  const courseId = useMemo(() => new URLSearchParams(window.location.search).get('course') || '', [])
  const [assignmentId, setAssignmentId] = useState<string | null>(null)
  const [answers, setAnswers] = useState<Map<string, ProblemAnswer[]>>(new Map())
  const [positions, setPositions] = useState<Map<string, number>>(new Map())
  const [openPairs, setOpenPairs] = useState<OpenPair[]>([])
  // Which pair takes the pen. Many layers visible, one write target — the model
  // `bookLayers.ts` already states, applied to the pairs that happen to be open.
  const [writeTarget, setWriteTarget] = useState<string | null>(null)
  const [error, setError] = useState('')
  const answerDocuments = useRef<Map<string, AnswerDocument>>(new Map())

  // Is this chapter an assignment's solutions? Asked of the course, because the
  // instructor got here by reading the book and the address says nothing about
  // homework. A reader with no classroom credential gets 401 and no marking.
  useEffect(() => {
    if (!courseId || !documentKey) return
    let cancelled = false
    assignmentForSolutionsDoc(courseId, documentKey)
      .then(id => { if (!cancelled) setAssignmentId(id) })
      .catch(() => { if (!cancelled) setAssignmentId(null) })
    return () => { cancelled = true }
  }, [courseId, documentKey])

  useEffect(() => {
    if (!assignmentId) { setAnswers(new Map()); return }
    let cancelled = false
    classroomApi.problems(assignmentId)
      .then(view => { if (!cancelled) setAnswers(answersByExercise(view)) })
      .catch(e => { if (!cancelled) setError((e as Error).message) })
    return () => { cancelled = true }
  }, [assignmentId])

  /** The chapter's live document, or null while its iframe is still coming up. */
  /**
   * Every page document of this chapter that is mounted and ready.
   *
   * Aggregated from the DOM, with the registry as a supplement: one shape can
   * mount more than once — main canvas plus a HUD or pane — and
   * `htmlIframeElements` holds only the last writer, so trusting it alone puts
   * the controls in an arbitrary copy. That is not hypothetical; a feedback
   * badge once rendered into the editor's mount and was absent from the pane the
   * instructor was looking at, and every DOM count said PASS because a count
   * cannot see "in the wrong document".
   *
   * A frame that is still loading has a `documentElement` and a null `body`, and
   * handing that to the installer throws into the error boundary — hence the
   * `body` test rather than a `contentDocument` test. Frames that become ready
   * later are picked up by the caller's own interval, which re-runs this.
   */
  // Keyed on the joined ids rather than the array, so a caller that rebuilds
  // the list each render does not reinstall the controls on every render.
  const pageShapeKey = pageShapeIds.join(' ')
  const chapterDocuments = useCallback(
    (): Document[] => readyPageDocuments(
      pageShapeKey ? pageShapeKey.split(' ') : [],
      window.document,
      htmlIframeElements,
    ),
    [pageShapeKey],
  )

  const step = useCallback((exerciseId: string, next: number) => {
    const forExercise = answers.get(exerciseId) ?? []
    const position = stepPosition(next, forExercise.length)
    setPositions(current => new Map(current).set(exerciseId, position))
    setWriteTarget(position === NO_ANSWER ? null : exerciseId)
  }, [answers])

  // Keep a ref of the live step, so the observer below is installed once rather
  // than being torn down and rebuilt on every position change.
  const stepRef = useRef(step)
  stepRef.current = step

  // Hang the controls on every solution callout, and keep them there.
  //
  // Driven by a MutationObserver because the chapter's iframe re-renders under
  // us — the same reason `useMarkedExerciseHtmlAlignment` is. Both writes it
  // makes are guarded against being no-ops, so an unchanged pass mutates
  // nothing and the observer settles instead of rescheduling itself.
  useEffect(() => {
    if (!assignmentId || !editorMounted || answers.size === 0) return
    // Every document installed into, so every one is cleaned up. A single
    // `installed` reference was enough while the target could not change; once
    // the layer follows the reader, the page they left keeps its controls
    // forever unless each is remembered.
    const installed = new Set<Document>()
    const install = () => {
      for (const chapter of chapterDocuments()) {
        installed.add(chapter)
        // Self-limiting rather than page-aware: the installer walks
        // `.callout.callout-solution`, so a page with no solutions — the course
        // index, a prose chapter — takes no controls and needs no test here.
        installLocalLayerControls(chapter, answers, positions, (exerciseId, next) => stepRef.current(exerciseId, next))
      }
    }
    const observer = new MutationObserver(install)
    observer.observe(window.document.body, { childList: true, subtree: true })
    const interval = window.setInterval(install, 250)
    install()
    return () => {
      window.clearInterval(interval)
      observer.disconnect()
      for (const chapter of installed) {
        // A page unmounted while this ran leaves a document with no body; its
        // controls went with it.
        if (chapter.body) removeLocalLayerControls(chapter)
      }
    }
  }, [assignmentId, answers, positions, editorMounted, chapterDocuments])

  // Put each chosen answer beside its solution, and say which pairs are open.
  //
  // The answer document is fetched once per submission and kept, because paging
  // back to a student already seen must not go to the network again — that is
  // what makes flicking feel like flicking.
  useEffect(() => {
    let cancelled = false
    const apply = async () => {
      const documents = chapterDocuments()
      if (documents.length === 0) return
      // The page holding THIS exercise's solution, not "the page". Pairing
      // across every document would make each page that simply does not contain
      // the exercise report that the student did not answer it — a false claim
      // about their work, produced by the layer's own scope.
      const documentFor = (exerciseId: string) =>
        documents.find(candidate => candidate.querySelector(`[data-tlda-solution-for="${exerciseId}"]`)) ?? null
      const next: OpenPair[] = []
      for (const [exerciseId, position] of positions) {
        const chapter = documentFor(exerciseId)
        if (!chapter) continue
        const forExercise = answers.get(exerciseId) ?? []
        const answer = position === NO_ANSWER ? null : forExercise[position]
        if (!answer) {
          pairStudentAnswer(chapter, exerciseId, null, '', '')
          continue
        }
        let loaded = answerDocuments.current.get(answer.contentRef)
        if (!loaded) {
          try {
            loaded = await loadAnswerDocument(answer.contentRef)
            answerDocuments.current.set(answer.contentRef, loaded)
          } catch (e) {
            if (!cancelled) setError((e as Error).message)
            continue
          }
        }
        if (cancelled) return
        const placed = pairStudentAnswer(chapter, exerciseId, loaded.document, loaded.url, answer.displayName)
        // No `#ans-<exercise>` in their submission is a real answer to "did
        // they answer this one": say so on the control rather than silently
        // leaving the callout alone.
        if (!placed) {
          setError(`${answer.displayName} did not answer ${exerciseId}.`)
          continue
        }
        setError('')
        next.push({
          exerciseId,
          answer,
          roomId: gradingDraftRoomId(`doc-${answer.contentRef}`, `ans-${exerciseId}`),
        })
      }
      if (!cancelled) setOpenPairs(next)
    }
    void apply()
    return () => { cancelled = true }
  }, [positions, answers, chapterDocuments])

  // One layer per open pair: on-demand, keyed on the room, so stepping to the
  // next student swaps the store by replacing the canvas rather than by
  // repointing a live one at a different room.
  const overlays = (
    <>
      {openPairs.map(pair => (
        <StudentAnnotationOverlay
          key={pair.roomId}
          bookRoomId={documentRoomId}
          studentId={pair.answer.studentId}
          bookEditor={editor}
          visible
          isWriteTarget={writeTarget === pair.exerciseId}
          roomId={pair.roomId}
        />
      ))}
    </>
  )

  return { active: !!assignmentId, assignmentId, openPairs, overlays, error }
}
