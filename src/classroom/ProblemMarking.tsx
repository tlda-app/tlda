import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SvgDocumentEditor } from '../SvgDocument'
import { createHtmlDocumentFromPageInfo } from '../svgDocumentLoader'
import type { SvgDocument } from '../loaders/types'
import type { Editor } from 'tldraw'
import { classroomApi, type ProblemsView } from './api'
import { FRAME_PAIR_EVENT } from './marking'
import { layerStore, moveShapesToLayer, sameFrame } from './moveBetweenLayers'
import { releaseHeldEnd, resolveReturnEnds } from './returnEnds'
import './ClassroomWorkspace.css'

// The assignment as Skip marks it: "that would just be the homework assignment
// and for each problem flick through the student solutions."
//
// So the problem is what stays put and the student is what moves. Flicking
// swaps the pane beside his solution rather than opening a page per student,
// which is the thing he asked not to have to do.

async function firstPage(docKey: string) {
  const basePath = `/docs/${encodeURIComponent(docKey)}/`
  const response = await fetch(`${basePath}page-info.json`)
  if (!response.ok) throw new Error(`${docKey} has not finished rendering`)
  const pages = await response.json()
  if (!pages[0]) throw new Error(`${docKey} has no rendered page`)
  return { basePath, page: pages[0] }
}

