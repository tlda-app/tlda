import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { react, useValue, type Editor } from 'tldraw'
import { gradingDraftRoomId } from '../../shared/classroom-rooms.mjs'
import { ensureViewLayer, getEditorWMCore, removeLayers } from '../wm/editor-wm'
import { classroomApi } from './api'
import { StudentAnnotationOverlay } from './StudentAnnotationOverlay'
import { markingInkFrame, markingInkLayerId, type MarkingInkFrame } from './markingInkFrame'

export interface ActiveMarkingPair {
  exerciseId: string
  studentId: string
  contentRef: string
  assignmentId: string
  viewerRole: 'instructor' | 'student'
  wrapper: HTMLElement
}

function measure(pair: ActiveMarkingPair, editor: Editor): MarkingInkFrame | null {
  if (!pair.wrapper.isConnected) return null
  const answer = pair.wrapper.querySelector<HTMLElement>('.tlda-marking-answer')
  const frame = pair.wrapper.ownerDocument.defaultView?.frameElement
  if (!answer || !(frame instanceof HTMLIFrameElement)) return null
  const container = editor.getContainer()
  return markingInkFrame({
    wrapper: pair.wrapper.getBoundingClientRect(),
    answer: answer.getBoundingClientRect(),
    iframe: frame.getBoundingClientRect(),
    container: container.getBoundingClientRect(),
    iframeClientWidth: frame.clientWidth,
    iframeOffsetWidth: frame.offsetWidth,
    iframeClientLeft: frame.clientLeft,
    iframeClientTop: frame.clientTop,
  })
}

export function MarkingInkOverlay({
  pair,
  editor,
  bookRoomId,
}: {
  pair: ActiveMarkingPair
  editor: Editor
  bookRoomId: string
}) {
  const [frame, setFrame] = useState<MarkingInkFrame | null>(() => measure(pair, editor))
  const layerId = useMemo(
    () => markingInkLayerId(pair.contentRef, pair.exerciseId),
    [pair.contentRef, pair.exerciseId],
  )
  const [draftEditor, setDraftEditor] = useState<Editor | null>(null)
  const [returning, setReturning] = useState(false)
  const pairKey = `${pair.exerciseId}:${pair.studentId}`
  const [returnStatus, setReturnStatus] = useState<{ pairKey: string; text: string; error: boolean } | null>(null)
  const draftShapeCount = useValue(
    'marking draft shape count',
    () => draftEditor?.getCurrentPageShapes().length ?? 0,
    [draftEditor],
  )

  useEffect(() => {
    let animation = 0
    const update = () => {
      animation = 0
      const next = measure(pair, editor)
      setFrame(current => JSON.stringify(current) === JSON.stringify(next) ? current : next)
    }
    const schedule = () => {
      if (!animation) animation = window.requestAnimationFrame(update)
    }
    const answer = pair.wrapper.querySelector<HTMLElement>('.tlda-marking-answer')
    const iframe = pair.wrapper.ownerDocument.defaultView?.frameElement
    const resize = new ResizeObserver(schedule)
    resize.observe(pair.wrapper)
    if (answer) resize.observe(answer)
    if (iframe instanceof HTMLElement) resize.observe(iframe)
    resize.observe(editor.getContainer())
    const mutations = new MutationObserver(schedule)
    mutations.observe(pair.wrapper, { subtree: true, childList: true, attributes: true })
    const stopCamera = react('place marking ink over pair', () => {
      editor.getCamera()
      schedule()
    })
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    schedule()
    return () => {
      stopCamera()
      resize.disconnect()
      mutations.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      if (animation) window.cancelAnimationFrame(animation)
    }
  }, [editor, pair])

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
      await classroomApi.returnFeedback(pair.assignmentId, pair.studentId)
      setReturnStatus({ pairKey, text: `Returned ${draftShapeCount}`, error: false })
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
        roomId={gradingDraftRoomId(`doc-${pair.contentRef}`, `ans-${pair.exerciseId}`)}
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
