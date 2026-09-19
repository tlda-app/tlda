import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useValue, type Editor } from 'tldraw'
import { gradingDraftRoomId } from '../../shared/classroom-rooms.mjs'
import { ensureViewLayer, getEditorWMCore, removeLayers } from '../wm/editor-wm'
import { classroomApi } from './api'
import { StudentAnnotationOverlay } from './StudentAnnotationOverlay'
import { markingInkLayerId } from './markingInkFrame'
import { useInkFrame } from './useInkFrame'

export interface ActiveMarkingPair {
  exerciseId: string
  studentId: string
  contentRef: string
  assignmentId: string
  viewerRole: 'instructor' | 'student'
  wrapper: HTMLElement
}

// The selector for the answer inside the pair. `useInkFrame` takes it as an
// argument because it was extracted from this component to be shared; this is
// now its only caller, and the copy that lived here has gone rather than being
// left to drift against it.
const ANSWER_SELECTOR = '.tlda-marking-answer'

export function MarkingInkOverlay({
  pair,
  editor,
  bookRoomId,
}: {
  pair: ActiveMarkingPair
  editor: Editor
  bookRoomId: string
}) {
  const frame = useInkFrame(pair.wrapper, ANSWER_SELECTOR, editor)
  const layerId = useMemo(
    () => markingInkLayerId(pair.contentRef, pair.exerciseId),
    [pair.contentRef, pair.exerciseId],
  )
  const [draftEditor, setDraftEditor] = useState<Editor | null>(null)
  const [returning, setReturning] = useState(false)
  // Which problem's marks these are. Named ONCE, because it is both the stem of
  // the draft room this overlay writes into and the problem `/return` copies
  // across, and those two being written out separately is what broke returning:
  // Return passed no problem at all, so the route's copy was skipped, the
  // submission was still marked returned, and the button still reported a count
  // — of the local draft it was reading, never of anything the student received.
  const problemId = `ans-${pair.exerciseId}`
  const pairKey = `${pair.exerciseId}:${pair.studentId}`
  const [returnStatus, setReturnStatus] = useState<{ pairKey: string; text: string; error: boolean } | null>(null)
  const draftShapeCount = useValue(
    'marking draft shape count',
    () => draftEditor?.getCurrentPageShapes().length ?? 0,
    [draftEditor],
  )

  useEffect(() => {
    if (!frame) return
    const wm = getEditorWMCore(editor)
    ensureViewLayer(wm, layerId, {
      parent: wm.rootLayerId,
      transform: frame.wrapperTransform,
    })
    return () => removeLayers(wm, [layerId])
  }, [editor, frame, layerId])

  if (!frame) return null
  const answerHeader = pair.wrapper.querySelector<HTMLElement>('.tlda-marking-answer-header')
  const returnMarks = async () => {
    if (returning || pair.viewerRole !== 'instructor') return
    try {
      setReturning(true)
      setReturnStatus(null)
      const { returnedMarks } = await classroomApi.returnMarkedProblem(pair.assignmentId, pair.studentId, problemId)
      // The server's count of what it copied, not the local draft's. This button
      // only exists while the draft holds shapes, so nothing copied means the
      // copy failed — and that has to read as a failure here rather than as a
      // green count, which is what it did while delivering nothing.
      setReturnStatus(returnedMarks
        ? { pairKey, text: `Returned ${returnedMarks}`, error: false }
        : { pairKey, text: 'Returned nothing — the student received no marks', error: true })
    } catch (error) {
      setReturnStatus({ pairKey, text: (error as Error).message, error: true })
    } finally {
      setReturning(false)
    }
  }

  return (
    <>
      <StudentAnnotationOverlay
        bookRoomId={bookRoomId}
        studentId={pair.studentId}
        bookEditor={editor}
        visible
        isWriteTarget={pair.viewerRole === 'instructor'}
        roomId={gradingDraftRoomId(`doc-${pair.contentRef}`, problemId)}
        camera={frame.camera}
        bounds={frame.bounds}
        onEditorMount={setDraftEditor}
        onEditorRelease={released => setDraftEditor(current => current === released ? null : current)}
      />
      {pair.viewerRole === 'instructor' && answerHeader && createPortal(
        <span className="tlda-marking-return">
          {draftShapeCount > 0 && (
            <button type="button" disabled={returning} onClick={() => void returnMarks()}>
              {returning ? 'Returning…' : 'Return'}
            </button>
          )}
          {returnStatus?.pairKey === pairKey && (
            <span className={`tlda-marking-return-status${returnStatus.error ? ' tlda-marking-return-error' : ''}`}>
              {returnStatus.text}
            </span>
          )}
        </span>,
        answerHeader,
      )}
    </>
  )
}