export function ProblemMarking() {
  const params = new URLSearchParams(window.location.search)
  const assignmentId = params.get('assignment') || ''
  const [view, setView] = useState<ProblemsView | null>(null)
  const [problemIndex, setProblemIndex] = useState(0)
  const [studentIndex, setStudentIndex] = useState(0)
  const [document, setDocument] = useState<SvgDocument | null>(null)
  const [error, setError] = useState('')
  const [returned, setReturned] = useState('')
  const [returning, setReturning] = useState(false)
  // The two ends of the return: the private marking layer, and the submission
  // room the student reads.
  //
  // Refs, not state, and each carries the room its editor was mounted for.
  //
  // Measured: pressing Return re-renders, the overlay is replaced, and a handler
  // that captured the editor at render time then deletes from a DISPOSED editor
  // — silently, while the live layer keeps the marks. It reported success,
  // because the dead editor's last store state still listed them. Reading the
  // ref after the await is what makes the move act on the editor that exists
  // now. (Why the remount happens is not established, and this does not depend
  // on knowing: any replacement, from any cause, is handled the same way.)
  //
  // The room travels with each editor because "still mounted" is not the
  // question — "still THIS student's" is. Flicking students during the request
  // would otherwise record Ada's return and publish onto Bo's work.
  const submissionEditorRef = useRef<{ editor: Editor; roomId: string } | null>(null)
  const draftEditorRef = useRef<{ editor: Editor; roomId: string } | null>(null)


  useEffect(() => { setReturned('') }, [problemIndex, studentIndex])

  useEffect(() => {
    classroomApi.problems(assignmentId).then(setView).catch(e => setError(e.message))
  }, [assignmentId])

  const problem = view?.problems[problemIndex]
  const answer = problem?.answers[studentIndex]

  // Pair his solution with this student's answer. Same shape the compare view
  // already builds, so the two panes line up the way they do everywhere else.
  //
  // Keyed on the two document keys, NOT on the `view` and `answer` objects.
  //
  // Measured 2026-09-10, in the browser, on the Return that would not converge:
  // `returnCurrent` replaces `view` to record the new grading status, which
  // makes a new `answer`, which re-ran this effect, which built a NEW document
  // object 543 ms after the marks were deleted from the draft layer. A new
  // document recomputes `SvgDocument`'s `components` memo, whose
  // `InFrontOfTheCanvas` is an inline arrow — a new component TYPE — so React
  // unmounted that whole subtree rather than reconciling it. The draft layer
  // went with it, and `TLSyncClient.close()` cancels unsent changes rather than
  // flushing them, so the deletion died with the editor that made it and the
  // replacement layer read the marks back out of the room.
  //
  // The document is a function of these two strings and nothing else. Neither
  // changes when a return is recorded, so recording one no longer rebuilds the
  // document — and choosing a different problem does not either, which is what
  // the key on `SvgDocumentEditor` below already says the intent was.
  const solutionsDocKey = view?.assignment.solutionsDocKey ?? null
  const contentRef = answer?.contentRef ?? null
  useEffect(() => {
    if (!contentRef) { setDocument(null); return }
    let cancelled = false
    Promise.all([
      firstPage(contentRef),
      solutionsDocKey ? firstPage(solutionsDocKey) : Promise.resolve(null),
    ]).then(([student, solution]) => {
      if (cancelled) return
      const pages = [{ ...student.page, group: 'marked-exercise', url: student.basePath + student.page.file }]
      if (solution) pages.push({ ...solution.page, group: 'marked-exercise', url: solution.basePath + solution.page.file })
      setDocument(createHtmlDocumentFromPageInfo(contentRef, student.basePath, pages))
      setError('')
    }).catch(e => { if (!cancelled) { setError(e.message); setDocument(null) } })
    return () => { cancelled = true }
  }, [contentRef, solutionsDocKey])

  // Choosing a problem has to move the panes to it, or "problem by problem" is
  // only true of the student list: the document still opens at the top and he
  // hunts for question 4 himself, twice, on every student.
  //
  // The anchor is the same `#ans-<exercise-id>` in both documents — his copy and
  // theirs came from one handout — so navigating the submission brings the
  // matching solution level with it.
  useEffect(() => {
    if (!document || !problem || !answer?.anchor) return
    const shapeId = document.pages[0]?.shapeId
    if (!shapeId) return
    // After the editor has mounted the page; the same message the table of
    // contents and cross-member links already use.
    // The anchor is the EXERCISE id, not the answer id. Quarto anchors headings
    // by `data-anchor-id`, and `## Problem 1 {#exr-hearts}` gives `exr-hearts`,
    // while the answer block inside it is `#ans-exr-hearts`. Navigation looks up
    // heading positions, so posting the answer id matches nothing and moves
    // nothing — silently, because a navigation that finds no target just
    // returns. The handout names answers after their exercise, so dropping the
    // prefix is the derivation, not a guess.
    const headingAnchor = problem.problemId.replace(/^ans-/, '')
    const timer = setTimeout(() => {
      window.postMessage({ type: 'tlda-navigate', anchor: headingAnchor, shapeId }, '*')
      // Navigation centres the one shape it was given, which pushes his
      // solution off the right edge. Frame the pair once it has landed.
      setTimeout(() => window.dispatchEvent(new CustomEvent(FRAME_PAIR_EVENT)), 400)
    }, 200)
    return () => clearTimeout(timer)
  }, [document, problem, answer])

  // The URL follows what you're looking at, so a reload lands you back here and
  // the link is shareable — but flicking never navigates.
  useEffect(() => {
    if (!problem || !answer) return
    const next = new URLSearchParams(window.location.search)
    next.set('problem', problem.problemId)
    next.set('student', answer.studentId)
    window.history.replaceState({}, '', `?${next}`)
  }, [problem, answer])

  const step = useCallback((delta: number) => {
    if (!problem) return
    setStudentIndex(current => {
      const count = problem.answers.length
      return ((current + delta) % count + count) % count
    })
  }, [problem])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight') step(1)
      else if (event.key === 'ArrowLeft') step(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step])

  const problemOptions = useMemo(() => view?.problems.map(p => p.problemId) ?? [], [view])

  const returnCurrent = async () => {
    if (!answer || returning) return
    let serverRecorded = false
    // The room this return is FOR, snapshotted before anything can move. Every
    // check below compares against this rather than against whatever the screen
    // shows by the time the server answers.
    const intendedRoomId = `doc-${answer.contentRef}`
    try {
      setError('')
      setReturning(true)
      const submission = await classroomApi.returnFeedback(assignmentId, answer.studentId)
      // Which half got as far as durable state, so the failure message can say
      // so truthfully rather than reporting "the return is recorded" when the
      // server call is the thing that threw.
      serverRecorded = true
      setView(current => current ? {
        ...current,
        problems: current.problems.map(candidate => ({
          ...candidate,
          answers: candidate.answers.map(candidateAnswer => candidateAnswer.studentId === answer.studentId
            ? { ...candidateAnswer, gradingStatus: submission.gradingStatus }
            : candidateAnswer),
        })),
      } : current)
      // Publish the marks only after the server has recorded the return.
      //
      // The two halves cannot commit together: the record is a row in the
      // classroom store, the marks are shapes in a sync room, and there is no
      // transaction across them. The orderings are not symmetric, so this is a
      // choice rather than an accident — server first FAILS CLOSED. If the move
      // then fails, the record says returned and the marks are still private:
      // a label ahead of itself, and nothing the student should not see. Moving
      // first inverts exactly that, publishing the marks with no durable record
      // that they were published, which is the thing being controlled.
      //
      // So the incomplete state is recoverable rather than reconciled: `Return`
      // stays actionable at any status, the draft room still holds the marks,
      // and pressing it again finishes the move. `moveShapesToLayer` is
      // create -> verify -> delete, so a destination that did not take them
      // throws having deleted nothing; and once they have landed the draft is
      // empty, so a retry moves nothing rather than duplicating.
      //
      // Every shape in the draft room is a mark, because this room is only ever
      // mounted by the annotation overlay, which never renders the document.
      // That is a property of how the room is constructed here, not of draft
      // rooms in general — mount a document into one and this stops holding.
      // Both ends, read now rather than captured earlier, and both required to
      // still belong to the room this return was started for. The destination
      // can be replaced just as the draft layer can, so checking only one end
      // would leave the other stale.
      const ends = resolveReturnEnds({
        draft: draftEditorRef.current,
        destination: submissionEditorRef.current,
        intendedRoomId,
      })
      if (!ends) {
        // Fail closed. The server half is recorded; the marks stay private and
        // unpublished, which is recoverable by pressing Return again on the
        // right student. Publishing here would put these marks on whoever is
        // on screen now.
        throw new Error('The marking layer changed while the return was in flight, so nothing was published.')
      }
      const draftEditor = ends.draft
      const submissionEditor = ends.destination
      const ids = draftEditor.getCurrentPageShapes().map(shape => shape.id)
      // `sameFrame`, and stated rather than defaulted to, because the module
      // makes it a required argument precisely so nobody assumes the identity
      // silently: the draft layer is composited over the submission pane and
      // follows that pane's camera, so a page point means the same thing in
      // both. If the draft layer ever stops being pinned to the pane, this is
      // the line that has to change, and `layerFrameConversion` is what it
      // becomes.
      const moved = moveShapesToLayer(layerStore(draftEditor), layerStore(submissionEditor), ids, sameFrame)
      setReturned(moved.length ? `returned ${moved.length}` : 'nothing to return')
    } catch (e) {
      // Say which half happened. Once the server has recorded it the student can
      // already see any written feedback, so "return failed" would be false: it
      // is the marks that did not go, and the next action is to press Return
      // again rather than to redo the marking. Before that point, nothing
      // landed and the plain message is the true one.
      //
      // The suffix asserts only the half it knows. It used to add "but the
      // marks are not published yet", which is false for the failure the
      // confirm step now raises — there the copies DID reach the student and it
      // is the private layer that was not cleared. Each thrown message already
      // states what happened to the marks, so the suffix stops repeating it.
      setError(serverRecorded
        ? `${(e as Error).message} — the return is recorded. Press Return marks again.`
        : (e as Error).message)
    } finally {
      setReturning(false)
    }
  }

  if (error && !view) return <main className="classroomWorkspace"><p className="classroomError">{error}</p></main>
  if (!view) return <main className="classroomWorkspace">Loading {assignmentId}…</main>
  if (!problem) return <main className="classroomWorkspace"><p>No submissions yet for {view.assignment.title}.</p></main>

  return <>
    {document
      // Keyed by the document alone. Including the problem in the key made
      // choosing one tear the editor down and build a new one, which lands at
      // its default camera — so the navigation fired into an editor that was
      // being destroyed and the replacement opened at the top. Changing student
      // is a different document and should remount; changing problem is a move
      // within the same one.
      ? <SvgDocumentEditor
          key={answer?.contentRef}
          document={document}
          roomId={`doc-${answer?.contentRef}`}
          // Bound to the room it was mounted for, in this render's closure —
          // which is the room that editor actually syncs, whatever the screen
          // has moved on to since.
          onEditorMount={editor => {
            // Only register; never clear here. `onEditorMount(null)` fires on
            // teardown without saying WHICH editor went, and a remount runs the
            // old teardown after the replacement registered — so clearing on it
            // erases the live destination. The room guard cannot catch that,
            // because the old and new editors are in the same room.
            if (editor) submissionEditorRef.current = { editor, roomId: `doc-${answer?.contentRef}` }
          }}
          // Clear only if it is still the one we hold. Same rule the draft layer
          // already uses, for the same measured ordering.
          onEditorRelease={editor => {
            submissionEditorRef.current = releaseHeldEnd(submissionEditorRef.current, editor)
          }}
          classroomMarking
          classroomGrading={{
            assignmentId,
            problemId: problem.problemId,
            studentId: answer!.studentId,
            submissionRoomId: `doc-${answer?.contentRef}`,
            onDraftEditor: (editor, roomId) => {
              draftEditorRef.current = editor ? { editor, roomId } : null
            },
          }}
        />
      : <main className="classroomWorkspace"><p className={error ? 'classroomError' : undefined}>{error || `${answer?.displayName} did not answer this one.`}</p></main>}
    <aside className="markingLifecycle" aria-label="Marking">
      <select value={problem.problemId} onChange={e => { setProblemIndex(problemOptions.indexOf(e.target.value)); setStudentIndex(0) }}>
        {problemOptions.map(id => <option key={id} value={id}>{id.replace(/^ans-/, '')}</option>)}
      </select>
      <button onClick={() => step(-1)} aria-label="Previous student">←</button>
      <span>{answer?.displayName} · {studentIndex + 1} of {problem.answers.length}</span>
      <button onClick={() => step(1)} aria-label="Next student">→</button>
      {answer && <span className="statusChip">{answer.gradingStatus}</span>}
      <button onClick={() => void returnCurrent()} disabled={!answer || returning}>{returning ? 'Returning…' : 'Return marks'}</button>
      {returned && <span>{returned}</span>}
      {error && <span className="classroomError">{error}</span>}
    </aside>
  </>
}
